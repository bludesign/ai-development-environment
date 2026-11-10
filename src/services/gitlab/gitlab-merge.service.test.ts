import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { GitLabMergeOperation } from "@/generated/prisma/client";
import type { GitLabService } from "./gitlab.service";
import { GitLabRequestError } from "./gitlab.service";
import type { WorktreesService } from "@/services/worktrees";
import type { JiraService } from "@/services/jira";
import type { AgentControlService } from "@/services/agent-control";
import type { WorkflowsService } from "@/services/workflows";
import { unknownMergeOutcome } from "@/services/worktrees/bulk-merge-review";
import type { GitLabMergeOptions, GitLabMergeRequestView } from "./types";

vi.mock("@/services/operation-locks/operation-locks.service", () => ({
  mergeReservationBlockedReason: vi.fn(async () => null),
  recoverMergeReservations: vi.fn(async () => {}),
}));

const database = vi.hoisted(() => ({
  row: null as GitLabMergeOperation | null,
  gitLabMergeOperation: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  worktree: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(),
  },
  agentJob: { findFirst: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => database,
}));
vi.mock("@/services/integration-configuration-events", () => ({
  publishIntegrationConfiguration: vi.fn(),
}));
import { GitLabMergeService, gitLabMergeBlocker } from "./gitlab-merge.service";
import { CodebaseBusyError } from "@/lib/codebase-busy";
import {
  LEGACY_CODEBASE_BUSY_MESSAGE,
  MergeSyncNotSubmittedError,
} from "@/services/worktrees/merge-branch-sync";

const mr: GitLabMergeRequestView = {
  id: "101",
  projectId: "7",
  sourceProjectId: "8",
  iid: 3,
  title: "[AIDE-145] Improve GitLab",
  description: "",
  state: "OPENED",
  draft: false,
  webUrl: "https://gitlab.test/team/repo/-/merge_requests/3",
  sourceBranch: "feature/AIDE-145",
  targetBranch: "main",
  sha: "abc",
  author: {
    id: "1",
    username: "user",
    name: "User",
    webUrl: "https://gitlab.test/user",
    avatarUrl: null,
  },
  reviewers: [],
  labels: [],
  detailedMergeStatus: "mergeable",
  mergeWhenPipelineSucceeds: false,
  squashOnMerge: false,
  hasConflicts: false,
  blockingDiscussionsResolved: true,
  createdAt: "2026-09-28T00:00:00Z",
  updatedAt: "2026-09-28T00:00:00Z",
  mergedAt: null,
};
const options: GitLabMergeOptions = {
  projectId: "7",
  iid: 3,
  title: mr.title,
  state: "OPENED",
  sha: "abc",
  sourceBranch: mr.sourceBranch,
  targetBranch: "main",
  mergeMethod: "merge",
  squashPolicy: "default_off",
  squash: false,
  removeSourceBranch: false,
  canRemoveSourceBranch: true,
  canMerge: true,
  canAutoMerge: true,
  canCancelAutoMerge: false,
  autoMergeEnabled: false,
  mergeBlockedReason: null,
  autoMergeBlockedReason: null,
  mergeCommitMessage: null,
  squashCommitMessage: null,
  worktreeId: null,
  worktreeFolder: null,
  canDeleteWorktree: false,
  ticketKey: "AIDE-145",
  ticketDoneStatusConfigured: true,
  defaultMoveTicketToDone: false,
  defaultDeleteWorktree: false,
  operation: null,
};
const input = { projectId: "7", iid: 3, sha: "abc" };
const bulkReview = {
  itemId: "item",
  headSha: mr.sha,
  sourceBranch: mr.sourceBranch,
  sourceOrigin: "gitlab.test/team/repo",
  targetBranch: mr.targetBranch,
  instanceUrl: "https://gitlab.test",
};

