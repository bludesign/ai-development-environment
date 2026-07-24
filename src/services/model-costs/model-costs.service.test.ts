import { beforeEach, describe, expect, test, vi } from "vitest";

type SettingsRow = {
  id: string;
  catalogUrl: string | null;
  fetchedAt: Date | null;
  sourceUrl: string | null;
  entryCount: number;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type EntryRow = {
  model: string;
  provider: string | null;
  mode: string | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  cacheReadCostPerToken: number | null;
  cacheWriteCostPerToken: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  updatedAt: Date;
};

const state = vi.hoisted(() => ({
  settings: null as SettingsRow | null,
  entries: [] as EntryRow[],
}));

/**
 * A stand-in for the two tables this service owns, matching only the query
 * shapes it actually issues — `in`, `endsWith`, and `contains` filters.
 */
vi.mock("@/data/prisma-client", () => {
  const matches = (row: EntryRow, where: Record<string, unknown>): boolean => {
    if (!where || !Object.keys(where).length) return true;
    if (Array.isArray(where.OR)) {
      return (where.OR as Record<string, unknown>[]).some((clause) =>
        matches(row, clause),
      );
    }
    return Object.entries(where).every(([field, condition]) => {
      const value = row[field as keyof EntryRow];
      if (condition === null || typeof condition !== "object") {
        return value === condition;
      }
      const test = condition as Record<string, unknown>;
      if (Array.isArray(test.in)) return test.in.includes(value);
      if (typeof test.endsWith === "string") {
        return typeof value === "string" && value.endsWith(test.endsWith);
      }
      if (typeof test.contains === "string") {
        return (
          typeof value === "string" &&
          value.toLowerCase().includes(test.contains.toLowerCase())
        );
      }
      return false;
    });
  };
  /**
   * Honours both `orderBy` shapes the service emits — a bare direction, and the
   * `{ sort, nulls }` form — so the ordering assertions test the service's own
   * choices rather than the mock's.
   */
  const compare = (
    left: EntryRow,
    right: EntryRow,
    orderBy: Record<string, unknown>[],
  ): number => {
    for (const clause of orderBy) {
      const [field, spec] = Object.entries(clause)[0]!;
      const direction =
        typeof spec === "string"
          ? spec
          : ((spec as Record<string, unknown>).sort as string);
      const nulls =
        typeof spec === "string"
          ? "first"
          : ((spec as Record<string, unknown>).nulls as string) || "first";
      const a = left[field as keyof EntryRow];
      const b = right[field as keyof EntryRow];
      if (a === b) continue;
      if (a === null || b === null) {
        const nullLast = nulls === "last" ? 1 : -1;
        return a === null ? nullLast : -nullLast;
      }
      const order =
        typeof a === "string" && typeof b === "string"
          ? a.localeCompare(b)
          : Number(a) - Number(b);
      if (order !== 0) return direction === "desc" ? -order : order;
    }
    return 0;
  };
  const client = {
    modelCostSettings: {
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const now = new Date();
        state.settings = state.settings
          ? { ...state.settings, ...update, updatedAt: now }
          : {
              id: "default",
              catalogUrl: null,
              fetchedAt: null,
              sourceUrl: null,
              entryCount: 0,
              error: null,
              createdAt: now,
              updatedAt: now,
              ...create,
            };
        return state.settings;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        state.settings = { ...state.settings!, ...data, updatedAt: new Date() };
        return state.settings;
      },
    },
    modelCostEntry: {
      deleteMany: async () => {
        state.entries = [];
        return { count: 0 };
      },
      createMany: async ({ data }: { data: Omit<EntryRow, "updatedAt">[] }) => {
        state.entries.push(
          ...data.map((entry) => ({ ...entry, updatedAt: new Date() })),
        );
        return { count: data.length };
      },
      findMany: async ({
        where = {},
        orderBy = [{ model: "asc" }],
        skip = 0,
        take = 100,
      }: {
        where?: Record<string, unknown>;
        orderBy?: Record<string, unknown>[];
        skip?: number;
        take?: number;
      } = {}) =>
        state.entries
          .filter((row) => matches(row, where))
          .sort((left, right) => compare(left, right, orderBy))
          .slice(skip, skip + take),
      count: async ({ where = {} }: { where?: Record<string, unknown> } = {}) =>
        state.entries.filter((row) => matches(row, where)).length,
    },
    $transaction: async (run: (client: unknown) => Promise<unknown>) =>
      run(client),
  };
  return { getPrismaClient: async () => client };
});

