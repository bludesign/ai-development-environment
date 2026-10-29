import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({ findUnique: vi.fn(), upsert: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({ gitHubRateLimitSnapshot: database }),
}));

import {
  extractGitHubGraphqlCost,
  prepareGitHubGraphql,
} from "./github-graphql";
import {
  assertGitHubRestRateLimitAvailable,
  clearGitHubRestRateLimitPause,
  observeGitHubRateLimit,
  parseGitHubRateLimitHeaders,
} from "./github-rate-limit";

beforeEach(() => {
  clearGitHubRestRateLimitPause("PAT");
  clearGitHubRestRateLimitPause("APP");
  database.findUnique.mockReset().mockResolvedValue(null);
  database.upsert.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  clearGitHubRestRateLimitPause("PAT");
  clearGitHubRestRateLimitPause("APP");
});

function headers(overrides: Record<string, string> = {}) {
  return new Headers({
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": "4875",
    "x-ratelimit-used": "125",
    "x-ratelimit-reset": "1785045600",
    "x-ratelimit-resource": "graphql",
    ...overrides,
  });
}

describe("GitHub rate-limit instrumentation", () => {
  test("restores an exhausted REST pause from the persisted snapshot and resumes at reset", async () => {
    vi.useFakeTimers();
    const resetAt = new Date(Date.now() + 60_000);
    database.findUnique.mockResolvedValue({
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt,
      resource: "core",
    });
    await expect(
      assertGitHubRestRateLimitAvailable("PAT"),
    ).rejects.toMatchObject({
      statusCode: 403,
      rateLimit: { resetAt },
    });
    vi.setSystemTime(resetAt);
    await expect(
      assertGitHubRestRateLimitAvailable("PAT"),
    ).resolves.toBeUndefined();
  });

  test("shares observed exhaustion across REST callers despite out-of-order responses or failed telemetry", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    database.upsert.mockRejectedValue(new Error("telemetry unavailable"));
    await observeGitHubRateLimit(
      "PAT",
      new Response(null, {
        headers: headers({
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": reset,
        }),
      }),
    );
    database.upsert.mockResolvedValue({});
    await observeGitHubRateLimit(
      "PAT",
      new Response(null, {
        headers: headers({
          "x-ratelimit-resource": "core",
          "x-ratelimit-reset": reset,
        }),
      }),
    );
    expect(database.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ remaining: 0, used: 5000 }),
      }),
    );
    await expect(assertGitHubRestRateLimitAvailable("PAT")).rejects.toThrow(
      "REST rate limit is exhausted",
    );
    await expect(
      assertGitHubRestRateLimitAvailable("APP"),
    ).resolves.toBeUndefined();
    clearGitHubRestRateLimitPause("PAT");
    await expect(
      assertGitHubRestRateLimitAvailable("PAT"),
    ).resolves.toBeUndefined();
  });

  test("does not pause REST for exhausted GraphQL quota", async () => {
    await observeGitHubRateLimit(
      "PAT",
      new Response(null, {
        headers: headers({
          "x-ratelimit-remaining": "0",
          "x-ratelimit-used": "5000",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
        }),
      }),
    );
    await expect(
      assertGitHubRestRateLimitAvailable("PAT"),
    ).resolves.toBeUndefined();
  });

  test("parses all five headers without hardcoding the limit", () => {
    expect(
      parseGitHubRateLimitHeaders(headers({ "x-ratelimit-limit": "12000" })),
    ).toEqual({
      limit: 12000,
      remaining: 4875,
      used: 125,
      resetAt: new Date(1785045600 * 1000),
      resource: "graphql",
    });
  });

  test("ignores incomplete and malformed snapshots", () => {
    const incomplete = headers();
    incomplete.delete("x-ratelimit-used");
    expect(parseGitHubRateLimitHeaders(incomplete)).toBeNull();
    expect(
      parseGitHubRateLimitHeaders(
        headers({ "x-ratelimit-remaining": "not-a-number" }),
      ),
    ).toBeNull();
  });

  test("adds an aliased rateLimit cost only to read queries", () => {
    const prepared = prepareGitHubGraphql(
      "query Viewer($withName: Boolean!) { viewer { login name @include(if: $withName) } }",
    );
    expect(prepared.kind).toBe("query");
    expect(prepared.operation).toBe("Viewer");
    expect(prepared.liveQuery).toContain("_adeRateLimit: rateLimit");
    expect(prepared.normalizedQuery).not.toContain("_adeRateLimit");

    const mutation = prepareGitHubGraphql(
      "mutation Reply { addComment(input: {}) { clientMutationId } }",
    );
    expect(mutation.kind).toBe("mutation");
    expect(mutation.liveQuery).toBe(mutation.normalizedQuery);
    expect(mutation.liveQuery).not.toContain("rateLimit");
  });

  test("extracts exact cost and strips internal data", () => {
    expect(
      extractGitHubGraphqlCost({
        viewer: { login: "octocat" },
        _adeRateLimit: { cost: 17 },
      }),
    ).toEqual({
      data: { viewer: { login: "octocat" } },
      pointCost: 17,
    });
    expect(extractGitHubGraphqlCost({ viewer: null })).toEqual({
      data: { viewer: null },
      pointCost: null,
    });
  });
});