function setup() {
  const gitlab = {
    setMergeCoordinator: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({
      configured: true,
      baseUrl: "https://gitlab.test",
      viewer: null,
      defaultSquash: true,
      defaultMoveTicketToDone: false,
      defaultDeleteWorktree: false,
    }),
    mergeReadiness: vi.fn().mockResolvedValue({
      mr,
      project: { squash_option: "default_off", merge_method: "merge" },
      canMerge: true,
      autoMergeUserId: null,
      removeSourceBranch: false,
      forceRemoveSourceBranch: false,
    }),
    mergeRequestState: vi.fn().mockResolvedValue({ ...mr, state: "MERGED" }),
    mergeMergeRequestDirect: vi
      .fn()
      .mockResolvedValue({ ...mr, state: "MERGED" }),
    mergeProject: vi.fn().mockResolvedValue({
      web_url: "https://gitlab.test/team/repo",
      merge_method: "merge",
      automatic_rebase_enabled: false,
    }),
    cancelAutoMergeDirect: vi.fn().mockResolvedValue(undefined),
  };
  const jira = {
    transitionTicketToConfiguredDone: vi.fn().mockResolvedValue(undefined),
    transitionTicketToConfiguredAutoMerge: vi.fn().mockResolvedValue(null),
  };
  const worktrees = {
    publishAutomationChange: vi.fn(),
    deleteWorktree: vi.fn().mockResolvedValue({ id: "job-1" }),
    postMergeSwitch: vi.fn().mockResolvedValue({ id: "switch-job" }),
  };
  const agents = {
    registerCompletionObserver: vi.fn(),
    registerConnectionHandler: vi.fn(),
    getJob: vi.fn().mockResolvedValue({ id: "job-1", status: "RUNNING" }),
  };
  const workflows = { lifecycle: vi.fn() };
  const service = new GitLabMergeService(
    gitlab as unknown as GitLabService,
    worktrees as unknown as WorktreesService,
    jira as unknown as JiraService,
    agents as unknown as AgentControlService,
    workflows as unknown as WorkflowsService,
  );
  vi.spyOn(service, "wake").mockImplementation(() => {});
  vi.spyOn(service, "options").mockResolvedValue({ ...options });
  const context = vi
    .spyOn(service as unknown as { context: () => Promise<unknown> }, "context")
    .mockResolvedValue({
      sourceOrigin: "gitlab.test/fork/repo",
      targetOrigin: "gitlab.test/team/repo",
      projectPath: "team/repo",
      worktree: null,
      ticketKey: "AIDE-145",
      ticketDoneStatusConfigured: true,
    });
  return { service, gitlab, jira, worktrees, agents, context, workflows };
}

