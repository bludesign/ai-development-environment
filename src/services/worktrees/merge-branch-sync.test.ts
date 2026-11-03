import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentControlService } from "@/services/agent-control";
import type { WorktreesService } from "./worktrees.service";
import { WORKTREE_REVIEWED_SYNC_CAPABILITY } from "@ai-development-environment/agent-contract/worktrees";

const db = vi.hoisted(() => ({
  worktree: { findUnique: vi.fn() },
  worktreeAutoSync: { findUnique: vi.fn() },
  worktreeAutoMerge: { findFirst: vi.fn() },
  gitLabMergeOperation: { findFirst: vi.fn() },
  agentJob: { findFirst: vi.fn() },
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
    availability: "AVAILABLE",
    missingAt: null,
    codebase: {
      agentId: "agent",
      agent: {
        capabilitiesJson: JSON.stringify([WORKTREE_REVIEWED_SYNC_CAPABILITY]),
      },
      repository: { canonicalOrigin: ready.sourceOrigin },
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
      save,
      merge,
    });
  const start = async () => {
    row.syncStateJson = await prepareMergeSync("wt", ready, {
      provider: "GITHUB",
      id: "wt",
    });
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
});

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
