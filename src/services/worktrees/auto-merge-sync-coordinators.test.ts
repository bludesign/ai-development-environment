import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  GitLabMergeOperation,
  WorktreeAutoMerge,
} from "@/generated/prisma/client";
import type { GitHubService } from "@/services/github";
import type { GitLabService, GitLabMergeOptions } from "@/services/gitlab";
import type { JiraService } from "@/services/jira";
import type { AgentControlService } from "@/services/agent-control";
import type { WorkflowsService } from "@/services/workflows";
import type { WorktreesService } from "./worktrees.service";
import { WORKTREE_REVIEWED_SYNC_CAPABILITY } from "@ai-development-environment/agent-contract/worktrees";

const db = vi.hoisted(() => ({
  github: null as WorktreeAutoMerge | null,
  gitlab: null as GitLabMergeOperation | null,
  worktree: { findFirst: vi.fn(), findUnique: vi.fn() },
  worktreeAutoMerge: {
    delete: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  gitLabMergeOperation: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  worktreeAutoSync: { findUnique: vi.fn() },
  agentJob: { findFirst: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({ getPrismaClient: async () => db }));
vi.mock("@/services/integration-configuration-events", () => ({
  publishIntegrationConfiguration: vi.fn(),
}));
import { WorktreeAutomationService } from "./worktree-automation.service";
import { GitLabMergeService } from "@/services/gitlab/gitlab-merge.service";
import type { MergeSyncReadiness } from "./merge-branch-sync";

const head = "a".repeat(40),
  target = "b".repeat(40),
  synced = "c".repeat(40);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  db.github = null;
  db.gitlab = null;
  db.worktreeAutoSync.findUnique.mockResolvedValue(null);
  db.agentJob.findFirst.mockResolvedValue(null);
  db.worktreeAutoMerge.findUnique.mockImplementation(async () => db.github);
  db.worktreeAutoMerge.delete.mockImplementation(async () => {
    const previous = db.github;
    db.github = null;
    return previous;
  });
  db.worktreeAutoMerge.findFirst.mockResolvedValue(null);
  db.worktreeAutoMerge.findMany.mockImplementation(async () =>
    db.github
      ? [{ ...db.github, worktree: await db.worktree.findUnique() }]
      : [],
  );
  db.worktreeAutoMerge.upsert.mockImplementation(
    async ({ create, update }) =>
      (db.github = {
        ...(db.github ? { ...db.github, ...update } : create),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
  );
  db.worktreeAutoMerge.update.mockImplementation(
    async ({ data }) =>
      (db.github = { ...db.github, ...data, updatedAt: new Date() }),
  );
  db.gitLabMergeOperation.findUnique.mockImplementation(async () => db.gitlab);
  db.gitLabMergeOperation.findUniqueOrThrow.mockImplementation(
    async () => db.gitlab,
  );
  db.gitLabMergeOperation.findFirst.mockResolvedValue(null);
  db.gitLabMergeOperation.findMany.mockImplementation(async () =>
    db.gitlab ? [db.gitlab] : [],
  );
  db.gitLabMergeOperation.upsert.mockImplementation(
    async ({ create, update }) =>
      (db.gitlab = {
        ...(db.gitlab ? { ...db.gitlab, ...update } : create),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
  );
  db.gitLabMergeOperation.update.mockImplementation(
    async ({ data }) =>
      (db.gitlab = { ...db.gitlab, ...data, updatedAt: new Date() }),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture(provider: "GITHUB" | "GITLAB") {
  const origin =
    provider === "GITHUB" ? "github.com/team/repo" : "gitlab.test/team/repo";
  const ready: MergeSyncReadiness = {
    state: "OPEN",
    headSha: head,
    sourceOrigin: origin,
    sourceBranch: "feature",
    targetOrigin: origin,
    targetUrl: `https://${origin}.git`,
    targetBranch: "main",
    targetSha: target,
    ciPassed: false,
    canMerge: false,
    nativeAutoMerge: false,
  };
  const worktree = {
    id: "wt",
    codebaseId: "cb",
    primary: false,
    folder: "/wt",
    gitDirectory: "/git",
    branch: "feature",
    headSha: head,
    availability: "AVAILABLE",
    missingAt: null,
    codebase: {
      agentId: "agent",
      repository: { canonicalOrigin: origin },
      agent: {
        capabilitiesJson: JSON.stringify([WORKTREE_REVIEWED_SYNC_CAPABILITY]),
      },
    },
  };
  db.worktree.findFirst.mockResolvedValue(worktree);
  db.worktree.findUnique.mockResolvedValue(worktree);
  const job = {
    id: "sync-job",
    status: "RUNNING",
    resultJson: null as string | null,
    error: null,
  };
  const worktrees = {
    ticketKeyForWorktree: vi.fn().mockResolvedValue(null),
    publishAutomationChange: vi.fn(),
    createAutoSyncJob: vi.fn().mockResolvedValue(job),
  };
  const agents = {
    registerCompletionObserver: vi.fn(),
    getJob: vi.fn(async () => job),
    cancelJob: vi.fn(),
  };
  const mr = {
    projectId: "p",
    iid: 1,
    sourceProjectId: "p",
    sourceBranch: "feature",
    targetBranch: "main",
    state: "OPENED",
    sha: head,
  };
  const merge = vi.fn(async (_input: unknown) => {
    ready.state = "MERGED";
    mr.state = "MERGED";
    return mr;
  });
  const nativeEnable = vi.fn(),
    nativeDisable = vi.fn(async () => {
      ready.nativeAutoMerge = false;
    });
  const github = {
    pullRequestAutomationState: vi.fn(async () => ({
      state: ready.state,
      headRefName: "feature",
      headRefOid: ready.headSha,
      headRepositoryNameWithOwner: "team/repo",
      autoMergeEnabled: ready.nativeAutoMerge,
    })),
    managedMergeReadiness: vi.fn(async () => ({ ...ready })),
    pullRequestMergeOptions: vi
      .fn()
      .mockResolvedValue({ availableMethods: ["SQUASH"] }),
    enablePullRequestAutoMerge: nativeEnable,
    disablePullRequestAutoMerge: nativeDisable,
    mergePullRequest: merge,
  };
  const gitlab = {
    getSettings: vi
      .fn()
      .mockResolvedValue({ configured: true, baseUrl: "https://gitlab.test" }),
    setMergeCoordinator: vi.fn(),
    managedMergeReadiness: vi.fn(async () => ({ ...ready })),
    mergeRequestState: vi.fn(async () => ({ ...mr })),
    mergeMergeRequestDirect: merge,
    cancelAutoMergeDirect: nativeDisable,
  };
  const githubService = new WorktreeAutomationService(
    worktrees as unknown as WorktreesService,
    github as unknown as GitHubService,
    {} as JiraService,
    {} as WorkflowsService,
    agents as unknown as AgentControlService,
  );
  vi.spyOn(
    githubService as unknown as { changed(): void },
    "changed",
  ).mockImplementation(() => {});
  const gitlabService = new GitLabMergeService(
    gitlab as unknown as GitLabService,
    worktrees as unknown as WorktreesService,
    {} as JiraService,
    agents as unknown as AgentControlService,
  );
  vi.spyOn(gitlabService, "wake").mockImplementation(() => {});
  vi.spyOn(gitlabService, "options").mockResolvedValue({
    worktreeId: "wt",
    sha: head,
    canAutoMergeWithSync: true,
    canMerge: false,
    canAutoMerge: false,
    squashPolicy: "default_off",
    squash: false,
    canRemoveSourceBranch: true,
    removeSourceBranch: false,
    canDeleteWorktree: true,
  } as GitLabMergeOptions);
  vi.spyOn(
    gitlabService as unknown as { context(): Promise<unknown> },
    "context",
  ).mockResolvedValue({ sourceOrigin: origin, worktree });
  const configure = () =>
    provider === "GITHUB"
      ? githubService.configureAutoMerge({
          worktreeId: "wt",
          repositoryNameWithOwner: "team/repo",
          pullRequestNumber: 1,
          method: "SQUASH",
          commitHeadline: "Merge",
          commitBody: "",
          deleteWorktree: false,
          moveTicketToDone: false,
          autoSync: true,
          expectedHeadSha: head,
        })
      : gitlabService.submit({
          projectId: "p",
          iid: 1,
          sha: head,
          autoMerge: true,
          autoSync: true,
          worktreeId: "wt",
        });
  const tick = () =>
    provider === "GITHUB"
      ? (
          githubService as unknown as { reconcileAutoMerge(): Promise<void> }
        ).reconcileAutoMerge()
      : gitlabService.reconcile();
  const row = () => (provider === "GITHUB" ? db.github : db.gitlab);
  const finish = () => {
    job.status = "SUCCEEDED";
    job.resultJson = JSON.stringify({
      outcome: "SYNCED",
      previousHeadSha: head,
      syncedHeadSha: synced,
      syncedTargetSha: target,
    });
    ready.headSha = synced;
    mr.sha = synced;
    worktree.headSha = synced;
  };
  return {
    configure,
    cancel: () =>
      provider === "GITHUB"
        ? githubService.cancelAutoMerge("wt")
        : gitlabService.cancel("p", 1),
    agents,
    tick,
    row,
    ready,
    finish,
    merge,
    nativeEnable,
    nativeDisable,
    worktrees,
  };
}

describe.each(["GITHUB", "GITLAB"] as const)(
  "%s managed Auto Merge",
  (provider) => {
    test("cancellation reconciles a merge accepted before a timeout", async () => {
      const f = fixture(provider);
      await f.configure();
      await f.tick();
      await f.tick();
      f.finish();
      f.ready.ciPassed = true;
      f.ready.canMerge = true;
      const original = f.merge.getMockImplementation()!;
      f.merge.mockImplementationOnce(async (input) => {
        await original(input);
        throw new Error("network timeout");
      });
      await f.tick();
      expect(f.row()?.state).toBe("MERGING");
      await f.cancel();
      if (provider === "GITHUB") await f.tick();
      expect(f.row()?.state).toBe("COMPLETED");
      expect(f.merge).toHaveBeenCalledOnce();
    });
    test("cancellation stops its pending sync and prevents a later merge", async () => {
      const f = fixture(provider);
      await f.configure();
      await f.tick();
      await f.tick();
      await f.cancel();
      expect(f.agents.cancelJob).toHaveBeenCalledWith("sync-job");
      f.finish();
      f.ready.ciPassed = true;
      f.ready.canMerge = true;
      await f.tick();
      expect(f.merge).not.toHaveBeenCalled();
    });
    test("persists intent, avoids duplicate syncs, waits for CI, and merges the verified new SHA", async () => {
      const f = fixture(provider);
      await f.configure();
      await f.configure();
      expect(f.row()).toMatchObject({ autoSync: true, state: "SYNCING" });
      expect(f.nativeEnable).not.toHaveBeenCalled();
      expect(f.merge).not.toHaveBeenCalled();
      await f.tick();
      await f.tick();
      expect(f.worktrees.createAutoSyncJob).toHaveBeenCalledOnce();
      f.finish();
      await f.tick();
      expect(f.row()?.state).toBe("WAITING_CI");
      expect(f.merge).not.toHaveBeenCalled();
      f.ready.ciPassed = true;
      f.ready.canMerge = true;
      await f.tick();
      expect(f.merge).toHaveBeenCalledOnce();
      expect(f.merge.mock.calls[0]?.[0]).toMatchObject(
        provider === "GITHUB"
          ? { expectedHeadSha: synced, expectedTargetSha: target }
          : { sha: synced, autoMerge: false },
      );
      if (provider === "GITHUB") await f.tick();
      expect(f.row()?.state).toBe("COMPLETED");
    });
    test("saves intent before disabling an existing native auto-merge request", async () => {
      const f = fixture(provider);
      f.ready.nativeAutoMerge = true;
      await f.configure();
      const persisted =
        provider === "GITHUB"
          ? db.worktreeAutoMerge.upsert
          : db.gitLabMergeOperation.upsert;
      expect(persisted.mock.invocationCallOrder[0]).toBeLessThan(
        f.nativeDisable.mock.invocationCallOrder[0]!,
      );
      expect(f.ready.nativeAutoMerge).toBe(false);
      expect(f.merge).not.toHaveBeenCalled();
    });
  },
);