function setupPrimarySwitch(
  policy: {
    mergeMethod: string;
    automaticRebaseEnabled: boolean | undefined;
  } = {
    mergeMethod: "merge",
    automaticRebaseEnabled: false,
  },
) {
  const fixture = setup();
  const primary = {
    id: "primary",
    codebaseId: "checkout",
    folder: "/checkout",
    gitDirectory: "/checkout/.git",
    primary: true,
    missingAt: null,
    availability: "AVAILABLE",
    branch: mr.sourceBranch,
    headSha: mr.sha,
    codebase: {
      defaultBranch: "main",
      repository: { canonicalOrigin: "gitlab.test/team/repo" },
      agent: {
        capabilitiesJson: JSON.stringify(["worktree.post-merge-switch"]),
      },
    },
  };
  database.worktree.findUnique.mockResolvedValue(primary);
  database.worktree.findUniqueOrThrow.mockResolvedValue(primary);
  fixture.context.mockResolvedValue({
    sourceOrigin: "gitlab.test/team/repo",
    targetOrigin: "gitlab.test/team/repo",
    targetMergeMethod: policy.mergeMethod,
    automaticRebaseEnabled: policy.automaticRebaseEnabled,
    projectPath: "team/repo",
    worktree: primary,
    ticketKey: "AIDE-145",
    ticketDoneStatusConfigured: true,
  });
  vi.mocked(fixture.service.options).mockResolvedValue({
    ...options,
    worktreeId: primary.id,
    worktreeFolder: primary.folder,
  });
  return { ...fixture, primary };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  database.row = null;
  database.gitLabMergeOperation.findUnique.mockImplementation(
    async () => database.row,
  );
  database.gitLabMergeOperation.findMany.mockImplementation(async () =>
    database.row ? [database.row] : [],
  );
  database.gitLabMergeOperation.upsert.mockImplementation(
    async ({ create, update }) => {
      database.row = {
        ...(database.row ? { ...database.row, ...update } : create),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as GitLabMergeOperation;
      return database.row;
    },
  );
  database.gitLabMergeOperation.update.mockImplementation(async ({ data }) => {
    database.row = {
      ...database.row,
      ...data,
      updatedAt: new Date(),
    } as GitLabMergeOperation;
    return database.row;
  });
  database.agentJob.findFirst.mockResolvedValue(null);
  database.worktree.findUnique.mockReset();
  database.worktree.findUniqueOrThrow.mockReset();
  database.worktree.findMany.mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("merge readiness", () => {
  test("distinguishes immediate blockers from requirements native auto-merge may wait for", () => {
    expect(
      gitLabMergeBlocker(
        { ...mr, detailedMergeStatus: "ci_still_running" },
        true,
      ),
    ).toContain("running");
    expect(
      gitLabMergeBlocker(
        { ...mr, detailedMergeStatus: "ci_still_running" },
        true,
        true,
      ),
    ).toBeNull();
    for (const value of [
      { ...mr, draft: true },
      { ...mr, hasConflicts: true },
      { ...mr, state: "CLOSED" },
      { ...mr, detailedMergeStatus: "unchecked" },
    ]) {
      expect(gitLabMergeBlocker(value, true, true)).toBeTruthy();
    }
    expect(gitLabMergeBlocker(mr, false)).toContain("cannot merge");
    expect(
      gitLabMergeBlocker({ ...mr, detailedMergeStatus: "future_policy" }, true),
    ).toBeTruthy();
  });
});

describe("returning the primary checkout after merge", () => {
  const switchInput = {
    ...input,
    worktreeId: "primary",
    switchToDefaultBranch: true,
  };

  test("selects the option for eligible primary checkouts and preserves an explicit opt-out", async () => {
    const { service } = setupPrimarySwitch();
    vi.mocked(service.options).mockRestore();
    expect(await service.options("7", 3)).toMatchObject({
      canSwitchToDefaultBranch: true,
      defaultSwitchToDefaultBranch: true,
      switchToDefaultBranchName: "main",
    });
    await service.submit(input);
    expect(await service.options("7", 3)).toMatchObject({
      defaultSwitchToDefaultBranch: false,
    });
  });

  test("persists the switch before merging, uses the merge result and waits before Jira", async () => {
    const { service, gitlab, worktrees, jira, agents } = setupPrimarySwitch();
    const merged = {
      ...mr,
      state: "MERGED",
      mergeCommitSha: "merge-result",
      squashCommitSha: "squash-result",
    };
    gitlab.mergeMergeRequestDirect.mockImplementationOnce(async () => {
      expect(JSON.parse(database.row!.postMergeSwitchJson!)).toMatchObject({
        expectedBranch: mr.sourceBranch,
        expectedHeadSha: mr.sha,
        branch: "main",
        expectedOrigin: "gitlab.test/team/repo",
      });
      return merged;
    });
    gitlab.mergeRequestState.mockResolvedValue(merged);
    const result = await service.submit({
      ...switchInput,
      squash: true,
      moveTicketToDone: true,
    });
    expect(result.operation?.state).toBe("POST_MERGE");
    expect(result.operation?.postMergeSwitch?.state).toBe("UPDATING");
    expect(worktrees.postMergeSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: "primary",
        expectedBranch: mr.sourceBranch,
        expectedHeadSha: mr.sha,
        branch: "main",
        mergeCommitSha: "merge-result",
      }),
    );
    expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
    agents.getJob.mockResolvedValue({ id: "switch-job", status: "SUCCEEDED" });
    await service.reconcile();
    expect(database.row?.state).toBe("COMPLETED");
    expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
    expect(worktrees.postMergeSwitch).toHaveBeenCalledOnce();
    expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  });

  test("uses the squash result for squash with fast-forward and a removed remote source", async () => {
    const { service, gitlab, worktrees } = setupPrimarySwitch();
    gitlab.mergeProject.mockResolvedValue({
      web_url: "https://gitlab.test/team/repo",
      merge_method: "ff",
      automatic_rebase_enabled: true,
    });
    gitlab.mergeRequestState.mockResolvedValue({
      ...mr,
      state: "MERGED",
      squashOnMerge: true,
      squashCommitSha: "squash-result",
    });
    await service.submit({
      ...switchInput,
      squash: true,
      removeSourceBranch: true,
    });
    expect(worktrees.postMergeSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ mergeCommitSha: "squash-result" }),
    );
    expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledWith(
      expect.objectContaining({ removeSourceBranch: true }),
    );
  });

  test.each([false, true, undefined])(
    "only falls back to source SHA when fast-forward automatic rebasing is explicitly disabled (%s)",
    async (automaticRebase) => {
      const { service, gitlab, worktrees } = setupPrimarySwitch({
        mergeMethod: "ff",
        automaticRebaseEnabled: automaticRebase,
      });
      gitlab.mergeProject.mockResolvedValue({
        web_url: "https://gitlab.test/team/repo",
        merge_method: "ff",
        automatic_rebase_enabled: automaticRebase,
      });
      await service.submit(switchInput);
      if (automaticRebase === false) {
        expect(worktrees.postMergeSwitch).toHaveBeenCalledWith(
          expect.objectContaining({ mergeCommitSha: mr.sha }),
        );
      } else {
        expect(worktrees.postMergeSwitch).not.toHaveBeenCalled();
        expect(database.row?.state).toBe("POST_MERGE");
      }
    },
  );

  test("does not loosen fast-forward evidence when automatic rebase is disabled after waiting", async () => {
    const { service, gitlab, worktrees } = setupPrimarySwitch({
      mergeMethod: "ff",
      automaticRebaseEnabled: true,
    });
    gitlab.mergeRequestState.mockResolvedValue(mr);
    await service.submit({ ...switchInput, autoMerge: true });
    expect(database.row?.state).toBe("WAITING_REQUIREMENTS");
    gitlab.mergeReadiness.mockResolvedValue({
      mr: { ...mr, state: "MERGED" },
      project: { squash_option: "default_off", merge_method: "ff" },
      canMerge: true,
      autoMergeUserId: null,
      removeSourceBranch: false,
      forceRemoveSourceBranch: false,
    });
    gitlab.mergeRequestState.mockResolvedValue({ ...mr, state: "MERGED" });
    gitlab.mergeProject.mockResolvedValue({
      web_url: "https://gitlab.test/team/repo",
      merge_method: "ff",
      automatic_rebase_enabled: false,
    });
    await service.reconcile();
    expect(database.row?.state).toBe("POST_MERGE");
    expect(worktrees.postMergeSwitch).not.toHaveBeenCalled();
    expect(gitlab.mergeMergeRequestDirect).not.toHaveBeenCalled();
  });

  test("waits for delayed result metadata, then reports a follow-up timeout without resubmitting", async () => {
    const { service, gitlab, worktrees } = setupPrimarySwitch();
    await service.submit(switchInput);
    expect(database.row?.state).toBe("POST_MERGE");
    expect(worktrees.postMergeSwitch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    await service.reconcile();
    expect(database.row?.state).toBe("ACTION_REQUIRED");
    expect(database.row?.lastError).toContain("resulting commit");
    gitlab.mergeRequestState.mockResolvedValue({
      ...mr,
      state: "MERGED",
      mergeCommitSha: "late-result",
    });
    await service.retryFollowUps("7", 3);
    expect(worktrees.postMergeSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ mergeCommitSha: "late-result" }),
    );
    expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  });

  test("refuses a request retargeted while waiting even if its source is unchanged", async () => {
    const { service, gitlab, worktrees } = setupPrimarySwitch();
    const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
    gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
    gitlab.mergeRequestState.mockResolvedValue(waiting);
    await service.submit(switchInput);
    gitlab.mergeRequestState.mockResolvedValue({
      ...mr,
      state: "MERGED",
      targetBranch: "develop",
      mergeCommitSha: "different-target-result",
    });
    await service.reconcile();
    expect(database.row?.state).toBe("ACTION_REQUIRED");
    expect(database.row?.lastError).toContain("target");
    expect(worktrees.postMergeSwitch).not.toHaveBeenCalled();
  });

  test("does not switch a checkout when managed auto-merge accepted a newer unsynced source", async () => {
    const { service, gitlab, worktrees } = setupPrimarySwitch();
    gitlab.mergeRequestState.mockResolvedValue(mr);
    await service.submit({ ...switchInput, autoMerge: true });
    const newer = { ...mr, sha: "newer-source" };
    gitlab.mergeReadiness.mockResolvedValue({
      mr: newer,
      project: { squash_option: "default_off", merge_method: "merge" },
      canMerge: true,
      autoMergeUserId: null,
      removeSourceBranch: false,
      forceRemoveSourceBranch: false,
    });
    const merged = {
      ...newer,
      state: "MERGED",
      mergeCommitSha: "merge-result",
    };
    gitlab.mergeMergeRequestDirect.mockResolvedValue(merged);
    gitlab.mergeRequestState.mockResolvedValue(merged);
    await service.reconcile();
    expect(database.row?.state).toBe("ACTION_REQUIRED");
    expect(database.row?.lastError).toContain("source or target");
    expect(worktrees.postMergeSwitch).not.toHaveBeenCalled();
    expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  });

  test("retries a failed switch without another merge or repeating completed follow-ups", async () => {
    const { service, gitlab, worktrees, agents } = setupPrimarySwitch();
    gitlab.mergeRequestState.mockResolvedValue({
      ...mr,
      state: "MERGED",
      mergeCommitSha: "merge-result",
    });
    await service.submit(switchInput);
    agents.getJob.mockResolvedValue({
      id: "switch-job",
      status: "FAILED",
      error: "Uncommitted changes prevent switching",
    });
    await service.reconcile();
    expect(database.row?.state).toBe("ACTION_REQUIRED");
    expect(database.row?.lastError).toContain("Uncommitted changes");
    const original = JSON.parse(database.row!.postMergeSwitchJson!).requestId;
    worktrees.postMergeSwitch.mockResolvedValue({ id: "retried-job" });
    agents.getJob.mockImplementation(async (id) => ({
      id,
      status: id === "switch-job" ? "FAILED" : "SUCCEEDED",
    }));
    await service.retryFollowUps("7", 3);
    expect(database.row?.state).toBe("COMPLETED");
    expect(worktrees.postMergeSwitch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(database.row!.postMergeSwitchJson!).requestId).not.toBe(
      original,
    );
    expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  });

  test("recovers a completed job after main is projected without rediscovering the source branch", async () => {
    const { service, gitlab, worktrees, agents, primary, context } =
      setupPrimarySwitch();
    gitlab.mergeRequestState.mockResolvedValue({
      ...mr,
      state: "MERGED",
      mergeCommitSha: "merge-result",
    });
    await service.submit(switchInput);
    agents.getJob.mockResolvedValue({ id: "switch-job", status: "SUCCEEDED" });
    database.worktree.findUnique.mockResolvedValue({
      ...primary,
      branch: "main",
    });
    context.mockResolvedValue({
      sourceOrigin: "gitlab.test/team/repo",
      targetOrigin: "gitlab.test/team/repo",
      projectPath: "team/repo",
      worktree: null,
      ticketKey: "AIDE-145",
      ticketDoneStatusConfigured: true,
    });
    await service.reconcile();
    expect(database.row?.state).toBe("COMPLETED");
    gitlab.mergeReadiness.mockResolvedValue({
      mr: { ...mr, state: "MERGED" },
      project: { squash_option: "default_off", merge_method: "merge" },
      canMerge: true,
      autoMergeUserId: null,
      removeSourceBranch: false,
      forceRemoveSourceBranch: false,
    });
    vi.mocked(service.options).mockRestore();
    expect(await service.options("7", 3)).toMatchObject({
      worktreeId: "primary",
      worktreeFolder: "/checkout",
      operation: { postMergeSwitch: { state: "COMPLETED" } },
    });
    expect(worktrees.postMergeSwitch).toHaveBeenCalledOnce();
    expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  });
});