const { DEFAULT_MODEL_COST_URL, ModelCostsService } =
  await import("./model-costs.service");

const catalogPayload = {
  sample_spec: { input_cost_per_token: 1 },
  "no-prices": { litellm_provider: "anthropic" },
  "claude-sonnet-4-5": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
    max_input_tokens: 200000,
    max_output_tokens: 64000,
  },
  "openrouter/moonshot/kimi-k2": {
    litellm_provider: "openrouter",
    input_cost_per_token: 0.0000005,
    output_cost_per_token: 0.0000025,
  },
  /** Output-only pricing, so its input column is the null the ordering has to place. */
  "embed-only": {
    litellm_provider: "voyage",
    output_cost_per_token: 0.00000002,
  },
};

function mockFetch(payload: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 503,
      json: async () => payload,
    })),
  );
}

describe("ModelCostsService", () => {
  beforeEach(() => {
    state.settings = null;
    state.entries = [];
    vi.unstubAllGlobals();
  });

  test("defaults to the LiteLLM catalog and reports itself stale before a fetch", async () => {
    const catalog = await new ModelCostsService().getCatalog();
    expect(catalog.url).toBe(DEFAULT_MODEL_COST_URL);
    expect(catalog.customUrl).toBeNull();
    expect(catalog.stale).toBe(true);
    expect(catalog.fetchedAt).toBeNull();
  });

  test("stores a custom URL but treats the default and blanks as no override", async () => {
    const service = new ModelCostsService();
    expect(
      (await service.saveSettings("https://example.test/p.json")).customUrl,
    ).toBe("https://example.test/p.json");
    expect((await service.saveSettings("  ")).customUrl).toBeNull();
    expect(
      (await service.saveSettings(DEFAULT_MODEL_COST_URL)).customUrl,
    ).toBeNull();
  });

  test("refreshes immediately when the active catalog URL changes", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    expect((await service.refresh()).stale).toBe(false);
    await service.listEntries({});

    const catalog = await service.saveSettings(
      "https://example.test/prices.json",
    );
    expect(catalog.url).toBe("https://example.test/prices.json");
    expect(catalog.stale).toBe(true);

    mockFetch({
      "new-source-model": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    });
    const page = await service.listEntries({});

    expect(page.items.map(({ model }) => model)).toEqual(["new-source-model"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/prices.json",
      expect.any(Object),
    );
  });

  test("rejects a URL that is not http or https", async () => {
    const service = new ModelCostsService();
    await expect(service.saveSettings("not a url")).rejects.toThrow(
      "must be a valid URL",
    );
    await expect(service.saveSettings("ftp://example.test/p")).rejects.toThrow(
      "http or https",
    );
  });

  test("keeps only priced models and drops the documentation stub", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    const catalog = await service.refresh();
    expect(catalog.error).toBeNull();
    expect(catalog.entryCount).toBe(3);
    expect(catalog.stale).toBe(false);
    const { items } = await service.listEntries({});
    expect(items.map(({ model }) => model)).toEqual([
      "claude-sonnet-4-5",
      "embed-only",
      "openrouter/moonshot/kimi-k2",
    ]);
  });

  test("makes concurrent readers await an in-flight catalog refresh", async () => {
    let finishFetch!: (response: {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }) => void;
    const fetchStarted = new Promise<void>((resolve) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise((finish) => {
              finishFetch = finish;
              resolve();
            }),
        ),
      );
    });
    const service = new ModelCostsService();
    const refresh = service.ensureFresh();
    await fetchStarted;

    let readerFinished = false;
    const reader = service.listEntries({}).then((page) => {
      readerFinished = true;
      return page;
    });
    await Promise.resolve();
    expect(readerFinished).toBe(false);

    finishFetch({
      ok: true,
      status: 200,
      json: async () => catalogPayload,
    });
    await expect(reader).resolves.toMatchObject({ totalCount: 3 });
    await refresh;
  });

  test("records a failed fetch without discarding the prices it already had", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    mockFetch(null, false);
    const catalog = await service.refresh();
    expect(catalog.error).toContain("503");
    expect(state.entries).toHaveLength(3);
  });

  test("matches a run's model name by suffix when the catalog key is prefixed", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    const prices = await service.lookup([
      "claude-sonnet-4-5",
      "anthropic/claude-sonnet-4-5",
      "kimi-k2",
      "not-a-model",
    ]);
    expect(prices.get("claude-sonnet-4-5")?.model).toBe("claude-sonnet-4-5");
    expect(prices.get("anthropic/claude-sonnet-4-5")?.model).toBe(
      "claude-sonnet-4-5",
    );
    expect(prices.get("kimi-k2")?.model).toBe("openrouter/moonshot/kimi-k2");
    expect(prices.has("not-a-model")).toBe(false);
  });

  test("prices each token class at its own published rate", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    const entry = (await service.lookup(["claude-sonnet-4-5"])).get(
      "claude-sonnet-4-5",
    );
    expect(
      service.estimate(entry, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
  });

  test("charges cache tokens at the input rate when the catalog omits one", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    const entry = (await service.lookup(["kimi-k2"])).get("kimi-k2");
    expect(
      service.estimate(entry, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(0.5, 6);
  });

  test("returns no estimate for a model the catalog does not carry", () => {
    expect(
      new ModelCostsService().estimate(undefined, {
        inputTokens: 100,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });

  test("searches models and providers", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    expect((await service.listEntries({ search: "sonnet" })).totalCount).toBe(
      1,
    );
    expect(
      (await service.listEntries({ search: "openrouter" })).totalCount,
    ).toBe(1);
    expect((await service.listEntries({ search: "nothing" })).totalCount).toBe(
      0,
    );
  });

  test("sorts by a chosen column in both directions", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    const models = async (
      sortKey: Parameters<typeof service.listEntries>[0]["sortKey"],
      direction: Parameters<typeof service.listEntries>[0]["direction"],
    ) =>
      (await service.listEntries({ sortKey, direction })).items.map(
        ({ model }) => model,
      );
    expect(await models("OUTPUT_COST", "ASC")).toEqual([
      "embed-only",
      "openrouter/moonshot/kimi-k2",
      "claude-sonnet-4-5",
    ]);
    expect(await models("OUTPUT_COST", "DESC")).toEqual([
      "claude-sonnet-4-5",
      "openrouter/moonshot/kimi-k2",
      "embed-only",
    ]);
    expect(await models("MODEL", "DESC")).toEqual([
      "openrouter/moonshot/kimi-k2",
      "embed-only",
      "claude-sonnet-4-5",
    ]);
  });

  test("sinks unpriced models to the bottom whichever way the column is sorted", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    for (const direction of ["ASC", "DESC"] as const) {
      const { items } = await service.listEntries({
        sortKey: "INPUT_COST",
        direction,
      });
      expect(items.at(-1)?.model).toBe("embed-only");
    }
  });

  test("pages a sorted list without repeating or skipping a row", async () => {
    mockFetch(catalogPayload);
    const service = new ModelCostsService();
    await service.refresh();
    const first = await service.listEntries({
      sortKey: "INPUT_COST",
      direction: "DESC",
      first: 2,
    });
    const second = await service.listEntries({
      sortKey: "INPUT_COST",
      direction: "DESC",
      first: 2,
      offset: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(first.totalCount).toBe(3);
    expect([...first.items, ...second.items].map(({ model }) => model)).toEqual(
      ["claude-sonnet-4-5", "openrouter/moonshot/kimi-k2", "embed-only"],
    );
  });
});
