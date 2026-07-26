import { describe, expect, test } from "vitest";

import {
  extractGitHubGraphqlCost,
  prepareGitHubGraphql,
} from "./github-graphql";
import { parseGitHubRateLimitHeaders } from "./github-rate-limit";

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