test("initializes editable merge choices from GitLab preferences", async () => {
  const { service, gitlab } = setup();
  vi.mocked(service.options).mockRestore();
  gitlab.getSettings.mockResolvedValue({
    configured: true,
    baseUrl: "https://gitlab.test",
    viewer: null,
    defaultSquash: true,
    defaultMoveTicketToDone: true,
    defaultDeleteWorktree: true,
  });

  await expect(service.options("7", 3)).resolves.toMatchObject({
    squash: true,
    defaultMoveTicketToDone: true,
    defaultDeleteWorktree: true,
  });

  gitlab.mergeReadiness.mockResolvedValue({
    ...(await gitlab.mergeReadiness.mock.results[0]!.value),
    project: { squash_option: "never", merge_method: "merge" },
  });
  await expect(service.options("7", 3)).resolves.toMatchObject({
    squash: false,
    squashPolicy: "never",
  });
});

test("persists intent before merging and performs Jira-only follow-ups after confirmation", async () => {
  const { service, gitlab, jira } = setup();
  const result = await service.submit({ ...input, moveTicketToDone: true });
  expect(
    database.gitLabMergeOperation.upsert.mock.invocationCallOrder[0],
  ).toBeLessThan(gitlab.mergeMergeRequestDirect.mock.invocationCallOrder[0]!);
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledWith(
    "AIDE-145",
  );
  expect(result.operation?.state).toBe("COMPLETED");
  expect(result.postMergeError).toBeNull();
});

