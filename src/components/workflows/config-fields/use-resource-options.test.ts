import { describe, expect, test } from "vitest";

import { resourcePlan } from "./use-resource-options";

/**
 * Server-side caps the option queries must respect. These mirror private
 * constants in the services, so they are restated here rather than imported —
 * pulling `github.service` into a client test would drag in `server-only` and
 * Prisma. `PULL_REQUEST_PAGE_SIZE` and `ACTIONS_PAGE_SIZE` live in
 * `src/services/github/github.service.ts`; `jiraCachedTickets` caps at 100 in
 * `src/services/jira/jira.service.ts`.
 */
const MAX_PAGE_SIZE: Record<string, number> = {
  githubPullRequests: 25,
  githubActionsWorkflowRuns: 25,
  jiraCachedTickets: 100,
  agentRuns: 200,
};

/** Every `field(... first: N)` / `limit: N` pair in a query document. */
function pageSizes(query: string): Array<{ field: string; size: number }> {
  const found: Array<{ field: string; size: number }> = [];
  const pattern = /(\w+)\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const size = /(?:first|limit):\s*(\d+)/.exec(match[2]!);
    if (size) found.push({ field: match[1]!, size: Number(size[1]) });
  }
  return found;
}

describe("resource option queries", () => {
  test("never request more than the list resolvers allow", () => {
    // The resolvers throw on an over-large page size instead of clamping, and
    // `useResourceOptions` turns that rejection into a silent free-text
    // fallback — so this guards a failure the UI cannot surface on its own.
    const kinds = [
      "agent",
      "codebase",
      "worktree",
      "githubRepository",
      "githubPullRequest",
      "jiraTicket",
      "agentRun",
      "githubWorkflowRun",
    ] as const;

    for (const kind of kinds) {
      const plan = resourcePlan(
        kind as Parameters<typeof resourcePlan>[0],
        "scope-1",
      );
      if (!plan) continue;
      for (const { field, size } of pageSizes(plan.query)) {
        const cap = MAX_PAGE_SIZE[field];
        if (cap === undefined) continue;
        expect(size, `${kind} → ${field}(first: ${size})`).toBeLessThanOrEqual(
          cap,
        );
      }
    }
  });

  test("the pull request picker asks for a page the resolver accepts", () => {
    const plan = resourcePlan("githubPullRequest", "repository-1");

    expect(plan?.query).toContain("first: 25");
    expect(plan?.variables).toEqual({
      scope: "REPOSITORY",
      repositoryId: "repository-1",
    });
  });
});
