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
  test("starts and reads scoped Bulk Sync batches only for control-plane callers", async () => {
    const start = vi.fn().mockResolvedValue({ id: "batch" });
    const batch = vi.fn().mockResolvedValue({ id: "batch" });
    const active = vi.fn().mockResolvedValue([]);
    const resolvers = createWorktreeResolvers(
      { syncBatches: { start, batch, active } } as unknown as WorktreesService,
      {} as WorktreeAutomationService,
    );
    const input = {
      worktreeIds: ["worktree"],
      requestId: "request",
      appId: "app",
      agentId: "agent",
    };
    await expect(
      resolvers.Mutation.startWorktreeSyncBatch({}, { input }, context(null)),
    ).resolves.toEqual({ id: "batch" });
    expect(start).toHaveBeenCalledWith(input);
    await resolvers.Query.worktreeSyncBatch({}, { id: "batch" }, context(null));
    expect(batch).toHaveBeenCalledWith("batch");
    await resolvers.WorktreeOverview.activeSyncBatches({
      syncScope: { appId: "app", worktreeId: "worktree" },
    });
    expect(active).toHaveBeenCalledWith("app", "worktree");
    expect(() =>
      resolvers.Mutation.startWorktreeSyncBatch(
        {},
        { input },
        context("agent"),
      ),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.worktreeSyncBatch({}, { id: "batch" }, context("agent")),
    ).toThrow("control-plane");
    expect(start).toHaveBeenCalledOnce();
    expect(batch).toHaveBeenCalledOnce();
  });
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
