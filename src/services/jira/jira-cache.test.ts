import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  entry: null as null | {
    id: string;
    cacheKey: string;
    operation: string;
    paramsJson: string;
    responseJson: string;
    fetchedAt: Date;
    sourceId: string | null;
  },
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    jiraSettings: {
      findUnique: async () => ({
        id: "default",
        siteUrl: "https://example.atlassian.net",
        email: "user@example.com",
        apiToken: "secret-token",
        cacheTtlSeconds: 300,
      }),
    },
    jiraCacheEntry: {
      findUnique: async () => state.entry,
      upsert: async ({
        create,
        update,
      }: {
        create: typeof state.entry;
        update: Partial<NonNullable<typeof state.entry>>;
      }) => {
        state.entry = state.entry
          ? { ...state.entry, ...update }
          : (create as NonNullable<typeof state.entry>);
        return state.entry;
      },
    },
    jiraApiCallLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.calls.push(data);
        return data;
      },
      deleteMany: async () => ({ count: 0 }),
    },
  }),
}));

import { JiraService } from "./jira.service";

type CacheInvoker = {
  cachedCall<T>(input: {
    operation: string;
    params: Record<string, unknown>;
    requestSummary: string;
    fetcher: () => Promise<T>;
    itemCount?: (value: T) => number | null;
  }): Promise<{
    value: T;
    source: "LIVE" | "CACHE" | "ERROR";
    stale: boolean;
  }>;
};

function invoker() {
  return new JiraService() as unknown as CacheInvoker;
}

beforeEach(() => {
  state.entry = null;
  state.calls = [];
});

describe("Jira SDK cache wrapper", () => {
  test("stores a live response and serves the next call from SQLite", async () => {
    const service = invoker();
    const fetcher = vi.fn().mockResolvedValue({ values: [1, 2] });
    const input = {
      operation: "PROJECTS",
      params: { startAt: 0 },
      requestSummary: "Projects",
      fetcher,
      itemCount: (value: { values: number[] }) => value.values.length,
    };

    await expect(service.cachedCall(input)).resolves.toMatchObject({
      source: "LIVE",
      stale: false,
    });
    await expect(service.cachedCall(input)).resolves.toMatchObject({
      source: "CACHE",
      stale: false,
      value: { values: [1, 2] },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(state.calls.map((call) => call.source)).toEqual(["LIVE", "CACHE"]);
  });

  test("returns an expired response when the live request fails", async () => {
    const service = invoker();
    await service.cachedCall({
      operation: "BOARD",
      params: { boardId: 7 },
      requestSummary: "Board 7",
      fetcher: async () => ({ id: 7 }),
    });
    state.entry!.fetchedAt = new Date(Date.now() - 301_000);

    await expect(
      service.cachedCall({
        operation: "BOARD",
        params: { boardId: 7 },
        requestSummary: "Board 7",
        fetcher: async () => {
          throw new Error("Jira unavailable");
        },
      }),
    ).resolves.toMatchObject({
      source: "ERROR",
      stale: true,
      value: { id: 7 },
    });
    expect(state.calls.at(-1)).toMatchObject({
      source: "ERROR",
      servedStale: true,
      error: "Jira unavailable",
    });
  });

  test("coalesces concurrent misses and records the follower as a cache call", async () => {
    const service = invoker();
    let resolveFetch!: (value: { id: number }) => void;
    const fetcher = vi.fn(
      () => new Promise<{ id: number }>((resolve) => (resolveFetch = resolve)),
    );
    const input = {
      operation: "ISSUE",
      params: { issueKey: "APP-1" },
      requestSummary: "Issue APP-1",
      fetcher,
    };
    const first = service.cachedCall(input);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = service.cachedCall(input);
    resolveFetch({ id: 1 });

    await expect(first).resolves.toMatchObject({ source: "LIVE" });
    await expect(second).resolves.toMatchObject({ source: "CACHE" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("redacts the configured token from errors and logs", async () => {
    const service = invoker();
    await expect(
      service.cachedCall({
        operation: "MYSELF",
        params: {},
        requestSummary: "Current user",
        fetcher: async () => {
          throw new Error("Authorization secret-token was rejected");
        },
      }),
    ).rejects.toThrow("Authorization [REDACTED] was rejected");
    expect(state.calls[0]?.error).toBe("Authorization [REDACTED] was rejected");
  });
});
