import { beforeEach, describe, expect, test, vi } from "vitest";

type CacheEntry = {
  id: string;
  cacheKey: string;
  authentication: string;
  endpoint: string;
  operation: string;
  query: string;
  variablesJson: string;
  responseJson: string;
  fetchedAt: Date;
  pointCost: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type CallLog = {
  id: string;
  authentication: string;
  apiType: string;
  method: string;
  endpoint: string;
  operation: string;
  requestSource: string;
  requestSummary: string;
  variablesJson: string;
  source: string;
  durationMs: number;
  statusCode: number | null;
  error: string | null;
  servedStale: boolean;
  pointCost: number | null;
  pointsAvoided: number;
  rateLimitLimit: number | null;
  rateLimitRemaining: number | null;
  rateLimitUsed: number | null;
  rateLimitResetAt: Date | null;
  rateLimitResource: string | null;
  createdAt: Date;
};

type RateSnapshot = {
  authentication: string;
  resource: string;
  limit: number;
  remaining: number;
  used: number;
  resetAt: Date;
};

const state = vi.hoisted(() => ({
  ttlSeconds: 300,
  entries: [] as CacheEntry[],
  calls: [] as CallLog[],
  snapshots: [] as RateSnapshot[],
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    gitHubSettings: {
      upsert: async ({
        create,
        update,
      }: {
        create: { cacheTtlSeconds?: number };
        update: { cacheTtlSeconds?: number };
      }) => {
        state.ttlSeconds = update.cacheTtlSeconds ?? state.ttlSeconds;
        if (!state.ttlSeconds) state.ttlSeconds = create.cacheTtlSeconds ?? 300;
        return {
          id: "default",
          cacheTtlSeconds: state.ttlSeconds,
          defaultJiraKeyRegex: "",
          actionsNotificationPollIntervalSeconds: 60,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      },
    },
    gitHubGraphqlCacheEntry: {
      findUnique: async ({
        where,
      }: {
        where: { cacheKey?: string; id?: string };
      }) =>
        state.entries.find((entry) =>
          where.cacheKey
            ? entry.cacheKey === where.cacheKey
            : entry.id === where.id,
        ) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { cacheKey: string };
        create: CacheEntry;
        update: Partial<CacheEntry>;
      }) => {
        const existing = state.entries.find(
          (entry) => entry.cacheKey === where.cacheKey,
        );
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const entry = {
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.entries.push(entry);
        return entry;
      },
      deleteMany: async ({ where }: { where?: { id?: string } } = {}) => {
        const before = state.entries.length;
        state.entries = where?.id
          ? state.entries.filter((entry) => entry.id !== where.id)
          : [];
        return { count: before - state.entries.length };
      },
      findMany: async ({ take, skip }: { take: number; skip: number }) =>
        [...state.entries]
          .sort(
            (left, right) =>
              right.fetchedAt.getTime() - left.fetchedAt.getTime(),
          )
          .slice(skip, skip + take),
      count: async () => state.entries.length,
    },
    gitHubRateLimitSnapshot: {
      findUnique: async ({
        where,
      }: {
        where: {
          authentication_resource: { authentication: string; resource: string };
        };
      }) =>
        state.snapshots.find(
          (snapshot) =>
            snapshot.authentication ===
              where.authentication_resource.authentication &&
            snapshot.resource === where.authentication_resource.resource,
        ) ?? null,
    },
    gitHubApiCallLog: {
      create: async ({ data }: { data: Omit<CallLog, "createdAt"> }) => {
        const call = { ...data, createdAt: new Date() };
        state.calls.push(call);
        return call;
      },
      findMany: async ({
        where,
        take,
        skip,
      }: {
        where?: {
          createdAt?: { gte?: Date };
          apiType?: string;
          requestSource?: string;
          source?: string;
        };
        take?: number;
        skip?: number;
      }) => {
        let calls = [...state.calls];
        const gte = where?.createdAt?.gte;
        if (gte) calls = calls.filter((call) => call.createdAt >= gte);
        if (where?.apiType) {
          calls = calls.filter((call) => call.apiType === where.apiType);
        }
        if (where?.requestSource) {
          calls = calls.filter(
            (call) => call.requestSource === where.requestSource,
          );
        }
        if (where?.source) {
          calls = calls.filter((call) => call.source === where.source);
        }
        calls.sort(
          (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
        );
        return take === undefined
          ? calls
          : calls.slice(skip ?? 0, (skip ?? 0) + take);
      },
      count: async ({
        where,
      }: {
        where?: {
          apiType?: string;
          requestSource?: string;
          source?: string;
        };
      } = {}) =>
        state.calls.filter(
          (call) =>
            (!where?.apiType || call.apiType === where.apiType) &&
            (!where?.requestSource ||
              call.requestSource === where.requestSource) &&
            (!where?.source || call.source === where.source),
        ).length,
      deleteMany: async ({
        where,
      }: { where?: { createdAt: { lt: Date } } } = {}) => {
        const before = state.calls.length;
        state.calls = where
          ? state.calls.filter((call) => call.createdAt >= where.createdAt.lt)
          : [];
        return { count: before - state.calls.length };
      },
    },
  }),
}));

