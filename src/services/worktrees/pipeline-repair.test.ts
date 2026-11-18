import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKTREE_PUSH_EVIDENCE_CAPABILITY } from "@ai-development-environment/agent-contract/worktrees";
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
  workflowRun: { findUnique: vi.fn(), findMany: vi.fn() },
  workflowRunResourceLink: { findMany: vi.fn() },
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
  codebase: {
    agentId: "agent",
    repositoryId: "repository",
    agent: {
      capabilitiesJson: JSON.stringify([WORKTREE_PUSH_EVIDENCE_CAPABILITY]),
    },
  },
  availability: "AVAILABLE",
  missingAt: null,
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
    headSha: string | null = worktree.headSha,
  ) =>
    advancePipelineRepair({
      worktree: { ...worktree, headSha: headSha ?? worktree.headSha },
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
  db.workflowRun.findMany.mockResolvedValue([]);
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

  it("allows CI to settle before pausing on a canceled pipeline", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    f.finish("SUCCEEDED");
    await f.tick();
    const canceledCI = { ...pendingCI, terminalStatus: "CANCELED" };
    const finished = f.finishedAt.getTime();
    await expect(f.tick(canceledCI, finished + 59_000)).resolves.toBe(true);
    await expect(f.tick(canceledCI, finished + 60_000)).rejects.toThrow(
      /CI reported CANCELED/,
    );
    expect(f.trigger).toHaveBeenCalledOnce();
  });

  it.each(["original", null])(
    "times out after an hour without a CI verdict for remote head %s",
    async (headSha) => {
      const f = fixture();
      await f.tick();
      await f.tick();
      f.finish("SUCCEEDED");
      await f.tick();
      const deadline = f.finishedAt.getTime() + 3_600_000;
      await expect(f.tick(pendingCI, deadline - 1, headSha)).resolves.toBe(
        true,
      );
      await expect(f.tick(pendingCI, deadline, headSha)).rejects.toThrow(
        /Timed out waiting for CI/,
      );
    },
  );

  it("times out when a saved repair has no CI verdict before dispatch", async () => {
    const f = fixture();
    await f.tick();
    await expect(
      f.tick(pendingCI, f.finishedAt.getTime() + 3_600_000),
    ).rejects.toThrow(/Timed out waiting for CI/);
    expect(f.trigger).not.toHaveBeenCalled();
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

  it("cancels a parked commit and a push whose wait has not been saved", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    const cancelJob = vi.fn();
    f.lifecycle.mockImplementation(async () => {
      db.workflowWait.findMany.mockResolvedValue([{ externalKey: "commit" }]);
      db.workflowRunResourceLink.findMany.mockResolvedValue([
        { resourceId: "commit" },
        { resourceId: "push" },
      ]);
      db.agentJob.findMany.mockResolvedValue([
        { id: "commit" },
        { id: "push" },
      ]);
      return null;
    });

    await cancelPipelineRepair(
      f.repair(),
      { lifecycle: f.lifecycle },
      { cancelJob },
    );

    expect(db.agentJob.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["commit", "push"] },
        kind: { in: ["worktree.commit", "worktree.operation"] },
        status: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] },
      },
      select: { id: true },
    });
    expect(cancelJob.mock.calls).toEqual([["commit"], ["push"]]);
  });

  it("cancels descendants and their jobs using existing parent-run links", async () => {
    const f = fixture();
    await f.tick();
    await f.tick();
    const root = f.trigger.mock.calls[0]![1]!;
    const children = [
      { id: "child", parentRunId: root, status: "SUCCEEDED" },
      { id: "grandchild", parentRunId: "child", status: "RUNNING" },
    ];
    db.workflowRun.findMany.mockImplementation(async ({ where }) =>
      children.filter(({ parentRunId }) =>
        where.parentRunId.in.includes(parentRunId),
      ),
    );
    db.workflowRunResourceLink.findMany.mockResolvedValue([
      { resourceId: "grandchild-push" },
    ]);
    db.agentJob.findMany.mockResolvedValue([{ id: "grandchild-push" }]);
    const cancelJob = vi.fn();

    await cancelPipelineRepair(
      f.repair(),
      { lifecycle: f.lifecycle },
      { cancelJob },
    );

    expect(f.lifecycle.mock.calls.map(([id]) => id)).toEqual([
      root,
      "grandchild",
    ]);
    expect(db.workflowRunResourceLink.findMany).toHaveBeenCalledWith({
      where: {
        runId: { in: [root, "child", "grandchild"] },
        kind: "AGENT_JOB",
      },
      select: { resourceId: true },
    });
    expect(cancelJob).toHaveBeenCalledWith("grandchild-push");
  });
});
