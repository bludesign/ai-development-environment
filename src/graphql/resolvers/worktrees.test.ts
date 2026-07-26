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
