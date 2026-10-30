import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  WorktreeAutomationService,
  WorktreesService,
} from "@/services/worktrees";

import { createWorktreeResolvers } from "./worktrees";

const context = (agentId: string | null) =>
  ({ agentId }) as unknown as GraphQLContext;

describe("worktree resolvers", () => {
  test("forwards saved-only and scoped enrichment reads and rejects agent credentials", async () => {
    const overview = vi.fn().mockResolvedValue({ agents: [] });
    const enrichment = vi.fn().mockResolvedValue({ updates: [] });
    const resolvers = createWorktreeResolvers(
      { overview, enrichment } as unknown as WorktreesService,
      {} as WorktreeAutomationService,
    );
    await resolvers.Query.worktreeOverview(
      {},
      { appId: "app-1", savedOnly: true },
      context(null),
    );
    expect(overview).toHaveBeenCalledWith("app-1", undefined, true);
    const args = {
      appId: "app-1",
      kind: "GITLAB_PIPELINES" as const,
      force: true,
    };
    await resolvers.Query.worktreeEnrichment({}, args, context(null));
    expect(enrichment).toHaveBeenCalledWith(args);
    expect(() =>
      resolvers.Query.worktreeEnrichment({}, args, context("agent-1")),
    ).toThrow("control-plane");
    expect(enrichment).toHaveBeenCalledOnce();
  });

  test("refreshes a worktree pull request for control-plane callers", async () => {
    const refreshed = { id: "worktree-1", pullRequest: { id: "pr-1" } };
    const refreshPullRequest = vi.fn().mockResolvedValue(refreshed);
    const resolvers = createWorktreeResolvers(
      { refreshPullRequest } as unknown as WorktreesService,
      {} as WorktreeAutomationService,
    );

    await expect(
      resolvers.Mutation.refreshWorktreePullRequest(
        {},
        { id: "worktree-1" },
        context(null),
      ),
    ).resolves.toBe(refreshed);
    expect(refreshPullRequest).toHaveBeenCalledWith("worktree-1");
  });

  test("rejects pull request refreshes from agent credentials", () => {
    const refreshPullRequest = vi.fn();
    const resolvers = createWorktreeResolvers(
      { refreshPullRequest } as unknown as WorktreesService,
      {} as WorktreeAutomationService,
    );

    expect(() =>
      resolvers.Mutation.refreshWorktreePullRequest(
        {},
        { id: "worktree-1" },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(refreshPullRequest).not.toHaveBeenCalled();
  });
});
