import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateWorkflowCondition } from "@/lib/workflows/session.server";
import type { WorkflowsService } from "@/services/workflows";
import {
  advancePipelineRepair,
  cancelPipelineRepair,
  type PipelineCI,
  type PipelineRepair,
} from "./pipeline-repair";

const db = vi.hoisted(() => ({
  workflow: { findMany: vi.fn() },
  workflowRun: { findUnique: vi.fn() },
  workflowWait: { findMany: vi.fn() },
  agentJob: { findMany: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({ getPrismaClient: async () => db }));

const failure = {
  provider: "GITHUB" as const,
  id: "check",
  status: "FAILURE",
  url: null,
  headSha: "original",
};
const failingCI = { passed: false, failures: [failure], failureKey: "run-1" };
const pendingCI = { passed: false, failures: [] };
const passingCI = { passed: true, failures: [] };
const worktree = {
  id: "worktree",
  codebaseId: "codebase",
  folder: "/worktree",
  gitDirectory: "/git/worktrees/worktree",
  branch: "topic",
  headSha: "original",
  codebase: { agentId: "agent", repositoryId: "repository" },
  availability: "AVAILABLE",
  hasConflicts: false,
  rebaseInProgress: false,
  hasStagedChanges: false,
  hasUnstagedChanges: false,
};
const condition = {
  op: "EQ" as const,
  left: {
    source: "SESSION" as const,
    path: "worktree.pipelineRepair.retryCount",
  },
  right: 1,
};

function fixture() {
  let repair: PipelineRepair | null = null;
  const finishedAt = new Date("2026-10-31T10:00:00Z");
  const trigger = vi.fn<WorkflowsService["trigger"]>();
  const lifecycle = vi.fn<WorkflowsService["lifecycle"]>();
  trigger.mockImplementation(async (_, key) => {
    db.workflowRun.findUnique.mockImplementation(async ({ where }) =>
      where.idempotencyKey === key ? { id: key, status: "RUNNING" } : null,
    );
    return { id: key } as Awaited<ReturnType<WorkflowsService["trigger"]>>;
  });
  const tick = (
    ci: PipelineCI = failingCI,
    now = finishedAt.getTime(),
    headSha = worktree.headSha,
  ) =>
    advancePipelineRepair({
      worktree: { ...worktree, headSha },
      selection: { id: "repair", choice: null },
      repair,
      headSha,
      ci,
      workflows: { trigger },
      now,
      save: async (next) => {
        repair = next;
      },
    });
  const finish = (status: string) => {
    const key = trigger.mock.lastCall?.[1];
    db.workflowRun.findUnique.mockImplementation(async ({ where }) =>
      where.idempotencyKey === key ? { id: "run", status, finishedAt } : null,
    );
  };
  return { tick, finish, finishedAt, trigger, lifecycle, repair: () => repair };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.workflow.findMany.mockResolvedValue([
    {
      id: "repair",
      maxPipelineRepairRetries: 1,
      activeVersion: {
        triggers: [
          {
            kind: "RESOURCE_MANUAL",
            configJson: JSON.stringify({ resourceKind: "WORKTREE" }),
          },
        ],
      },
    },
  ]);
  db.workflowRun.findUnique.mockResolvedValue(null);
  db.workflowWait.findMany.mockResolvedValue([]);
});

describe("automatic pipeline repair", () => {
  it("persists dispatch, exposes a numeric retry count, and waits for fresh CI", async () => {
    const f = fixture();
    await f.tick(pendingCI);
    expect(f.repair()).toBeNull();
    await f.tick();
    expect(f.trigger).not.toHaveBeenCalled();
    await f.tick();
    await f.tick();
    expect(f.trigger).toHaveBeenCalledTimes(1);
    expect(
      evaluateWorkflowCondition(
        condition,
        f.trigger.mock.calls[0]![0].sessionData ?? {},
      ),
    ).toBe(false);
    f.finish("SUCCEEDED");
    await f.tick();
    await f.tick(failingCI, f.finishedAt.getTime() + 59_000);
    await f.tick(pendingCI, f.finishedAt.getTime() + 60_000);
    expect(f.trigger).toHaveBeenCalledTimes(1);
    await f.tick(failingCI, f.finishedAt.getTime() + 60_000);
    await f.tick();
    expect(f.trigger).toHaveBeenCalledTimes(2);
    expect(
      evaluateWorkflowCondition(
        condition,
        f.trigger.mock.calls[1]![0].sessionData ?? {},
      ),
    ).toBe(true);
    f.finish("SUCCEEDED");
    await f.tick();
    await expect(
      f.tick(failingCI, f.finishedAt.getTime() + 60_000),
    ).rejects.toThrow(/still failing/);
  });

  it("clears a repair after green CI and pauses on a workflow error", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    f.finish("SUCCEEDED");
    await f.tick();
    await expect(f.tick(passingCI)).resolves.toBe(false);
    expect(f.repair()).toBeNull();
    await f.tick();
    await f.tick();
    f.finish("FAILED");
    await expect(f.tick()).rejects.toThrow(/workflow failed/);
    expect(f.trigger).toHaveBeenCalledTimes(2);
  });

  it("only accepts a changed revision with a successful Push job from its own run", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    f.finish("SUCCEEDED");
    await expect(f.tick(pendingCI, undefined, "fixed")).rejects.toThrow(
      /verified worktree Push/,
    );
    db.workflowWait.findMany.mockResolvedValue([{ externalKey: "push-job" }]);
    db.agentJob.findMany.mockResolvedValue([
      {
        payloadJson: JSON.stringify({ operation: "PUSH" }),
        resultJson: JSON.stringify({
          pushedHeadSha: "fixed",
          worktree: { ...worktree, headSha: "fixed" },
        }),
      },
    ]);
    await f.tick(pendingCI, undefined, "fixed");
    expect(f.repair()?.headSha).toBe("fixed");
    expect(db.workflowWait.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runId: "run" }),
      }),
    );
  });

  it("cancels a run recovered by its persisted dispatch key", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    const runId = f.trigger.mock.calls[0]![1];
    await cancelPipelineRepair(f.repair(), { lifecycle: f.lifecycle });
    expect(f.lifecycle).toHaveBeenCalledWith(runId, "CANCEL", {
      ignoreMissing: true,
    });
  });
});