test("rejects a changed reviewed SHA without a remote mutation or persisted intent", async () => {
  const { service, gitlab } = setup();
  await expect(service.submit({ ...input, sha: "old" })).rejects.toThrow(
    "source commit changed",
  );
  expect(gitlab.mergeMergeRequestDirect).not.toHaveBeenCalled();
  expect(database.gitLabMergeOperation.upsert).not.toHaveBeenCalled();
});

test("skips a bulk merge if GitLab now forces deletion of a source branch reviewed to keep", async () => {
  const { service, gitlab, primary } = setupPrimarySwitch();
  vi.mocked(service.options).mockResolvedValue({
    ...options,
    worktreeId: primary.id,
    worktreeFolder: primary.folder,
    removeSourceBranch: true,
    canRemoveSourceBranch: false,
  });

  await expect(
    service.submit(
      { ...input, worktreeId: primary.id, removeSourceBranch: false },
      bulkReview,
    ),
  ).rejects.toBeInstanceOf(MergeSyncNotSubmittedError);
  expect(gitlab.mergeMergeRequestDirect).not.toHaveBeenCalled();
  expect(database.gitLabMergeOperation.upsert).not.toHaveBeenCalled();
});

test.each(["always", "never"])(
  "enforces %s squash policy before mutation",
  async (policy) => {
    const { service, gitlab } = setup();
    vi.mocked(service.options).mockResolvedValue({
      ...options,
      squashPolicy: policy,
    });
    await expect(
      service.submit({ ...input, squash: policy === "never" }),
    ).rejects.toThrow("project policy");
    expect(gitlab.mergeMergeRequestDirect).not.toHaveBeenCalled();
  },
);

