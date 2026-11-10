import { expect, test, vi } from "vitest";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { WorktreeMergeService } from "@/services/worktrees/worktree-merge.service";
import { createWorktreeMergeResolvers } from "./worktree-merge";

test("agent credentials cannot inspect or submit Bulk Merge batches", () => {
  const service = {
    candidates: vi.fn(),
    batches: vi.fn(),
    batch: vi.fn(),
    start: vi.fn(),
  };
  const { Query, Mutation } = createWorktreeMergeResolvers(
    service as unknown as WorktreeMergeService,
  );
  const agent = { agentId: "agent" } as GraphQLContext;
  expect(() => Query.worktreeMergeCandidates(null, {}, agent)).toThrow(
    "Agent credentials cannot",
  );
  expect(() => Query.worktreeMergeBatches(null, {}, agent)).toThrow(
    "Agent credentials cannot",
  );
  expect(() => Query.worktreeMergeBatch(null, { id: "batch" }, agent)).toThrow(
    "Agent credentials cannot",
  );
  expect(() =>
    Mutation.startWorktreeMergeBatch(
      null,
      { input: { requestId: "request", items: [] } },
      agent,
    ),
  ).toThrow("Agent credentials cannot");
  expect(service.start).not.toHaveBeenCalled();
});
