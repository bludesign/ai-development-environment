import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { GitHubPullRequestMergeOptions } from "@/services/github/types";
import type { JiraService } from "@/services/jira";
import type { WorkflowsService } from "@/services/workflows";
import type { WorktreesService } from "./worktrees.service";
import { WorktreeAutomationService } from "./worktree-automation.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

function setup() {
  const options = {
    availableMethods: ["SQUASH", "MERGE"],
    defaultMethod: "SQUASH",
    defaultCommitHeadline: "APP-42 Ship API",
    defaultCommitBody: "PR body",
    defaultCommitEmail: "author@example.com",
    defaultMoveTicketToDone: true,
    defaultDeleteWorktree: true,
    headRefName: "feature/APP-41",
    headRepositoryNameWithOwner: "acme/widgets",
    canMerge: true,
  } as GitHubPullRequestMergeOptions;
  const worktree = {
    id: "wt-1",
    folder: "/worktrees/api",
    primary: false,
    branch: "feature/APP-41",
    codebase: { repository: { canonicalOrigin: "github.com/acme/widgets" } },
    autoMerge: null as Record<string, unknown> | null,
  };
  const prisma = {
    worktree: { findFirst: vi.fn().mockResolvedValue(worktree) },
    gitHubRepository: { findMany: vi.fn().mockResolvedValue([]) },
    jiraProject: {
      findUnique: vi.fn().mockResolvedValue({ doneStatusId: "done" }),
    },
    worktreeAutoMerge: { upsert: vi.fn().mockResolvedValue({}) },
  };
  getPrismaClient.mockResolvedValue(prisma);
  const github = {
    pullRequestMergeOptions: vi.fn().mockResolvedValue(options),
    getSettings: vi
      .fn()
      .mockResolvedValue({ defaultJiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b` }),
    mergePullRequest: vi.fn().mockResolvedValue({
      id: "pr-1",
      state: "MERGED",
      url: "https://github.com/acme/widgets/pull/17",
      mergedAt: new Date(0).toISOString(),
    }),
    enablePullRequestAutoMerge: vi.fn(),
  };
  const worktrees = {
    ticketKeyForWorktree: vi.fn().mockResolvedValue("APP-41"),
    publishAutomationChange: vi.fn(),
  };
  const jira = {
    transitionTicketToConfiguredDone: vi.fn().mockResolvedValue({}),
  };
  const service = new WorktreeAutomationService(
    worktrees as unknown as WorktreesService,
    github as unknown as GitHubService,
    jira as unknown as JiraService,
    {} as WorkflowsService,
    { registerCompletionObserver: vi.fn() } as unknown as AgentControlService,
  );
  vi.spyOn(
    service as unknown as { changed(): void },
    "changed",
  ).mockImplementation(() => undefined);
  return { service, prisma, github, jira, worktree, options, worktrees };
}
const input = {
  owner: "acme",
  name: "widgets",
  number: 17,
  method: "SQUASH" as const,
  commitHeadline: "Ship API",
  commitBody: "",
  moveTicketToDone: true,
  deleteWorktree: true,
};

beforeEach(() => vi.clearAllMocks());
describe("merge preferences and follow-up actions", () => {
  test("resolves a specific worktree ticket and preserves saved false and empty choices", async () => {
    const { service, worktree } = setup();
    worktree.autoMerge = {
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 17,
      mergeMethod: "MERGE",
      commitHeadline: "Saved",
      commitBody: "",
      authorEmail: null,
      moveTicketToDone: false,
      deleteWorktree: false,
    };
    expect(
      await service.pullRequestMergeOptions(
        "acme",
        "widgets",
        17,
        "WORKTREE_AUTOMATION",
        "wt-1",
      ),
    ).toMatchObject({
      defaultMethod: "MERGE",
      defaultCommitHeadline: "Saved",
      defaultCommitBody: "",
      defaultCommitEmail: null,
      defaultMoveTicketToDone: false,
      defaultDeleteWorktree: false,
      worktreeId: "wt-1",
      worktreeFolder: "/worktrees/api",
      canDeleteWorktree: true,
      ticketKey: "APP-41",
    });
  });
  test("prefers the title ticket on PR pages and falls back to the worktree ticket", async () => {
    const { service, options } = setup();
    expect(
      (
        await service.pullRequestMergeOptions(
          "acme",
          "widgets",
          17,
          "PULL_REQUEST_DETAILS",
        )
      ).ticketKey,
    ).toBe("APP-42");
    options.defaultCommitHeadline = "No ticket in title";
    expect(
      (
        await service.pullRequestMergeOptions(
          "acme",
          "widgets",
          17,
          "PULL_REQUEST_DETAILS",
        )
      ).ticketKey,
    ).toBe("APP-41");
  });
  test("ignores rules for a previous PR and excludes primary checkouts from deletion", async () => {
    const { service, worktree } = setup();
    worktree.primary = true;
    worktree.autoMerge = {
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 16,
      commitBody: "Old",
    };
    expect(
      await service.pullRequestMergeOptions(
        "acme",
        "widgets",
        17,
        "PULL_REQUEST_DETAILS",
      ),
    ).toMatchObject({ defaultCommitBody: "PR body", canDeleteWorktree: false });
  });
  test.each(["branch", "repository"])(
    "rejects a mismatched %s before merging",
    async (kind) => {
      const { service, worktree, github } = setup();
      if (kind === "branch") worktree.branch = "other";
      else
        worktree.codebase.repository.canonicalOrigin =
          "github.com/a-fork/widgets";
      await expect(
        service.mergePullRequest(
          { ...input, worktreeId: "wt-1" },
          "WORKTREE_AUTOMATION",
        ),
      ).rejects.toThrow("does not match");
      expect(github.mergePullRequest).not.toHaveBeenCalled();
    },
  );
  test.each(["primary", "missing", "no-done-status", "no-ticket"])(
    "rejects invalid %s follow-ups before merging",
    async (kind) => {
      const { service, worktree, options, prisma, github, worktrees } = setup();
      if (kind === "primary") worktree.primary = true;
      if (kind === "missing") prisma.worktree.findFirst.mockResolvedValue(null);
      if (kind === "no-done-status")
        prisma.jiraProject.findUnique.mockResolvedValue(null);
      if (kind === "no-ticket") {
        worktrees.ticketKeyForWorktree.mockResolvedValue(null);
        options.defaultCommitHeadline = "No ticket";
      }
      await expect(
        service.mergePullRequest(
          { ...input, worktreeId: "wt-1" },
          "WORKTREE_AUTOMATION",
        ),
      ).rejects.toThrow();
      expect(github.mergePullRequest).not.toHaveBeenCalled();
    },
  );
  test("queues regular merge cleanup after success without enabling GitHub auto merge", async () => {
    const { service, prisma, github, jira } = setup();
    await expect(
      service.mergePullRequest(input, "PULL_REQUEST_DETAILS"),
    ).resolves.toMatchObject({ state: "MERGED", postMergeError: null });
    expect(prisma.worktreeAutoMerge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          state: "POST_MERGE",
          worktreeId: "wt-1",
          branch: "feature/APP-41",
          ticketKey: "APP-42",
          deleteWorktree: true,
          moveTicketToDone: true,
        }),
      }),
    );
    expect(github.mergePullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.worktreeAutoMerge.upsert.mock.invocationCallOrder[0]!,
    );
    expect(github.enablePullRequestAutoMerge).not.toHaveBeenCalled();
    expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  });
  test("unchecked submitted options replace existing pending cleanup", async () => {
    const { service, prisma } = setup();
    await service.mergePullRequest(
      { ...input, moveTicketToDone: false, deleteWorktree: false },
      "PULL_REQUEST_DETAILS",
    );
    expect(prisma.worktreeAutoMerge.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          state: "COMPLETED",
          moveTicketToDone: false,
          deleteWorktree: false,
        }),
      }),
    );
  });
  test("a failed merge never schedules cleanup", async () => {
    const { service, prisma, github, jira } = setup();
    github.mergePullRequest.mockRejectedValue(new Error("Required checks"));
    await expect(
      service.mergePullRequest(input, "PULL_REQUEST_DETAILS"),
    ).rejects.toThrow("Required checks");
    expect(prisma.worktreeAutoMerge.upsert).not.toHaveBeenCalled();
    expect(jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  });
  test("without a worktree, Jira transitions after merge and failures preserve merge success", async () => {
    const { service, prisma, github, jira } = setup();
    prisma.worktree.findFirst.mockResolvedValue(null);
    const noDeletion = { ...input, deleteWorktree: false };
    await expect(
      service.mergePullRequest(noDeletion, "PULL_REQUEST_DETAILS"),
    ).resolves.toMatchObject({ state: "MERGED", postMergeError: null });
    expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledWith(
      "APP-42",
    );
    expect(github.mergePullRequest.mock.invocationCallOrder[0]).toBeLessThan(
      jira.transitionTicketToConfiguredDone.mock.invocationCallOrder[0]!,
    );
    jira.transitionTicketToConfiguredDone.mockRejectedValue(
      new Error("Jira unavailable"),
    );
    await expect(
      service.mergePullRequest(noDeletion, "PULL_REQUEST_DETAILS"),
    ).resolves.toMatchObject({
      state: "MERGED",
      postMergeError: "Jira unavailable",
      ticketKey: "APP-42",
    });
  });
  test("cleanup persistence errors are reported as follow-up failures", async () => {
    const { service, prisma } = setup();
    prisma.worktreeAutoMerge.upsert.mockRejectedValue(
      new Error("Database unavailable"),
    );
    await expect(
      service.mergePullRequest(input, "PULL_REQUEST_DETAILS"),
    ).resolves.toMatchObject({
      state: "MERGED",
      postMergeError: "Database unavailable",
    });
  });
  test("reconciliation waits for a manual merge to persist its submitted actions", async () => {
    const { service, prisma, github } = setup();
    let finish!: (value: unknown) => void;
    github.mergePullRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const findMany = vi.fn().mockResolvedValue([]);
    Object.assign(prisma.worktreeAutoMerge, { findMany });
    const merging = service.mergePullRequest(input, "PULL_REQUEST_DETAILS");
    await vi.waitFor(() =>
      expect(github.mergePullRequest).toHaveBeenCalledOnce(),
    );
    const reconciling = (
      service as unknown as { reconcileAutoMerge(): Promise<void> }
    ).reconcileAutoMerge();
    await Promise.resolve();
    expect(findMany).not.toHaveBeenCalled();
    finish({ state: "MERGED" });
    await Promise.all([merging, reconciling]);
    expect(
      prisma.worktreeAutoMerge.upsert.mock.invocationCallOrder[0],
    ).toBeLessThan(findMany.mock.invocationCallOrder[0]!);
  });

  test("failed Jira and dirty-worktree cleanup remain retryable without merging twice", async () => {
    const { service, prisma, github, jira, worktree, worktrees } = setup();
    const rule = {
      worktreeId: worktree.id,
      state: "POST_MERGE",
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 17,
      branch: worktree.branch,
      mergeMethod: "SQUASH",
      commitHeadline: "Title",
      commitBody: "",
      authorEmail: null,
      moveTicketToDone: true,
      deleteWorktree: true,
      ticketKey: "APP-42",
      ticketMovedAt: null,
      deleteJobId: null,
      lastError: null,
      updatedAt: new Date(),
      worktree: { ...worktree, codebaseId: "cb-1", headSha: "head-1" },
    };
    Object.assign(prisma.worktreeAutoMerge, {
      findMany: vi.fn(async () => [rule]),
      findUniqueOrThrow: vi.fn(async () => rule),
      update: vi.fn(async ({ data }) => Object.assign(rule, data)),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(rule, data);
        return { count: 1 };
      }),
    });
    Object.assign(github, {
      pullRequestAutomationState: vi.fn().mockResolvedValue({
        state: "MERGED",
        headRefName: worktree.branch,
        headRefOid: "head-1",
        headRepositoryNameWithOwner: "acme/widgets",
      }),
    });
    const deleteWorktree = vi
      .fn()
      .mockRejectedValue(new Error("Worktree has uncommitted changes"));
    Object.assign(worktrees, { deleteWorktree });
    const reconcile = () =>
      (
        service as unknown as { reconcileAutoMerge(): Promise<void> }
      ).reconcileAutoMerge();
    jira.transitionTicketToConfiguredDone.mockRejectedValueOnce(
      new Error("Jira unavailable"),
    );
    await reconcile();
    expect(rule).toMatchObject({
      state: "ACTION_REQUIRED",
      lastError: "Jira unavailable",
    });
    expect(deleteWorktree).not.toHaveBeenCalled();
    await service.retryAutoMerge(worktree.id);
    await reconcile();
    expect(rule).toMatchObject({
      state: "ACTION_REQUIRED",
      lastError: "Worktree has uncommitted changes",
    });
    expect(rule.ticketMovedAt).toBeInstanceOf(Date);
    deleteWorktree.mockResolvedValue({ id: "delete-job-1" });
    await service.retryAutoMerge(worktree.id);
    await reconcile();
    expect(rule).toMatchObject({
      state: "POST_MERGE",
      deleteJobId: "delete-job-1",
      lastError: null,
    });
    expect(jira.transitionTicketToConfiguredDone).toHaveBeenCalledTimes(2);
    expect(deleteWorktree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        worktreeId: worktree.id,
        requireClean: true,
        deleteRemoteBranch: false,
        expectedBranch: worktree.branch,
        expectedHeadSha: "head-1",
      }),
    );
    expect(github.mergePullRequest).not.toHaveBeenCalled();
    expect(github.enablePullRequestAutoMerge).not.toHaveBeenCalled();
  });
});
