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
  currentUser: vi.fn(),
  issueLinks: [] as Array<{ cacheEntryId: string; issueKey: string }>,
}));

vi.mock("jira.js", () => ({
  AgileClient: class {},
  Version3Client: class {
    myself = { getCurrentUser: state.currentUser };
  },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => {
    const jiraCachedTicket = {
      upsert: async () => ({}),
    };
    const jiraCacheEntryIssue = {
      deleteMany: async ({ where }: { where: { cacheEntryId: string } }) => {
        state.issueLinks = state.issueLinks.filter(
          (link) => link.cacheEntryId !== where.cacheEntryId,
        );
        return { count: 0 };
      },
      createMany: async ({
        data,
      }: {
        data: Array<{ cacheEntryId: string; issueKey: string }>;
      }) => {
        state.issueLinks.push(...data);
        return { count: data.length };
      },
    };
    return {
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
      jiraCachedTicket,
      jiraCacheEntryIssue,
      $transaction: async (
        callback: (transaction: {
          jiraCachedTicket: typeof jiraCachedTicket;
          jiraCacheEntryIssue: typeof jiraCacheEntryIssue;
        }) => Promise<unknown>,
      ) => callback({ jiraCachedTicket, jiraCacheEntryIssue }),
    };
  },
}));

import { JiraService } from "./jira.service";

type CacheInvoker = {
  cachedCall<T>(input: {
    operation: string;
    params: Record<string, unknown>;
    requestSummary: string;
    force?: boolean;
    allowStaleOnError?: boolean;
    fetcher: () => Promise<T>;
    itemCount?: (value: T) => number | null;
  }): Promise<{
    value: T;
    source: "LIVE" | "CACHE" | "ERROR";
    stale: boolean;
  }>;
  storeSummaries(
    entryId: string,
    issues: Array<Record<string, unknown>>,
    fetchedAt: Date,
  ): Promise<void>;
};

function invoker() {
  return new JiraService() as unknown as CacheInvoker;
}

beforeEach(() => {
  state.entry = null;
  state.calls = [];
  state.currentUser.mockReset();
  state.issueLinks = [];
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

  test("does not accept stale data when testing the Jira connection", async () => {
    const service = new JiraService();
    state.currentUser.mockResolvedValueOnce({
      accountId: "account-1",
      displayName: "Example User",
    });
    await expect(service.testConnection()).resolves.toMatchObject({
      accountId: "account-1",
    });
    state.currentUser.mockRejectedValueOnce(new Error("Jira unavailable"));

    await expect(service.testConnection()).rejects.toThrow("Jira unavailable");
    expect(state.calls.at(-1)).toMatchObject({
      source: "ERROR",
      servedStale: false,
    });
  });

  test("rejects a stale connection result from a coalesced request", async () => {
    const service = new JiraService();
    const internal = service as unknown as {
      cachedCall: () => Promise<{
        value: { accountId: string };
        source: "ERROR";
        stale: boolean;
        fetchedAt: Date;
        entryId: string;
      }>;
    };
    internal.cachedCall = vi.fn().mockResolvedValue({
      value: { accountId: "account-1" },
      source: "ERROR",
      stale: true,
      fetchedAt: new Date(),
      entryId: "entry-1",
    });

    await expect(service.testConnection()).rejects.toThrow(
      "live request failed",
    );
  });

  test("clears cache-entry issue links when a refreshed page is empty", async () => {
    const service = invoker();
    state.issueLinks = [
      { cacheEntryId: "entry-1", issueKey: "APP-1" },
      { cacheEntryId: "entry-2", issueKey: "APP-2" },
    ];

    await service.storeSummaries("entry-1", [], new Date());

    expect(state.issueLinks).toEqual([
      { cacheEntryId: "entry-2", issueKey: "APP-2" },
    ]);
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
