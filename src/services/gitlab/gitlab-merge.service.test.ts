import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import type { GitLabMergeOperation } from "@/generated/prisma/client";
import type { GitLabService } from "./gitlab.service";
import { GitLabRequestError } from "./gitlab.service";
import type { WorktreesService } from "@/services/worktrees";
import type { JiraService } from "@/services/jira";
import type { AgentControlService } from "@/services/agent-control";
import type { GitLabMergeOptions, GitLabMergeRequestView } from "./types";

const database = vi.hoisted(() => ({
  row: null as GitLabMergeOperation | null,
  gitLabMergeOperation: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
  worktree: { findUnique: vi.fn() },
  agentJob: { findFirst: vi.fn() },
}));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => database,
}));
vi.mock("@/services/integration-configuration-events", () => ({
  publishIntegrationConfiguration: vi.fn(),
}));
import { GitLabMergeService, gitLabMergeBlocker } from "./gitlab-merge.service";

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

function setup() {
  const gitlab = {
    setMergeCoordinator: vi.fn(),
    getSettings: vi
      .fn()
      .mockResolvedValue({ configured: true, baseUrl: "https://gitlab.test" }),
    mergeRequestState: vi.fn().mockResolvedValue({ ...mr, state: "MERGED" }),
    mergeMergeRequestDirect: vi
      .fn()
      .mockResolvedValue({ ...mr, state: "MERGED" }),
    cancelAutoMergeDirect: vi.fn().mockResolvedValue(undefined),
  };
  const jira = {
    transitionTicketToConfiguredDone: vi.fn().mockResolvedValue(undefined),
  };
  const worktrees = {
    publishAutomationChange: vi.fn(),
    deleteWorktree: vi.fn().mockResolvedValue({ id: "job-1" }),
  };
  const agents = {
    getJob: vi.fn().mockResolvedValue({ id: "job-1", status: "RUNNING" }),
  };
  const service = new GitLabMergeService(
    gitlab as unknown as GitLabService,
    worktrees as unknown as WorktreesService,
    jira as unknown as JiraService,
    agents as unknown as AgentControlService,
  );
  vi.spyOn(service, "wake").mockImplementation(() => {});
  vi.spyOn(service, "options").mockResolvedValue({ ...options });
  vi.spyOn(
    service as unknown as { context: () => Promise<unknown> },
    "context",
  ).mockResolvedValue({ sourceOrigin: "gitlab.test/fork/repo" });
  return { service, gitlab, jira, worktrees, agents };
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