test("serializes duplicate submissions and does not merge twice", async () => {
  const { service, gitlab } = setup();
  await Promise.all([service.submit(input), service.submit(input)]);
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
});

test("native auto-merge waits without executing follow-ups", async () => {
  const { service, gitlab, jira } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  const result = await service.submit({
    ...input,
    autoMerge: true,
    moveTicketToDone: true,
  });
  expect(result.operation?.state).toBe("WAITING");
  expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  gitlab.mergeRequestState.mockResolvedValue({ ...mr, state: "MERGED" });
  await service.reconcile();
  expect(database.row?.state).toBe("COMPLETED");
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
});

test("recovers a merge accepted before a network timeout without resubmitting", async () => {
  const { service, gitlab, jira } = setup();
  gitlab.mergeMergeRequestDirect.mockRejectedValue(new Error("timeout"));
  const result = await service.submit({ ...input, moveTicketToDone: true });
  expect(result.mergeRequest.state).toBe("MERGED");
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
});

test("leaves native auto-merge enabled when a pending bulk merge observes a retargeted request", async () => {
  const { service, gitlab, jira, primary } = setupPrimarySwitch();
  gitlab.mergeRequestState.mockResolvedValue(mr);
  gitlab.mergeMergeRequestDirect.mockRejectedValue(
    unknownMergeOutcome(new Error("timeout")),
  );

  await expect(
    service.submit(
      { ...input, worktreeId: primary.id, moveTicketToDone: true },
      bulkReview,
    ),
  ).rejects.toMatchObject({ mergeOutcomeUnknown: true });
  expect(database.row?.state).toBe("PREPARING");

  gitlab.mergeRequestState.mockResolvedValue({
    ...mr,
    targetBranch: "release",
    mergeWhenPipelineSucceeds: true,
  });
  await service.reconcile();

  expect(database.row?.state).toBe("ACTION_REQUIRED");
  expect(database.row?.lastError).toContain("source or target changed");
  expect(gitlab.cancelAutoMergeDirect).not.toHaveBeenCalled();
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
});

test("definite provider rejection is actionable without automatic resubmission", async () => {
  const { service, gitlab } = setup();
  gitlab.mergeMergeRequestDirect.mockRejectedValue(
    new GitLabRequestError("SHA does not match", 409),
  );
  gitlab.mergeRequestState.mockResolvedValue(mr);
  await expect(service.submit(input)).rejects.toThrow("SHA does not match");
  expect(database.row?.state).toBe("ACTION_REQUIRED");
  await service.reconcile();
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
});

test("keeps confirmed merge success separate from Jira failure and retries only follow-ups", async () => {
  const { service, gitlab, jira } = setup();
  jira.transitionTicketToConfiguredDone.mockRejectedValueOnce(
    new Error("Jira offline"),
  );
  const result = await service.submit({ ...input, moveTicketToDone: true });
  expect(result.mergeRequest.state).toBe("MERGED");
  expect(result.postMergeError).toBe("Jira offline");
  expect((await service.retryFollowUps("7", 3)).operation?.state).toBe(
    "COMPLETED",
  );
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
});

test("cancellation racing with merge still completes chosen follow-ups", async () => {
  const { service, gitlab, jira } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  await service.submit({ ...input, autoMerge: true, moveTicketToDone: true });
  gitlab.cancelAutoMergeDirect.mockRejectedValue(new Error("already merged"));
  gitlab.mergeRequestState.mockResolvedValue({ ...mr, state: "MERGED" });
  const result = await service.cancel("7", 3);
  expect(result.operation?.state).toBe("COMPLETED");
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
});

test("external cancellation and new commits require user action", async () => {
  const { service, gitlab } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  await service.submit({ ...input, autoMerge: true });
  gitlab.mergeRequestState
    .mockResolvedValueOnce({ ...waiting, sha: "new" })
    .mockResolvedValue({ ...mr, sha: "new" });
  await service.reconcile();
  expect(database.row?.state).toBe("ACTION_REQUIRED");
  expect(gitlab.cancelAutoMergeDirect).toHaveBeenCalledOnce();
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
});