import { GitHubCache } from "./github-cache";

function input(
  authentication: "PAT" | "APP",
  fetcher: () => Promise<{
    data: { value: number };
    statusCode: number;
    pointCost: number;
    rateLimit: null;
  }>,
) {
  return {
    authentication,
    requestSource: "PULL_REQUESTS_PAGE" as const,
    endpoint: "https://api.github.com/graphql",
    operation: "TestQuery",
    query: "query TestQuery($a: Int, $b: Int) { viewer { login } }",
    normalizedQuery: "query TestQuery($a: Int, $b: Int) { viewer { login } }",
    variables: { b: 2, a: 1 },
    fetcher,
  };
}

beforeEach(() => {
  state.ttlSeconds = 300;
  state.entries = [];
  state.calls = [];
  state.snapshots = [];
});

describe("GitHubCache", () => {
  test("uses stable variable keys and separates PAT from App entries", async () => {
    const cache = new GitHubCache();
    const fetcher = vi.fn(async () => ({
      data: { value: 1 },
      statusCode: 200,
      pointCost: 7,
      rateLimit: null,
    }));

    expect((await cache.query(input("PAT", fetcher))).source).toBe("LIVE");
    const reordered = { ...input("PAT", fetcher), variables: { a: 1, b: 2 } };
    expect((await cache.query(reordered)).source).toBe("CACHE");
    expect((await cache.query(input("APP", fetcher))).source).toBe("LIVE");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state.entries).toHaveLength(2);
    expect(state.calls.map((call) => call.pointCost)).toEqual([7, 0, 7]);
    expect(state.calls[1]?.pointsAvoided).toBe(7);
    expect(JSON.parse(state.calls[0]!.variablesJson)).toEqual({ a: 1, b: 2 });
  });

  test("coalesces concurrent misses and records the avoided exact cost", async () => {
    const cache = new GitHubCache();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(async () => {
      await gate;
      return {
        data: { value: 2 },
        statusCode: 200,
        pointCost: 11,
        rateLimit: null,
      };
    });
    const first = cache.query(input("PAT", fetcher));
    const second = cache.query(input("PAT", fetcher));
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ source: "LIVE" }),
      expect.objectContaining({ source: "CACHE" }),
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      state.calls.find((call) => call.source === "CACHE")?.pointsAvoided,
    ).toBe(11);
  });

  test("serves stale data on failure and guards an exhausted bucket", async () => {
    const cache = new GitHubCache();
    await cache.query(
      input("PAT", async () => ({
        data: { value: 3 },
        statusCode: 200,
        pointCost: 5,
        rateLimit: null,
      })),
    );
    state.entries[0]!.fetchedAt = new Date(Date.now() - 600_000);
    const failed = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    await expect(
      cache.query({ ...input("PAT", failed), allowStaleOnError: true }),
    ).resolves.toEqual(
      expect.objectContaining({
        source: "ERROR",
        stale: true,
        data: { value: 3 },
      }),
    );

    state.snapshots.push({
      authentication: "PAT",
      resource: "graphql",
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: new Date(Date.now() + 60_000),
    });
    await expect(cache.query(input("PAT", failed))).resolves.toEqual(
      expect.objectContaining({ source: "ERROR", stale: true }),
    );
    expect(failed).toHaveBeenCalledOnce();
    await expect(
      cache.query({
        ...input("APP", failed),
        allowStaleOnError: false,
      }),
    ).rejects.toThrow("upstream unavailable");
  });

  test("force refreshes, mutations invalidate entries, and deletion is scoped", async () => {
    const cache = new GitHubCache();
    let value = 1;
    const fetcher = vi.fn(async () => ({
      data: { value: value++ },
      statusCode: 200,
      pointCost: 2,
      rateLimit: null,
    }));
    await cache.query(input("PAT", fetcher));
    await expect(
      cache.query({ ...input("PAT", fetcher), force: true }),
    ).resolves.toEqual(
      expect.objectContaining({ data: { value: 2 }, source: "LIVE" }),
    );
    const id = state.entries[0]!.id;
    expect(await cache.delete("missing")).toBe(false);
    expect(await cache.delete(id)).toBe(true);

    await cache.query(input("PAT", fetcher));
    await cache.mutation({
      ...input("PAT", fetcher),
      operation: "TestMutation",
      query: "mutation TestMutation { addComment { id } }",
    });
    expect(state.entries).toHaveLength(0);
    expect(state.calls.at(-1)).toMatchObject({
      operation: "TestMutation",
      source: "LIVE",
      pointCost: null,
    });
  });

  test("validates TTL and reports rolling point metrics", async () => {
    const cache = new GitHubCache();
    await expect(
      cache.updateTtl(0, async () => Promise.resolve({} as never)),
    ).rejects.toThrow("1 to 1440");
    await cache.query(
      input("PAT", async () => ({
        data: { value: 1 },
        statusCode: 200,
        pointCost: 4,
        rateLimit: null,
      })),
    );
    await cache.query(input("PAT", vi.fn()));
    const metrics = await cache.metrics();
    expect(metrics.windows[0]).toMatchObject({
      pointsUsed: 4,
      pointsAvoided: 4,
      total: 2,
    });
    expect(metrics.operations[0]?.operation).toBe("TestQuery");
    expect(metrics.operations[0]?.windows[0]).toMatchObject({
      total: 2,
      pointsUsed: 4,
      pointsAvoided: 4,
    });
    expect(metrics.requestSources).toHaveLength(1);
    expect(metrics.requestSources[0]).toMatchObject({
      requestSource: "PULL_REQUESTS_PAGE",
    });
    expect(metrics.requestSources[0]?.windows[0]).toMatchObject({
      total: 2,
      pointsUsed: 4,
      pointsAvoided: 4,
    });
  });

  test("records uncached REST and GraphQL transport calls with sanitized request context", async () => {
    const cache = new GitHubCache();
    await cache.recordRestCall({
      authentication: "APP",
      method: "GET",
      endpoint:
        "https://api.github.com/repos/acme/widgets/actions/runs/44/jobs?page=2",
      requestSource: "ACTIONS_PAGE",
      durationMs: 12,
      statusCode: 200,
    });
    await cache.recordGraphqlTransportCall({
      authentication: "APP",
      endpoint: "https://api.github.com/graphql",
      operation: "VerifyGitHubApp",
      requestSource: "GITHUB_SETTINGS",
      variables: { pullRequestId: "PR_kwDO123", apiToken: "secret" },
      durationMs: 8,
      statusCode: 200,
    });

    expect(state.calls[0]).toMatchObject({
      authentication: "APP",
      apiType: "REST",
      method: "GET",
      operation: "GET /repos/acme/widgets/actions/runs/44/jobs",
      requestSource: "ACTIONS_PAGE",
    });
    expect(JSON.parse(state.calls[0]!.variablesJson)).toEqual({
      path: "/repos/acme/widgets/actions/runs/44/jobs",
      query: { page: "2" },
    });
    expect(state.calls[1]).toMatchObject({
      apiType: "GRAPHQL",
      operation: "VerifyGitHubApp",
      requestSource: "GITHUB_SETTINGS",
    });
    expect(JSON.parse(state.calls[1]!.variablesJson)).toEqual({
      apiToken: "[REDACTED]",
      pullRequestId: "PR_kwDO123",
    });
  });

  test("filters paginated API calls by API type, request source, and live/cache source", async () => {
    const cache = new GitHubCache();
    const fetcher = vi.fn(async () => ({
      data: { value: 1 },
      statusCode: 200,
      pointCost: 3,
      rateLimit: null,
    }));
    await cache.query(input("PAT", fetcher));
    await cache.query(input("PAT", fetcher));
    await cache.recordRestCall({
      authentication: "APP",
      method: "GET",
      endpoint: "https://api.github.com/repos/acme/widgets",
      requestSource: "CODEBASE_REPOSITORY",
      durationMs: 12,
      statusCode: 200,
    });

    await expect(
      cache.calls(50, 0, {
        apiType: "GRAPHQL",
        requestSource: "PULL_REQUESTS_PAGE",
        source: "CACHE",
      }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        {
          apiType: "GRAPHQL",
          requestSource: "PULL_REQUESTS_PAGE",
          source: "CACHE",
        },
      ],
    });
  });

  test("clears API call history without clearing cached responses", async () => {
    const cache = new GitHubCache();
    await cache.query(
      input("PAT", async () => ({
        data: { value: 1 },
        statusCode: 200,
        pointCost: 3,
        rateLimit: null,
      })),
    );
    expect(state.calls).toHaveLength(1);
    expect(state.entries).toHaveLength(1);

    await expect(cache.clearCalls()).resolves.toBe(true);

    expect(state.calls).toHaveLength(0);
    expect(state.entries).toHaveLength(1);
  });
});
