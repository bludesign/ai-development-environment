// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  WORKTREE_DELETE_JOB_KIND,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { NotificationsService } from "@/services/notifications";
import { WorktreesService } from "./worktrees.service";

function completionHandlers(notifications?: {
  recordInTransaction: ReturnType<typeof vi.fn>;
  created: ReturnType<typeof vi.fn>;
}) {
  const handlers = new Map<string, (job: never) => Promise<void>>();
  const control = {
    registerCompletionHandler: (
      kind: string,
      handler: (job: never) => Promise<void>,
    ) => handlers.set(kind, handler),
  } as unknown as AgentControlService;
  new WorktreesService(
    control,
    {} as JiraService,
    {} as GitHubService,
    undefined,
    undefined,
    undefined,
    undefined,
    notifications as unknown as NotificationsService,
  );
  return handlers;
}

const inventory = {
  gitDirectory: "/target/.git/worktrees/feature-move",
  folder: "/target-feature-move",
  relativePath: "../target-feature-move",
  primary: false,
  branch: "feature/move",
  headSha: "abc",
  upstream: "origin/feature/move",
  ahead: 0,
  behind: 0,
  syncState: "IN_SYNC",
  baseAhead: 1,
  baseBehind: 0,
  availability: "AVAILABLE",
  error: null,
  checkedAt: "2026-11-02T14:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("worktree move notifications and cleanup warnings", () => {
  test.each(["NEW", "EXISTING"] as const)(
    "notifies only when destination checkout creates a worktree (%s)",
    async (destinationMode) => {
      const notification = { id: "notification-moved-worktree" };
      const notifications = {
        recordInTransaction: vi.fn().mockResolvedValue(notification),
        created: vi.fn(),
      };
      const handlers = completionHandlers(notifications);
      const move = {
        id: "move-1",
        sourceWorktreeId: "source-worktree",
        sourceCodebaseId: "source-codebase",
        targetCodebaseId: "target-codebase",
        targetWorktreeId: destinationMode === "NEW" ? null : "existing-target",
        destinationMode,
        branch: "feature/move",
        baseBranch: "main",
        status: "CHECKING_OUT",
        targetJobId: "checkout-job",
        deleteSource: false,
      };
      const updateMove = vi
        .fn()
        .mockImplementation(async ({ data }) => Object.assign(move, data));
      const transaction = {
        codebase: { update: vi.fn().mockResolvedValue({}) },
        worktree: {
          upsert: vi
            .fn()
            .mockResolvedValue({ id: "new-target", highlightColor: "amber" }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        worktreeMove: { update: updateMove },
      };
      getPrismaClient.mockResolvedValue({
        worktreeMove: {
          findUnique: vi.fn(async () => ({ ...move })),
          update: updateMove,
        },
        codebase: {
          findUnique: vi
            .fn()
            .mockResolvedValue({ localBranchesJson: '["main"]' }),
        },
        $transaction: vi.fn(async (callback) => callback(transaction)),
      });
      const job = {
        id: "checkout-job",
        payloadJson: JSON.stringify({ moveId: move.id }),
        status: "SUCCEEDED",
        resultJson: JSON.stringify({
          outcome: "CHECKED_OUT",
          worktree: inventory,
        }),
        error: null,
      };
      await handlers.get(WORKTREE_MOVE_CHECKOUT_JOB_KIND)!(job as never);
      await handlers.get(WORKTREE_MOVE_CHECKOUT_JOB_KIND)!(job as never);
      expect(move.status).toBe("SUCCEEDED");
      if (destinationMode === "NEW") {
        expect(notifications.recordInTransaction).toHaveBeenCalledOnce();
        expect(notifications.recordInTransaction).toHaveBeenCalledWith(
          transaction,
          expect.objectContaining({
            typeKey: "WORKTREE_CREATED",
            dedupeKey: "worktree-created:new-target",
            href: "/dashboard/worktrees/new-target",
            worktreeId: "new-target",
          }),
        );
        expect(notifications.created).toHaveBeenCalledWith(notification);
      } else {
        expect(notifications.recordInTransaction).not.toHaveBeenCalled();
        expect(transaction.worktree.upsert).not.toHaveBeenCalled();
        expect(transaction.worktree.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "existing-target", codebaseId: "target-codebase" },
          }),
        );
      }
    },
  );

  test("completes the move with a warning while removing a source whose Xcode cleanup failed", async () => {
    const handlers = completionHandlers();
    const move = {
      id: "move-1",
      sourceWorktreeId: "source-worktree",
      sourceCodebaseId: "source-codebase",
      status: "CLEANING_UP",
      cleanupJobId: "delete-job",
    };
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const updateMove = vi
      .fn()
      .mockImplementation(async ({ data }) => Object.assign(move, data));
    getPrismaClient.mockResolvedValue({
      worktreeMove: {
        findUnique: vi.fn(async () => ({ ...move })),
        update: updateMove,
      },
      worktree: { deleteMany },
      $transaction: vi.fn(async (operations) => Promise.all(operations)),
    });
    const job = {
      id: "delete-job",
      worktreeId: "source-worktree",
      payloadJson: JSON.stringify({ moveId: move.id }),
      status: "SUCCEEDED",
      error: null,
      resultJson: JSON.stringify({
        deleted: true,
        buildDataCleanup: {
          warnings: ["Permission denied deleting DerivedData", "", false],
        },
      }),
    };
    await handlers.get(WORKTREE_DELETE_JOB_KIND)!(job as never);
    await handlers.get(WORKTREE_DELETE_JOB_KIND)!(job as never);
    expect(deleteMany).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "source-worktree" },
    });
    expect(updateMove).toHaveBeenCalledWith({
      where: { id: "move-1" },
      data: {
        status: "SUCCEEDED_WITH_WARNING",
        warning: "Permission denied deleting DerivedData",
        finishedAt: expect.any(Date),
      },
    });
  });
});