test("keeps polling and retries uncertain cancellation after a new source commit", async () => {
  const { service, gitlab, jira, worktrees } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  await service.submit({ ...input, autoMerge: true, moveTicketToDone: true });

  gitlab.mergeRequestState.mockResolvedValue({ ...waiting, sha: "new" });
  await service.reconcile();

  expect(database.row?.state).toBe("WAITING");
  expect(database.row?.lastError).toContain("auto-merge is still enabled");
  expect(gitlab.cancelAutoMergeDirect).toHaveBeenCalledOnce();
  expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  expect(worktrees.deleteWorktree).not.toHaveBeenCalled();

  gitlab.mergeRequestState
    .mockResolvedValueOnce({ ...waiting, sha: "new" })
    .mockResolvedValue({ ...mr, sha: "new" });
  await vi.advanceTimersByTimeAsync(60_000);

  expect(gitlab.cancelAutoMergeDirect).toHaveBeenCalledTimes(2);
  expect(database.row?.state).toBe("ACTION_REQUIRED");
  expect(database.row?.lastError).toContain("Review the new commit");
  expect(gitlab.mergeMergeRequestDirect).toHaveBeenCalledOnce();
  expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  expect(worktrees.deleteWorktree).not.toHaveBeenCalled();
});

test("instance changes pause pending operations", async () => {
  const { service, gitlab } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  await service.submit({ ...input, autoMerge: true });
  gitlab.getSettings.mockResolvedValue({
    configured: true,
    baseUrl: "https://another.test",
  });
  await service.reconcile();
  expect(database.row?.state).toBe("ACTION_REQUIRED");
  expect(database.row?.lastError).toContain("instance");
});

test.each(["the instance changes", "the build guard observes a merge"])(
  "cancels the conflict resolver when %s",
  async (event) => {
    const { service, gitlab, workflows } = setup();
    const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
    gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
    gitlab.mergeRequestState.mockResolvedValue(waiting);
    await service.submit({ ...input, autoMerge: true });
    Object.assign(database.row!, {
      autoSync: true,
      state: "RESOLVING",
      syncStateJson: JSON.stringify({
        version: 1,
        headSha: mr.sha,
        sourceOrigin: "gitlab.test/fork/repo",
        targetOrigin: "gitlab.test/team/repo",
        targetBranch: mr.targetBranch,
        agentId: "agent",
        gitDirectory: "/git/w1",
        conflictResolution: { runId: "resolver", finalizing: false },
      }),
    });
    if (event === "the instance changes") {
      gitlab.getSettings.mockResolvedValue({
        configured: true,
        baseUrl: "https://another.test",
      });
      await service.reconcile();
      expect(database.row?.state).toBe("ACTION_REQUIRED");
    } else {
      database.worktree.findUnique.mockResolvedValue({
        branch: mr.sourceBranch,
        codebase: { repository: { canonicalOrigin: "gitlab.test/fork/repo" } },
      });
      gitlab.mergeRequestState.mockResolvedValue({ ...mr, state: "MERGED" });
      await service.adoptNativeAutoMergeForWorktree("w1");
      expect(database.row?.state).toBe("POST_MERGE");
    }
    expect(workflows.lifecycle).toHaveBeenCalledExactlyOnceWith(
      "resolver",
      "CANCEL",
      { ignoreMissing: true },
    );
  },
);

test("refuses cleanup when the linked checkout no longer matches the fork source", async () => {
  const { service, worktrees, jira } = setup();
  vi.mocked(service.options).mockResolvedValue({
    ...options,
    worktreeId: "w1",
    canDeleteWorktree: true,
  });
  database.worktree.findUnique.mockResolvedValue({
    id: "w1",
    primary: false,
    missingAt: null,
    branch: mr.sourceBranch,
    headSha: mr.sha,
    codebase: { repository: { canonicalOrigin: "gitlab.test/target/repo" } },
  });
  const result = await service.submit({
    ...input,
    deleteWorktree: true,
    moveTicketToDone: true,
  });
  expect(result.postMergeError).toContain("source project");
  expect(worktrees.deleteWorktree).not.toHaveBeenCalled();
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
  database.worktree.findUnique.mockResolvedValue({
    id: "w1",
    primary: false,
    missingAt: null,
    branch: mr.sourceBranch,
    headSha: mr.sha,
    codebase: { repository: { canonicalOrigin: "gitlab.test/fork/repo" } },
  });
  await service.retryFollowUps("7", 3);
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
  expect(worktrees.deleteWorktree).toHaveBeenCalledWith(
    expect.objectContaining({
      requireClean: true,
      expectedHeadSha: "abc",
      expectedBranch: mr.sourceBranch,
      deleteRemoteBranch: false,
    }),
  );
});

