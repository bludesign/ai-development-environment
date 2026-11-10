import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentControlService } from "@/services/agent-control";
import type { WorktreesService } from "./worktrees.service";
import type { WorkflowsService } from "@/services/workflows";
import { CodebaseBusyError } from "@/lib/codebase-busy";
import {
  WORKTREE_REVIEWED_SYNC_CAPABILITY,
  WORKTREE_REVIEWED_SYNC_FINALIZE_CAPABILITY,
} from "@ai-development-environment/agent-contract/worktrees";

const db = vi.hoisted(() => ({
  worktree: { findUnique: vi.fn() },
  worktreeAutoSync: { findUnique: vi.fn() },
  worktreeAutoMerge: { findFirst: vi.fn() },
  gitLabMergeOperation: { findFirst: vi.fn() },
  agentJob: { findFirst: vi.fn() },
  workflow: { findMany: vi.fn() },
  workflowRun: { findUnique: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({ getPrismaClient: async () => db }));
import {
  advanceMergeSync,
  cancelMergeSync,
  mergeSyncUnavailableReason,
  prepareMergeSync,
  readMergeSync,
  type MergeSyncPatch,
  type MergeSyncReadiness,
  type MergeConflictWorkflowInput,
} from "./merge-branch-sync";

const head = "a".repeat(40),
  target = "b".repeat(40),
  rebased = "c".repeat(40);
function fixture() {
  let ready: MergeSyncReadiness = {
    state: "OPEN",
    headSha: head,
    sourceOrigin: "github.com/fork/repo",
    sourceBranch: "feature",
    targetOrigin: "github.com/team/repo",
    targetUrl: "https://github.com/team/repo.git",
    targetBranch: "release",
    targetSha: target,
    ciPassed: false,
    canMerge: false,
    nativeAutoMerge: false,
  };
  const worktree = {
    id: "wt",
    codebaseId: "cb",
    folder: "/wt",
    gitDirectory: "/git/wt",
    branch: "feature",
    headSha: head,
    rebaseInProgress: false,
    availability: "AVAILABLE",
    missingAt: null,
    codebase: {
      agentId: "agent",
      agent: {
        capabilitiesJson: JSON.stringify([WORKTREE_REVIEWED_SYNC_CAPABILITY]),
      },
      repository: { id: "repo", canonicalOrigin: ready.sourceOrigin },
    },
  };
  db.worktree.findUnique.mockResolvedValue(worktree);
  const job = {
    id: "job",
    status: "RUNNING",
    resultJson: null as string | null,
    error: null,
  };
  const agents = { getJob: vi.fn(async () => job), cancelJob: vi.fn() };
  const worktrees = { createAutoSyncJob: vi.fn(async () => job) };
  const workflowRun = { id: "resolution-run", status: "RUNNING" };
  const workflows = {
    trigger: vi.fn(async () => workflowRun),
    run: vi.fn(async () => workflowRun),
    lifecycle: vi.fn(),
  };
  const row = {
    state: "SYNCING",
    syncStateJson: null as string | null,
    updatedAt: new Date(),
  };
  const save = vi.fn(async (patch: MergeSyncPatch) => {
    Object.assign(row, patch);
  });
  const merge = vi.fn(async () => {
    ready = { ...ready, state: "MERGED" };
  });
  const tick = () =>
    advanceMergeSync({
      ...row,
      worktreeId: "wt",
      readiness: async () => ready,
      worktrees: worktrees as unknown as WorktreesService,
      agents: agents as unknown as AgentControlService,
      workflows: workflows as unknown as WorkflowsService,
      save,
      merge,
    });
  const start = async (selection?: MergeConflictWorkflowInput) => {
    row.syncStateJson = await prepareMergeSync(
      "wt",
      ready,
      {
        provider: "GITHUB",
        id: "wt",
      },
      selection,
    );
  };
  const finish = (outcome = "SYNCED") => {
    job.status = "SUCCEEDED";
    job.resultJson = JSON.stringify({
      outcome,
      previousHeadSha: head,
      syncedHeadSha: rebased,
      syncedTargetSha: target,
    });
    ready = { ...ready, headSha: rebased };
    worktree.headSha = rebased;
  };
  return {
    row,
    job,
    agents,
    worktrees,
    worktree,
    workflowRun,
    workflows,
    save,
    merge,
    tick,
    start,
    finish,
    get ready() {
      return ready;
    },
    set ready(value: MergeSyncReadiness) {
      ready = value;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.worktreeAutoSync.findUnique.mockResolvedValue(null);
  db.worktreeAutoMerge.findFirst.mockResolvedValue(null);
  db.gitLabMergeOperation.findFirst.mockResolvedValue(null);
  db.agentJob.findFirst.mockResolvedValue(null);
  db.workflowRun.findUnique.mockResolvedValue(null);
});

function enableConflictWorkflow(f: ReturnType<typeof fixture>) {
  f.worktree.codebase.agent.capabilitiesJson = JSON.stringify([
    WORKTREE_REVIEWED_SYNC_CAPABILITY,
    WORKTREE_REVIEWED_SYNC_FINALIZE_CAPABILITY,
  ]);
  db.workflow.findMany.mockResolvedValue([
    {
      id: "resolve",
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
}

async function startConflictedSync(f: ReturnType<typeof fixture>) {
  enableConflictWorkflow(f);
  await f.start({ conflictWorkflowId: "resolve" });
  await f.tick();
  await f.tick();
  f.job.status = "SUCCEEDED";
  f.job.resultJson = JSON.stringify({
    outcome: "CONFLICT",
    previousHeadSha: head,
    syncedTargetSha: target,
  });
}

describe("managed branch sync", () => {
  test("persists dispatch identity, syncs a fork against the request target, then waits for current CI and requirements", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    expect(readMergeSync(f.row.syncStateJson).requestId).toBeTruthy();
    expect(f.worktrees.createAutoSyncJob).not.toHaveBeenCalled();
    await f.tick();
    expect(f.worktrees.createAutoSyncJob).toHaveBeenCalledWith(
      "wt",
      "SYNC",
      "feature",
      expect.any(String),
      false,
      {
        codebaseId: "cb",
        agentId: "agent",
        folder: "/wt",
        gitDirectory: "/git/wt",
        expectedOrigin: "github.com/fork/repo",
      },
      {
        expectedHeadSha: head,
        targetUrl: f.ready.targetUrl,
        targetBranch: "release",
        targetSha: target,
      },
    );
    f.finish();
    await f.tick();
    expect(f.row.state).toBe("WAITING_CI");
    expect(f.merge).not.toHaveBeenCalled();
    f.ready = { ...f.ready, ciPassed: true };
    await f.tick();
    expect(f.row.state).toBe("WAITING_REQUIREMENTS");
    f.ready = { ...f.ready, canMerge: true };
    expect(await f.tick()).toBe(true);
    expect(f.merge).toHaveBeenCalledExactlyOnceWith(rebased, target);
  });
  test("restarts with the same dispatch identity instead of duplicating a job", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    db.agentJob.findFirst.mockResolvedValue(f.job);
    await f.tick();
    expect(f.worktrees.createAutoSyncJob).not.toHaveBeenCalled();
    expect(readMergeSync(f.row.syncStateJson).jobId).toBe("job");
  });
  test("target advancement invalidates green CI and schedules another sync", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    await f.tick();
    f.finish();
    await f.tick();
    f.ready = {
      ...f.ready,
      targetSha: "d".repeat(40),
      ciPassed: true,
      canMerge: true,
    };
    await f.tick();
    expect(f.row.state).toBe("SYNCING");
    expect(readMergeSync(f.row.syncStateJson).requestId).toBeTruthy();
    expect(f.merge).not.toHaveBeenCalled();
  });
  test.each(["CONFLICT", "PREPARATION_CONFLICT"])(
    "pauses on %s for manual resolution",
    async (outcome) => {
      const f = fixture();
      await f.start();
      await f.tick();
      await f.tick();
      f.finish(outcome);
      await f.tick();
      expect(f.row.state).toBe("ACTION_REQUIRED");
      expect(f.merge).not.toHaveBeenCalled();
    },
  );
  test("runs the chosen workflow once and finalizes with the original source and target", async () => {
    const f = fixture();
    enableConflictWorkflow(f);
    f.ready = { ...f.ready, hasConflicts: true };
    await expect(f.start()).rejects.toThrow("Select a merge conflict workflow");
    await f.start({ conflictWorkflowId: "resolve" });
    await f.tick();
    await f.tick();
    f.job.status = "SUCCEEDED";
    f.job.resultJson = JSON.stringify({
      outcome: "CONFLICT",
      previousHeadSha: head,
      syncedTargetSha: target,
    });
    await f.tick();
    expect(f.row.state).toBe("RESOLVING");
    expect(f.workflows.trigger).toHaveBeenCalledExactlyOnceWith(
      {
        workflowId: "resolve",
        resourceKind: "WORKTREE",
        resourceId: "wt",
        subjectKey: "auto-merge-conflict:job",
        choice: null,
      },
      "auto-merge-conflict:job",
    );
    await f.tick();
    expect(f.worktrees.createAutoSyncJob).toHaveBeenCalledTimes(1);
    expect(f.merge).not.toHaveBeenCalled();

    f.workflowRun.status = "SUCCEEDED";
    f.job.status = "RUNNING";
    await f.tick();
    expect(f.row.state).toBe("SYNCING");
    await f.tick();
    expect(f.worktrees.createAutoSyncJob).toHaveBeenLastCalledWith(
      "wt",
      "FINALIZE",
      "feature",
      expect.any(String),
      false,
      expect.objectContaining({ expectedOrigin: f.ready.sourceOrigin }),
      expect.objectContaining({ expectedHeadSha: head, targetSha: target }),
    );
    f.finish();
    f.worktree.rebaseInProgress = true;
    f.ready = { ...f.ready, hasConflicts: false };
    await f.tick();
    expect(f.row.state).toBe("WAITING_CI");
    expect(f.merge).not.toHaveBeenCalled();
    f.worktree.rebaseInProgress = false;
    f.ready = { ...f.ready, ciPassed: true, canMerge: true };
    expect(await f.tick()).toBe(true);
    expect(f.merge).toHaveBeenCalledExactlyOnceWith(rebased, target);
  });
  test("pauses after a failed conflict workflow without dispatching finalization", async () => {
    const f = fixture();
    await startConflictedSync(f);
    await f.tick();
    f.workflowRun.status = "FAILED";
    await f.tick();
    expect(f.row.state).toBe("ACTION_REQUIRED");
    expect(f.worktrees.createAutoSyncJob).toHaveBeenCalledTimes(1);
    expect(f.merge).not.toHaveBeenCalled();
  });
  test("does not start a workflow after the target moved from the conflicted rebase", async () => {
    const f = fixture();
    await startConflictedSync(f);
    f.ready = { ...f.ready, targetSha: "d".repeat(40) };
    await f.tick();
    expect(f.row.state).toBe("ACTION_REQUIRED");
    expect(f.workflows.trigger).not.toHaveBeenCalled();
    expect(f.merge).not.toHaveBeenCalled();
  });
  test.each<[string, Partial<MergeSyncReadiness>]>([
    ["the target moves", { targetSha: "d".repeat(40) }],
    ["the request closes", { state: "CLOSED" }],
    ["the request is retargeted", { targetBranch: "other" }],
    ["native Auto Merge is enabled", { nativeAutoMerge: true }],
  ])(
    "stops a running conflict workflow when %s",
    async (_reason, readiness) => {
      const f = fixture();
      await startConflictedSync(f);
      await f.tick();
      f.ready = { ...f.ready, ...readiness };
      expect(await f.tick()).toBe(false);
      expect(f.row.state).toBe("ACTION_REQUIRED");
      expect(f.workflows.lifecycle).toHaveBeenCalledExactlyOnceWith(
        "resolution-run",
        "CANCEL",
        { ignoreMissing: true },
      );
      expect(f.worktrees.createAutoSyncJob).toHaveBeenCalledTimes(1);
    },
  );
  test("stops the conflict workflow before accepting an external merge", async () => {
    const f = fixture();
    await startConflictedSync(f);
    await f.tick();
    f.ready = { ...f.ready, state: "MERGED" };
    f.workflows.lifecycle.mockRejectedValueOnce(new Error("Cancel failed"));
    expect(await f.tick()).toBe(false);
    expect(f.row.state).toBe("RESOLVING");
    expect(await f.tick()).toBe(true);
    expect(f.workflows.lifecycle).toHaveBeenCalledTimes(2);
  });
  test.each(["before", "after"])(
    "pauses if the target moves %s finalizing the conflict",
    async (timing) => {
      const f = fixture();
      await startConflictedSync(f);
      await f.tick();
      f.workflowRun.status = "SUCCEEDED";
      f.job.status = "RUNNING";
      await f.tick();
      if (timing === "after") {
        await f.tick();
        f.finish();
      }
      f.ready = {
        ...f.ready,
        targetSha: "d".repeat(40),
        ciPassed: true,
        canMerge: true,
      };
      await f.tick();
      expect(f.row.state).toBe("ACTION_REQUIRED");
      expect(f.worktrees.createAutoSyncJob).toHaveBeenCalledTimes(
        timing === "before" ? 1 : 2,
      );
      expect(f.merge).not.toHaveBeenCalled();
    },
  );
  test("rejects unrelated source commits and retargeting", async () => {
    const f = fixture();
    await f.start();
    f.ready = { ...f.ready, headSha: rebased };
    await f.tick();
    expect(f.row.state).toBe("ACTION_REQUIRED");
    expect(f.worktrees.createAutoSyncJob).not.toHaveBeenCalled();
    f.ready = { ...f.ready, headSha: head };
    await f.start();
    f.ready = { ...f.ready, targetBranch: "other" };
    await f.tick();
    expect(f.row.state).toBe("ACTION_REQUIRED");
  });
  test("rejects an unrelated push after its sync job finishes", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    await f.tick();
    f.finish();
    f.ready = { ...f.ready, headSha: "e".repeat(40) };
    await f.tick();
    expect(f.row.state).toBe("ACTION_REQUIRED");
    expect(readMergeSync(f.row.syncStateJson).headSha).toBe(head);
  });
  test("does not repeat an uncertain merge submission after restart", async () => {
    const f = fixture();
    await f.start();
    f.row.state = "MERGING";
    await f.tick();
    expect(f.merge).not.toHaveBeenCalled();
    f.row.updatedAt = new Date(Date.now() - 121_000);
    await f.tick();
    expect(f.row.state).toBe("ACTION_REQUIRED");
  });
  test("cancels its active job", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    await f.tick();
    await cancelMergeSync(
      f.row.syncStateJson,
      f.agents as unknown as AgentControlService,
    );
    expect(f.agents.cancelJob).toHaveBeenCalledWith("job");
  });
  test("cancels a conflict workflow started before its ID was saved", async () => {
    const f = fixture();
    await startConflictedSync(f);
    db.workflowRun.findUnique.mockResolvedValue({ id: "resolution-run" });
    await cancelMergeSync(
      f.row.syncStateJson,
      f.agents as unknown as AgentControlService,
      f.workflows,
    );
    expect(db.workflowRun.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { idempotencyKey: "auto-merge-conflict:job" },
      select: { id: true },
    });
    expect(f.workflows.lifecycle).toHaveBeenCalledExactlyOnceWith(
      "resolution-run",
      "CANCEL",
      { ignoreMissing: true },
    );
  });
  test("temporary agent unavailability preserves the dispatch request", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    const requestId = readMergeSync(f.row.syncStateJson).requestId;
    f.worktrees.createAutoSyncJob.mockRejectedValueOnce(
      new Error("Agent is offline"),
    );
    await f.tick();
    expect(f.row.state).toBe("SYNCING");
    expect(readMergeSync(f.row.syncStateJson).requestId).toBe(requestId);
  });
  test("codebase contention preserves its dispatch request and resumes automatically", async () => {
    const f = fixture();
    await f.start();
    await f.tick();
    const requestId = readMergeSync(f.row.syncStateJson).requestId;
    f.worktrees.createAutoSyncJob.mockRejectedValueOnce(
      new CodebaseBusyError(),
    );
    await f.tick();
    expect(f.row.state).toBe("SYNCING");
    expect(readMergeSync(f.row.syncStateJson).requestId).toBe(requestId);
    await f.tick();
    expect(readMergeSync(f.row.syncStateJson).jobId).toBe("job");
  });
  test("requires a capable matching worktree and leaves standalone settings intact", async () => {
    const f = fixture();
    f.worktree.codebase.agent.capabilitiesJson = "[]";
    expect(await mergeSyncUnavailableReason("wt")).toContain(
      "Update the agent",
    );
    await expect(f.start()).rejects.toThrow("Update the agent");
    f.worktree.codebase.agent.capabilitiesJson = JSON.stringify([
      WORKTREE_REVIEWED_SYNC_CAPABILITY,
    ]);
    db.worktreeAutoSync.findUnique.mockResolvedValue({
      activeJobId: "standalone",
    });
    await expect(f.start()).rejects.toThrow("active Auto Sync");
    expect(db.worktreeAutoSync.findUnique).toHaveBeenCalled();
  });
  test("blocks another provider from taking the same worktree", async () => {
    const f = fixture();
    db.gitLabMergeOperation.findFirst.mockResolvedValue({ id: "other" });
    await expect(f.start()).rejects.toThrow("Another Auto Merge");
  });
});