test.each([false, true])(
  "cleanup waits and recovers legacy=%s without repeating Jira",
  async (legacy) => {
    const { service, worktrees, jira, gitlab } = setup();
    vi.mocked(service.options).mockResolvedValue({
      ...options,
      worktreeId: "w1",
      canDeleteWorktree: true,
    });
    database.worktree.findUnique.mockResolvedValue({
      id: "w1",
      primary: false,
      missingAt: null,
      branch: mr.sourceBranch,
      headSha: mr.sha,
      codebase: { repository: { canonicalOrigin: "gitlab.test/fork/repo" } },
    });
    worktrees.deleteWorktree.mockRejectedValueOnce(new CodebaseBusyError());
    await service.submit({
      ...input,
      deleteWorktree: true,
      moveTicketToDone: true,
    });
    expect(database.row?.state).toBe("POST_MERGE");
    if (legacy) {
      Object.assign(database.row!, {
        state: "ACTION_REQUIRED",
        lastError: LEGACY_CODEBASE_BUSY_MESSAGE,
      });
      gitlab.mergeRequestState.mockRejectedValueOnce(
        new Error("network timeout"),
      );
      await service.reconcile();
      expect(database.row).toMatchObject({
        state: "ACTION_REQUIRED",
        lastError: LEGACY_CODEBASE_BUSY_MESSAGE,
      });
    }
    await service.reconcile();
    expect(database.row?.state).toBe("POST_MERGE");
    expect(worktrees.deleteWorktree).toHaveBeenCalledTimes(2);
    expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
  },
);

test("never transitions Jira for a different merged head, including on follow-up retry", async () => {
  const { service, gitlab, jira } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  await service.submit({ ...input, autoMerge: true, moveTicketToDone: true });
  gitlab.mergeRequestState.mockResolvedValue({
    ...mr,
    state: "MERGED",
    sha: "another-head",
  });
  await service.reconcile();
  expect(database.row?.state).toBe("ACTION_REQUIRED");
  expect(database.row?.mergeConfirmedAt).not.toBeNull();
  await service.retryFollowUps("7", 3);
  expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  expect(database.row?.lastError).toContain("different source");
});

test("rechecks a merge racing with automatic cancellation after a new head is detected", async () => {
  const { service, gitlab, jira } = setup();
  const waiting = { ...mr, mergeWhenPipelineSucceeds: true };
  gitlab.mergeMergeRequestDirect.mockResolvedValue(waiting);
  gitlab.mergeRequestState.mockResolvedValue(waiting);
  await service.submit({ ...input, autoMerge: true, moveTicketToDone: true });
  gitlab.mergeRequestState
    .mockResolvedValueOnce({ ...waiting, sha: "new" })
    .mockResolvedValue({ ...mr, state: "MERGED" });
  await service.reconcile();
  expect(gitlab.cancelAutoMergeDirect).toHaveBeenCalledOnce();
  expect(database.row?.state).toBe("COMPLETED");
  expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
});

test("transitions a worktree ticket on managed auto merge activation once and returns optional Jira warnings", async () => {
  const { service, gitlab, jira } = setup();
  gitlab.mergeRequestState.mockResolvedValue({ ...mr });
  vi.mocked(service.options).mockResolvedValue({
    ...options,
    worktreeId: "w1",
  });
  jira.transitionTicketToConfiguredAutoMerge.mockRejectedValueOnce(
    new Error("Complete required field: Comment"),
  );
  const result = await service.submit({ ...input, autoMerge: true });
  expect(result.operation?.state).toBe("WAITING_REQUIREMENTS");
  expect(result.ticketTransitionError).toContain("Auto merge is enabled");
  expect(jira.transitionTicketToConfiguredAutoMerge).toHaveBeenCalledWith(
    "AIDE-145",
  );
  await service.submit({ ...input, autoMerge: true });
  expect(jira.transitionTicketToConfiguredAutoMerge).toHaveBeenCalledOnce();
  expect(gitlab.mergeMergeRequestDirect).not.toHaveBeenCalled();
});

test("default branch classification cancels managed auto merge before provider submission", async () => {
  const { service, gitlab, jira } = setup();
  gitlab.mergeRequestState.mockResolvedValue({ ...mr });
  vi.mocked(service.options).mockResolvedValue({
    ...options,
    worktreeId: "w1",
  });
  await service.submit({ ...input, autoMerge: true });
  database.worktree.findUnique.mockResolvedValue({
    branch: mr.sourceBranch,
    codebase: {
      defaultBranch: "main",
      repository: { defaultBranchPatternsJson: '["feature/*"]' },
    },
  });
  await service.reconcile();
  expect(database.row).toMatchObject({ state: "CANCELED", autoMerge: false });
  expect(gitlab.mergeMergeRequestDirect).not.toHaveBeenCalled();
  expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
});
