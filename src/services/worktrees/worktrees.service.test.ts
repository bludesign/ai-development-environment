import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";
import {
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_COMMIT_JOB_KIND,
  WORKTREE_AUTO_SYNC_JOB_KIND,
  WORKTREE_DIFF_ASSET_JOB_KIND,
  WORKTREE_GIT_INSPECT_JOB_KIND,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
  WORKTREE_MOVE_PUSH_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import {
  agentEventBus,
  WORKTREE_CHANGED_TOPIC,
} from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";

import { WorktreesService, worktreeDisplayPath } from "./worktrees.service";

function service(control?: AgentControlService) {
  control ??= {
    registerCompletionHandler: vi.fn(),
  } as unknown as AgentControlService;
  const jira = {} as JiraService;
  const github = {} as GitHubService;
  return new WorktreesService(
    control,
    jira,
    github,
    undefined,
    undefined,
    pipelineStatus,
  );
}

const pipelineStatus = {
  snapshot: vi.fn().mockResolvedValue(null),
  snapshots: vi.fn().mockResolvedValue([]),
} as never;

function report(complete = true) {
  return {
    codebaseId: "codebase-1",
    complete,
    defaultBranch: "main",
    localBranches: ["feature/AIDE-24", "main"],
    remoteBranches: ["main", "release"],
    fetchedAt: new Date(1).toISOString(),
    fetchAttemptedAt: new Date(2).toISOString(),
    fetchError: null,
    worktrees: [
      {
        gitDirectory: "/repo/.git",
        folder: "/repo",
        relativePath: ".",
        primary: true,
        branch: "feature/AIDE-24",
        headSha: "abc",
        upstream: "origin/feature/AIDE-24",
        ahead: 0,
        behind: 0,
        syncState: "IN_SYNC" as const,
        baseAhead: 1,
        baseBehind: 0,
        availability: "AVAILABLE" as const,
        error: null,
        checkedAt: new Date(3).toISOString(),
      },
    ],
  };
}

function githubPullRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "pull-request-1",
    number: 24,
    title: "Persist pull requests",
    url: "https://github.com/acme/widgets/pull/24",
    repositoryGithubId: "repository-github-1",
    repositoryNameWithOwner: "acme/widgets",
    repositoryUrl: "https://github.com/acme/widgets",
    labels: ["ready"],
    jiraKey: "AIDE-24",
    pipelineStatus: "SUCCESS",
    pipelineRevision: 1,
    pipelines: [],
    reviewDecision: "APPROVED",
    unresolvedReviewThreadCount: 0,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    autoMergeEnabled: false,
    viewerCanEnableAutoMerge: true,
    viewerCanDisableAutoMerge: false,
    headRefOid: "head-2",
    headRefName: "feature/AIDE-24",
    worktreeId: null,
    worktreeHighlightColor: null,
    createdAt: new Date(3).toISOString(),
    ...overrides,
  };
}

function storedWorktreeRecord() {
  return {
    id: "worktree-1",
    codebaseId: "codebase-1",
    folder: "/repo-feature",
    branch: "feature/AIDE-24",
    baseBranchOverride: null,
    missingAt: null,
    tags: [],
    builds: [],
    pullRequest: {
      worktreeId: "worktree-1",
      githubId: "pull-request-1",
      number: 24,
      title: "Persist pull requests",
      url: "https://github.com/acme/widgets/pull/24",
      repositoryGithubId: "repository-github-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      labelsJson: JSON.stringify(["ready"]),
      jiraKey: "AIDE-24",
      reviewDecision: "APPROVED",
      unresolvedReviewThreadCount: 0,
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      autoMergeEnabled: false,
      viewerCanEnableAutoMerge: true,
      viewerCanDisableAutoMerge: false,
      headRefOid: "head-2",
      headRefName: "feature/AIDE-24",
      githubCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    },
    codebase: {
      defaultBranch: "main",
      jobs: [],
      agent: { baseRepoDirectory: null },
      repository: {
        canonicalOrigin: "github.com/acme/widgets",
        jiraBranchRegex: null,
      },
    },
  };
}

describe("WorktreesService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("requests an immediate reconcile from every codebase agent", async () => {
    getPrismaClient.mockResolvedValue({
      codebase: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { agentId: "agent-1" },
            { agentId: "agent-1" },
            { agentId: "agent-2" },
          ]),
      },
    });
    const requestCodebaseReconcile = vi.fn().mockReturnValue(2);
    const control = {
      registerCompletionHandler: vi.fn(),
      requestCodebaseReconcile,
    } as unknown as AgentControlService;

    await expect(service(control).requestRefresh()).resolves.toBe(2);
    expect(requestCodebaseReconcile).toHaveBeenCalledWith([
      "agent-1",
      "agent-1",
      "agent-2",
    ]);
  });

  test("pins Auto Sync jobs to the configured branch", async () => {
    const runnable = {
      id: "worktree-1",
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      baseBranchOverride: null,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        agentId: "agent-1",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify([WORKTREE_AUTO_SYNC_JOB_KIND]),
        },
        repository: { canonicalOrigin: "github.com/openai/codex" },
      },
    };
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(runnable) },
      agentJob: { findFirst: vi.fn().mockResolvedValue(null) },
      worktreeMove: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const createJob = vi.fn().mockResolvedValue({ id: "job-1" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
    } as unknown as AgentControlService;

    await service(control).createAutoSyncJob(
      "worktree-1",
      "SYNC",
      "feature/configured",
      "request-1",
    );

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: WORKTREE_AUTO_SYNC_JOB_KIND,
        payload: expect.objectContaining({
          expectedBranch: "feature/configured",
        }),
      }),
    );
  });

  test("pins guarded deletion jobs to the expected branch", async () => {
    const runnable = {
      id: "worktree-1",
      codebaseId: "codebase-1",
      folder: "/repo-linked",
      gitDirectory: "/repo/.git/worktrees/repo-linked",
      branch: "feature/AIDE-71",
      headSha: "pr-head",
      primary: false,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        agentId: "agent-1",
        folder: "/repo",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify(["worktree.delete"]),
        },
        repository: { canonicalOrigin: "github.com/openai/codex" },
      },
    };
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(runnable) },
      agentJob: { findFirst: vi.fn().mockResolvedValue(null) },
      worktreeMove: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const createJob = vi.fn().mockResolvedValue({ id: "delete-job" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
    } as unknown as AgentControlService;
    const worktrees = service(control);

    await expect(
      worktrees.deleteWorktree({
        worktreeId: "worktree-1",
        deleteRemoteBranch: false,
        requireClean: true,
        expectedBranch: "feature/other",
        expectedHeadSha: "pr-head",
        requestId: "request-1",
      }),
    ).rejects.toThrow("branch changed");
    await expect(
      worktrees.deleteWorktree({
        worktreeId: "worktree-1",
        deleteRemoteBranch: false,
        requireClean: true,
        expectedBranch: "feature/AIDE-71",
        expectedHeadSha: "other-head",
        requestId: "request-2",
      }),
    ).rejects.toThrow("HEAD changed");
    await worktrees.deleteWorktree({
      worktreeId: "worktree-1",
      deleteRemoteBranch: false,
      requireClean: true,
      expectedBranch: "feature/AIDE-71",
      expectedHeadSha: "pr-head",
      requestId: "request-3",
    });

    expect(createJob).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          branch: "feature/AIDE-71",
          expectedHeadSha: "pr-head",
        }),
      }),
    );
  });

  test("discovers an exact branch pull request and persists the association", async () => {
    const pullRequest = githubPullRequest();
    const pullRequestsForBranches = vi
      .fn()
      .mockResolvedValue(new Map([["feature/AIDE-24", pullRequest]]));
    const github = {
      pullRequestsForBranches,
      pullRequestLiveStatuses: vi.fn().mockResolvedValue(new Map()),
      effectiveCacheTtlSeconds: vi.fn().mockResolvedValue(300),
    } as unknown as GitHubService;
    const jira = {
      cachedTicket: vi.fn(),
      ticket: vi.fn(),
    } as unknown as JiraService;
    const worktree = {
      id: "worktree-1",
      branch: "feature/AIDE-24",
      headSha: "head-2",
      codeStateHash: "state-2",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      folder: "/repo",
      baseBranchOverride: null,
      pullRequest: null,
      pullRequestLookupOrigin: null,
      pullRequestLookupBranch: null,
      pullRequestLookupAt: null,
      tags: [],
      builds: [
        {
          id: "build-latest",
          status: "SUCCEEDED",
          action: "BUILD",
          destinationType: "SIMULATOR",
          snapshotJson: JSON.stringify({
            worktree: { headSha: "head-1", codeStateHash: "state-1" },
          }),
          destinationJson: JSON.stringify({
            type: "SIMULATOR",
            id: "SIM-1",
            name: "iPhone 17 Pro",
            platform: "iOS Simulator",
            osVersion: "26.0",
            state: "Booted",
          }),
          createdAt: new Date(4),
          artifacts: [{ id: "artifact-1", kind: "RUNNABLE_APP" }],
        },
      ],
      codebase: {
        id: "codebase-1",
        defaultBranch: "main",
        jobs: [],
        agent: { id: "agent-1", baseRepoDirectory: "/repo" },
        repository: {
          id: "repository-1",
          canonicalOrigin: "github.com/acme/widgets",
          jiraBranchRegex: null,
        },
      },
    };
    const findMany = vi.fn().mockResolvedValue([worktree]);
    const worktreeUpdate = vi.fn().mockResolvedValue(worktree);
    const pullRequestUpsert = vi.fn().mockResolvedValue(undefined);
    const quickActionWorkflow = {
      id: "workflow-1",
      name: "Prepare review",
      description: "",
      quickActionKind: "STANDARD",
      activeVersion: {
        triggers: [
          {
            kind: "RESOURCE_MANUAL",
            configJson: JSON.stringify({ resourceKind: "WORKTREE" }),
          },
        ],
      },
      quickActionRepositories: [{ repositoryId: "repository-1" }],
    };
    getPrismaClient.mockResolvedValue({
      worktree: {
        deleteMany: vi.fn(),
        findMany,
        update: worktreeUpdate,
        count: vi.fn().mockResolvedValue(0),
      },
      worktreePullRequest: {
        upsert: pullRequestUpsert,
        deleteMany: vi.fn(),
      },
      $transaction: vi.fn(async (operation) => {
        if (typeof operation === "function") {
          return operation({
            worktree: { update: worktreeUpdate },
            worktreePullRequest: {
              upsert: pullRequestUpsert,
              deleteMany: vi.fn(),
            },
          });
        }
        return Promise.all(operation);
      }),
      gitHubSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      worktreeTag: { findMany: vi.fn().mockResolvedValue([]) },
      worktreeSettings: {
        upsert: vi.fn().mockResolvedValue({
          id: "default",
          editorVariant: "CODE",
        }),
      },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      worktreeMove: { findMany: vi.fn().mockResolvedValue([]) },
      workflow: { findMany: vi.fn().mockResolvedValue([quickActionWorkflow]) },
    });
    const worktrees = new WorktreesService(
      {
        registerCompletionHandler: vi.fn(),
      } as unknown as AgentControlService,
      jira,
      github,
      undefined,
      undefined,
      pipelineStatus,
    );

    const initial = await worktrees.overview();
    expect(initial.agents[0]?.codebases[0]?.worktrees[0]?.latestBuild).toEqual({
      ...worktree.builds[0],
      outOfDate: true,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          builds: expect.objectContaining({
            orderBy: { createdAt: "desc" },
            select: expect.objectContaining({
              destinationJson: true,
              artifacts: { select: { id: true, kind: true } },
            }),
            take: 1,
          }),
        }),
      }),
    );
    expect(initial.agents[0]?.codebases[0]?.worktrees[0]?.pullRequest).toEqual(
      pullRequest,
    );
    expect(initial.agents[0]?.codebases[0]?.quickActions).toEqual([
      quickActionWorkflow,
    ]);
    expect(pullRequestsForBranches).toHaveBeenCalledWith(
      "github.com/acme/widgets",
      ["feature/AIDE-24"],
      expect.objectContaining({ requestSource: "WORKTREES" }),
    );
    expect(pullRequestUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { worktreeId: "worktree-1" } }),
    );
  });

  test("replaces a terminal pull request in the same synchronization cycle", async () => {
    const current = githubPullRequest();
    const replacement = githubPullRequest({
      id: "pull-request-2",
      number: 25,
      title: "Replacement pull request",
    });
    const upsert = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      gitHubSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      worktreePullRequest: { updateMany: vi.fn(), deleteMany },
      worktree: { update },
      $transaction: vi.fn(async (operation) => {
        if (typeof operation !== "function") return Promise.all(operation);
        return operation({
          worktree: { update },
          worktreePullRequest: { upsert, deleteMany },
        });
      }),
    });
    const pullRequestLiveStatuses = vi
      .fn()
      .mockResolvedValue(
        new Map([["pull-request-1", { ...current, state: "CLOSED" }]]),
      );
    const pullRequestsForBranches = vi
      .fn()
      .mockResolvedValue(new Map([["feature/AIDE-24", replacement]]));
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {
        pullRequestLiveStatuses,
        pullRequestsForBranches,
        effectiveCacheTtlSeconds: vi.fn().mockResolvedValue(300),
      } as unknown as GitHubService,
    );
    const target = {
      id: "worktree-1",
      branch: "feature/AIDE-24",
      pullRequestLookupOrigin: "github.com/acme/widgets",
      pullRequestLookupBranch: "feature/AIDE-24",
      pullRequestLookupAt: new Date(),
      pullRequest: current,
      codebase: {
        repository: { canonicalOrigin: "github.com/acme/widgets" },
      },
    };

    await (
      worktrees as unknown as {
        synchronizePullRequests(values: unknown[]): Promise<void>;
      }
    ).synchronizePullRequests([target]);

    expect(target.pullRequest).toBe(replacement);
    expect(pullRequestsForBranches).toHaveBeenCalledWith(
      "github.com/acme/widgets",
      ["feature/AIDE-24"],
      expect.objectContaining({ force: true, allowStaleOnError: false }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ githubId: "pull-request-2" }),
      }),
    );
  });

  test("keeps the last-known pull request when replacement discovery fails", async () => {
    const current = githubPullRequest();
    const deleteMany = vi.fn();
    getPrismaClient.mockResolvedValue({
      gitHubSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      worktreePullRequest: { updateMany: vi.fn(), deleteMany },
    });
    const pullRequestsForBranches = vi
      .fn()
      .mockRejectedValue(new Error("GitHub unavailable"));
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {
        pullRequestLiveStatuses: vi
          .fn()
          .mockResolvedValue(
            new Map([["pull-request-1", { ...current, state: "MERGED" }]]),
          ),
        pullRequestsForBranches,
        effectiveCacheTtlSeconds: vi.fn().mockResolvedValue(300),
      } as unknown as GitHubService,
    );
    const target = {
      id: "worktree-1",
      branch: "feature/AIDE-24",
      pullRequestLookupOrigin: "github.com/acme/widgets",
      pullRequestLookupBranch: "feature/AIDE-24",
      pullRequestLookupAt: new Date(),
      pullRequest: current,
      codebase: {
        repository: { canonicalOrigin: "github.com/acme/widgets" },
      },
    };

    await (
      worktrees as unknown as {
        synchronizePullRequests(values: unknown[]): Promise<void>;
      }
    ).synchronizePullRequests([target]);

    expect(target.pullRequest).toBe(current);
    expect(pullRequestsForBranches).toHaveBeenCalledOnce();
    expect(deleteMany).not.toHaveBeenCalled();
  });

  test("forced refresh preserves the stored snapshot when GitHub fails", async () => {
    const transaction = vi.fn();
    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          id: "worktree-1",
          codebaseId: "codebase-1",
          branch: "feature/AIDE-24",
          missingAt: null,
          codebase: {
            repository: { canonicalOrigin: "github.com/acme/widgets" },
          },
        }),
      },
      $transaction: transaction,
    });
    const pullRequestsForBranches = vi
      .fn()
      .mockRejectedValue(new Error("GitHub unavailable"));
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      { pullRequestsForBranches } as unknown as GitHubService,
    );

    await expect(worktrees.refreshPullRequest("worktree-1")).rejects.toThrow(
      "GitHub unavailable",
    );
    expect(pullRequestsForBranches).toHaveBeenCalledWith(
      "github.com/acme/widgets",
      ["feature/AIDE-24"],
      {
        force: true,
        allowStaleOnError: false,
        requestSource: "WORKTREES",
      },
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  test("hydrates the canonical pipeline snapshot in a forced refresh response", async () => {
    const record = storedWorktreeRecord();
    const worktreeUpdate = vi.fn().mockResolvedValue(undefined);
    const pullRequestUpsert = vi.fn().mockResolvedValue(undefined);
    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue(record),
        findUniqueOrThrow: vi.fn().mockResolvedValue(record),
        update: worktreeUpdate,
      },
      worktreePullRequest: {
        upsert: pullRequestUpsert,
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (operation) =>
        operation({
          worktree: { update: worktreeUpdate },
          worktreePullRequest: {
            upsert: pullRequestUpsert,
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        }),
      ),
    });
    const canonicalSnapshot = {
      repositoryGithubId: "repository-github-1",
      repositoryNameWithOwner: "acme/widgets",
      repositoryUrl: "https://github.com/acme/widgets",
      headSha: "head-2",
      pipelineStatus: "FAILURE",
      revision: 8,
      updatedAt: "2026-07-26T12:00:00.000Z",
      pipelines: [
        {
          id: "pipeline-1",
          name: "CI",
          status: "FAILURE",
          url: null,
          checkSuiteId: "suite-1",
          canRetry: true,
          retryUnavailableReason: null,
          jobs: [],
        },
      ],
    };
    const snapshots = vi.fn().mockResolvedValue([canonicalSnapshot]);
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {
        pullRequestsForBranches: vi
          .fn()
          .mockResolvedValue(
            new Map([["feature/AIDE-24", githubPullRequest()]]),
          ),
      } as unknown as GitHubService,
      undefined,
      undefined,
      { snapshots } as never,
    );

    const result = await worktrees.refreshPullRequest("worktree-1");

    expect(snapshots).toHaveBeenCalledWith([
      {
        repositoryGithubId: "repository-github-1",
        headSha: "head-2",
      },
    ]);
    expect(result.pullRequest).toMatchObject({
      pipelineStatus: "FAILURE",
      pipelineRevision: 8,
      pipelines: [expect.objectContaining({ id: "pipeline-1" })],
    });
  });

  test("hydrates canonical pipeline snapshots in hidden worktree views", async () => {
    const record = storedWorktreeRecord();
    getPrismaClient.mockResolvedValue({
      worktree: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([record]),
      },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const snapshots = vi.fn().mockResolvedValue([
      {
        repositoryGithubId: "repository-github-1",
        repositoryNameWithOwner: "acme/widgets",
        repositoryUrl: "https://github.com/acme/widgets",
        headSha: "head-2",
        pipelineStatus: "SUCCESS",
        revision: 9,
        updatedAt: "2026-07-26T12:01:00.000Z",
        pipelines: [],
      },
    ]);
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {} as GitHubService,
      undefined,
      undefined,
      { snapshots } as never,
    );

    await expect(worktrees.hidden()).resolves.toEqual([
      expect.objectContaining({
        pullRequest: expect.objectContaining({
          pipelineStatus: "SUCCESS",
          pipelineRevision: 9,
        }),
      }),
    ]);
  });

  test("honors a recent successful negative pull request lookup", async () => {
    getPrismaClient.mockResolvedValue({
      gitHubSettings: {
        findUnique: vi.fn().mockResolvedValue({ cacheTtlSeconds: 300 }),
      },
    });
    const pullRequestsForBranches = vi.fn();
    const pullRequestLiveStatuses = vi.fn();
    const effectiveCacheTtlSeconds = vi.fn().mockResolvedValue(300);
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {
        pullRequestsForBranches,
        pullRequestLiveStatuses,
        effectiveCacheTtlSeconds,
      } as unknown as GitHubService,
    );
    const target = {
      id: "worktree-1",
      branch: "feature/AIDE-24",
      pullRequestLookupOrigin: "github.com/acme/widgets",
      pullRequestLookupBranch: "feature/AIDE-24",
      pullRequestLookupAt: new Date(),
      pullRequest: null,
      codebase: {
        repository: { canonicalOrigin: "github.com/acme/widgets" },
      },
    };

    await (
      worktrees as unknown as {
        synchronizePullRequests(values: unknown[]): Promise<void>;
      }
    ).synchronizePullRequests([target]);

    expect(pullRequestsForBranches).not.toHaveBeenCalled();
    expect(pullRequestLiveStatuses).not.toHaveBeenCalled();
    expect(effectiveCacheTtlSeconds).toHaveBeenCalledWith(
      "GitHubWorktreePullRequests",
    );
  });

  test("retries negative pull request discovery using the operation TTL", async () => {
    const worktreeUpdate = vi.fn().mockResolvedValue(undefined);
    const pullRequestDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    getPrismaClient.mockResolvedValue({
      worktree: { update: worktreeUpdate },
      worktreePullRequest: { deleteMany: pullRequestDeleteMany },
      $transaction: vi.fn(async (operation) => {
        if (typeof operation !== "function") return Promise.all(operation);
        return operation({
          worktree: { update: worktreeUpdate },
          worktreePullRequest: { deleteMany: pullRequestDeleteMany },
        });
      }),
    });
    const pullRequestsForBranches = vi
      .fn()
      .mockResolvedValue(new Map([["feature/AIDE-24", null]]));
    const effectiveCacheTtlSeconds = vi.fn().mockResolvedValue(60);
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {
        pullRequestsForBranches,
        pullRequestLiveStatuses: vi.fn(),
        effectiveCacheTtlSeconds,
      } as unknown as GitHubService,
    );
    const target = {
      id: "worktree-1",
      branch: "feature/AIDE-24",
      pullRequestLookupOrigin: "github.com/acme/widgets",
      pullRequestLookupBranch: "feature/AIDE-24",
      pullRequestLookupAt: new Date(Date.now() - 61_000),
      pullRequest: null,
      codebase: {
        repository: { canonicalOrigin: "github.com/acme/widgets" },
      },
    };

    await (
      worktrees as unknown as {
        synchronizePullRequests(values: unknown[]): Promise<void>;
      }
    ).synchronizePullRequests([target]);

    expect(effectiveCacheTtlSeconds).toHaveBeenCalledWith(
      "GitHubWorktreePullRequests",
    );
    expect(pullRequestsForBranches).toHaveBeenCalledWith(
      "github.com/acme/widgets",
      ["feature/AIDE-24"],
      expect.objectContaining({ requestSource: "WORKTREES" }),
    );
  });

  test("resolves the linked ticket key from a worktree branch", async () => {
    getPrismaClient.mockResolvedValue({
      worktree: {
        findFirst: vi.fn().mockResolvedValue({
          branch: "feature/aide-42-workflow-support",
          codebase: { repository: { jiraBranchRegex: "([a-z]+-\\d+)" } },
        }),
      },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(service().ticketKeyForWorktree("worktree-1")).resolves.toBe(
      "AIDE-42",
    );
  });

  test("falls back to the default branch regex when the repo has none", async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValue({ defaultJiraBranchRegex: "([a-z]+-\\d+)" });
    getPrismaClient.mockResolvedValue({
      worktree: {
        findFirst: vi.fn().mockResolvedValue({
          branch: "bugfix/aide-7",
          codebase: { repository: { jiraBranchRegex: null } },
        }),
      },
      codebaseSettings: { findUnique },
    });

    await expect(service().ticketKeyForWorktree("worktree-1")).resolves.toBe(
      "AIDE-7",
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "default" } });
  });

  test("hydrates workflow sessions from the branch without reading GitHub", async () => {
    getPrismaClient.mockResolvedValue({
      worktree: {
        findFirst: vi.fn().mockResolvedValue({
          id: "worktree-1",
          folder: "/repo-feature",
          branch: "feature/APP-42",
          baseBranchOverride: "release",
          headSha: "abc123",
          rebaseInProgress: false,
          hasConflicts: false,
          pushStatus: "READY",
          hasStagedChanges: false,
          hasUnstagedChanges: false,
          pullRequest: {
            worktreeId: "worktree-1",
            githubId: "pull-request-1",
            number: 42,
            title: "Ship persisted PR context",
            url: "https://github.com/acme/widgets/pull/42",
            repositoryGithubId: "github-repository-1",
            repositoryNameWithOwner: "acme/widgets",
            repositoryUrl: "https://github.com/acme/widgets",
            labelsJson: JSON.stringify(["ready"]),
            jiraKey: "APP-99",
            pipelineStatus: "SUCCESS",
            pipelinesJson: "[]",
            reviewDecision: "APPROVED",
            unresolvedReviewThreadCount: 2,
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            autoMergeEnabled: false,
            viewerCanEnableAutoMerge: true,
            viewerCanDisableAutoMerge: false,
            headRefOid: "abc123",
            headRefName: "feature/APP-42",
            githubCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            updatedAt: new Date("2026-07-01T00:00:00.000Z"),
          },
          codebase: {
            id: "codebase-1",
            folder: "/repo",
            agentId: "agent-1",
            defaultBranch: "main",
            agent: {
              id: "agent-1",
              name: "Studio Mac",
              hostname: "studio.local",
            },
            repository: {
              id: "repository-1",
              name: "Widgets",
              displayOrigin: "github.com/acme/widgets",
              canonicalOrigin: "github.com/acme/widgets",
              jiraBranchRegex: "([A-Z]+-\\d+)",
            },
          },
        }),
      },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const worktrees = new WorktreesService(
      { registerCompletionHandler: vi.fn() } as unknown as AgentControlService,
      {} as JiraService,
      {} as GitHubService,
      undefined,
      undefined,
      pipelineStatus,
    );

    const session =
      await worktrees.workflowSessionDataForWorktree("worktree-1");

    expect(session).toMatchObject({
      worktree: { id: "worktree-1", baseBranch: "release" },
      codebase: { id: "codebase-1", agentId: "agent-1" },
      agent: { id: "agent-1", name: "Studio Mac" },
      repo: {
        id: "repository-1",
        name: "Widgets",
        url: "github.com/acme/widgets",
      },
      // The branch regex is the only source of the key, so the pull request's
      // own APP-99 does not win.
      ticket: { key: "APP-42" },
      pr: {
        id: "pull-request-1",
        number: 42,
        headBranch: "feature/APP-42",
        headSha: "abc123",
        unresolvedReviewThreadCount: 2,
      },
    });
  });

  test("resolves pull-request workflow data from its persisted worktree", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        worktreeId: "worktree-1",
        repositoryNameWithOwner: "Acme/Widgets",
      },
    ]);
    getPrismaClient.mockResolvedValue({
      worktreePullRequest: { findMany },
    });
    const worktrees = service();
    const snapshot = {
      worktree: { id: "worktree-1" },
      pr: { number: 42, title: "Stored pull request" },
    };
    const workflowSessionDataForWorktree = vi
      .spyOn(worktrees, "workflowSessionDataForWorktree")
      .mockResolvedValue(snapshot);

    await expect(
      worktrees.workflowSessionDataForPullRequest("ACME", "Widgets", 42),
    ).resolves.toEqual(snapshot);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        number: 42,
        worktree: { missingAt: null },
      },
      select: { worktreeId: true, repositoryNameWithOwner: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(workflowSessionDataForWorktree).toHaveBeenCalledWith("worktree-1");
  });

  test("returns no pull-request workflow data without a persisted snapshot", async () => {
    getPrismaClient.mockResolvedValue({
      worktreePullRequest: { findMany: vi.fn().mockResolvedValue([]) },
    });

    await expect(
      service().workflowSessionDataForPullRequest("acme", "widgets", 42),
    ).resolves.toEqual({});
  });

  test("records a deduplicated workflow event after creating a worktree", async () => {
    let completeBranch:
      ((job: Record<string, unknown>) => Promise<void>) | undefined;
    const control = {
      registerCompletionHandler: vi.fn((kind, handler) => {
        if (kind === WORKTREE_BRANCH_JOB_KIND) completeBranch = handler;
      }),
    } as unknown as AgentControlService;
    const item = report().worktrees[0]!;
    const projected = {
      id: "worktree-created",
      codebaseId: "codebase-1",
      folder: item.folder,
      branch: item.branch,
      headSha: item.headSha,
      baseBranchOverride: "main",
      pushStatus: "READY",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      codebase: {
        id: "codebase-1",
        folder: "/repo",
        agentId: "agent-1",
        defaultBranch: "main",
        repository: {
          id: "repository-1",
          name: "Widgets",
          canonicalOrigin: "github.com/acme/widgets",
          displayOrigin: "github.com/acme/widgets",
          jiraBranchRegex: "([A-Z]+-\\d+)",
        },
        agent: {
          id: "agent-1",
          name: "Studio Mac",
          hostname: "studio.local",
        },
      },
    };
    const transaction = {
      codebase: { update: vi.fn() },
      worktree: {
        upsert: vi.fn().mockResolvedValue({ id: projected.id }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    getPrismaClient.mockResolvedValue({
      codebase: {
        findUnique: vi.fn().mockResolvedValue({ localBranchesJson: "[]" }),
      },
      worktree: {
        findFirst: vi.fn().mockResolvedValue(projected),
        findUnique: vi.fn().mockResolvedValue(projected),
      },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback) => callback(transaction)),
    });
    const record = vi.fn().mockResolvedValue({ id: "event-1" });
    new WorktreesService(
      control,
      {
        cachedTicket: vi.fn().mockResolvedValue({
          issueKey: "AIDE-24",
          projectKey: "AIDE",
          summary: "Add workflow session context",
          status: "In Progress",
        }),
      } as unknown as JiraService,
      {} as GitHubService,
      undefined,
      { record } as never,
    );

    await completeBranch?.({
      codebaseId: "codebase-1",
      worktreeId: null,
      status: "SUCCEEDED",
      resultJson: JSON.stringify({ worktree: item, baseBranch: "main" }),
    });

    expect(record).toHaveBeenCalledWith({
      kind: "WORKTREE_CREATED",
      subjectKey: "worktree-created",
      dedupeKey: "worktree-created:worktree-created",
      payload: expect.objectContaining({
        sessionData: expect.objectContaining({
          repo: expect.objectContaining({
            name: "Widgets",
            url: "github.com/acme/widgets",
          }),
          worktree: expect.objectContaining({ id: "worktree-created" }),
          codebase: expect.objectContaining({ agentId: "agent-1" }),
          agent: expect.objectContaining({
            id: "agent-1",
            name: "Studio Mac",
          }),
          ticket: expect.objectContaining({
            key: "AIDE-24",
            title: "Add workflow session context",
          }),
        }),
      }),
    });

    record.mockClear();
    await completeBranch?.({
      codebaseId: "codebase-1",
      worktreeId: "worktree-created",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({ worktree: item, baseBranch: "main" }),
    });
    await completeBranch?.({
      codebaseId: "codebase-1",
      worktreeId: null,
      status: "FAILED",
      resultJson: null,
    });
    expect(record).not.toHaveBeenCalled();
  });

  test("projects a successful commit's returned worktree inventory", async () => {
    const handlers = new Map<string, (job: never) => Promise<void>>();
    const control = {
      registerCompletionHandler: vi.fn((kind, handler) =>
        handlers.set(kind, handler),
      ),
    } as unknown as AgentControlService;
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          id: "worktree-1",
          codebaseId: "codebase-1",
        }),
        updateMany,
      },
    });
    const publish = vi.spyOn(agentEventBus, "publish");
    service(control);
    const item = {
      ...report().worktrees[0]!,
      headSha: "def",
      ahead: 2,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      checkedAt: new Date(4).toISOString(),
    };

    await handlers.get(WORKTREE_COMMIT_JOB_KIND)!({
      worktreeId: "worktree-1",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({ worktree: item }),
    } as never);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "worktree-1",
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(4) } }],
      },
      data: expect.objectContaining({
        headSha: "def",
        ahead: 2,
        hasStagedChanges: false,
        hasUnstagedChanges: false,
        lastCheckedAt: new Date(4),
      }),
    });
    expect(publish).toHaveBeenCalledWith(WORKTREE_CHANGED_TOPIC, {
      worktreeOverviewChanged: {
        worktreeId: "worktree-1",
        codebaseId: "codebase-1",
      },
    });
    publish.mockRestore();
  });

  test("returns null when the worktree is missing or has no ticket", async () => {
    getPrismaClient.mockResolvedValue({
      worktree: { findFirst: vi.fn().mockResolvedValue(null) },
      codebaseSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service().ticketKeyForWorktree("missing-worktree"),
    ).resolves.toBeNull();
  });

  test("upserts inventory and tombstones rows absent from a complete scan", async () => {
    const transaction = {
      codebase: { update: vi.fn() },
      worktree: {
        upsert: vi.fn().mockResolvedValue({
          id: "worktree-1",
          branch: "feature/AIDE-24",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "codebase-1",
          agentId: "agent-1",
        }),
      },
      worktree: {
        deleteMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);

    await service().report("agent-1", [report()]);

    expect(transaction.codebase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          defaultBranch: "main",
          remoteBranchesJson: JSON.stringify(["main", "release"]),
        }),
      }),
    );
    expect(transaction.worktree.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          codebaseId_gitDirectory: {
            codebaseId: "codebase-1",
            gitDirectory: "/repo/.git",
          },
        },
        update: {},
      }),
    );
    expect(transaction.worktree.updateMany).toHaveBeenCalledWith({
      where: {
        id: "worktree-1",
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(3) } }],
      },
      data: expect.objectContaining({
        branch: "feature/AIDE-24",
        headSha: "abc",
        lastCheckedAt: new Date(3),
        missingAt: null,
      }),
    });
    expect(transaction.worktree.updateMany).toHaveBeenCalledWith({
      where: {
        codebaseId: "codebase-1",
        missingAt: null,
        gitDirectory: { notIn: ["/repo/.git"] },
      },
      data: { missingAt: expect.any(Date) },
    });
  });

  test("does not tombstone saved worktrees after an incomplete scan", async () => {
    const transaction = {
      codebase: { update: vi.fn() },
      worktree: {
        upsert: vi.fn().mockResolvedValue({
          id: "worktree-1",
          branch: "feature/AIDE-24",
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "codebase-1",
          agentId: "agent-1",
        }),
      },
      worktree: {
        deleteMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);

    await service().report("agent-1", [report(false)]);

    expect(transaction.worktree.updateMany).toHaveBeenCalledTimes(1);
    expect(transaction.worktree.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { missingAt: expect.any(Date) } }),
    );
  });

  test("preserves fetch failures until another attempt and records new errors", async () => {
    const transaction = {
      codebase: { update: vi.fn() },
      worktree: { upsert: vi.fn(), updateMany: vi.fn() },
    };
    const prisma = {
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "codebase-1",
          agentId: "agent-1",
        }),
      },
      worktree: {
        deleteMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    getPrismaClient.mockResolvedValue(prisma);
    const withoutFetch = {
      ...report(false),
      fetchedAt: null,
      fetchAttemptedAt: null,
      fetchError: null,
      worktrees: [],
    };

    await service().report("agent-1", [
      withoutFetch,
      { ...withoutFetch, fetchError: "Inventory failed" },
    ]);

    expect(
      transaction.codebase.update.mock.calls[0]?.[0].data,
    ).not.toHaveProperty("lastFetchError");
    expect(transaction.codebase.update.mock.calls[1]?.[0].data).toMatchObject({
      lastFetchError: "Inventory failed",
    });
  });

  test("rejects global tag names that differ only by case", async () => {
    const prisma = {
      worktreeTag: {
        findMany: vi.fn().mockResolvedValue([{ id: "tag-1", name: "Ready" }]),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);

    await expect(
      service().saveTag({ name: "ready", color: "green" }),
    ).rejects.toThrow("Tag names must be unique");
  });

  test("accepts activity only from the agent that owns the worktree", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({
      id: "worktree-1",
      codebaseId: "codebase-1",
      branch: "feature/AIDE-24",
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktree: { findFirst, updateMany },
    });
    const activity = {
      codebaseId: "codebase-1",
      gitDirectory: "/repo/.git",
      branch: "feature/AIDE-24",
      headSha: "def",
      upstream: "origin/feature/AIDE-24",
      ahead: 1,
      behind: 0,
      syncState: "AHEAD" as const,
      baseAhead: 2,
      baseBehind: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: true,
      observedAt: new Date(0).toISOString(),
    };

    await expect(
      service().reportActivity("agent-1", activity),
    ).resolves.toEqual({
      worktreeId: "worktree-1",
      branch: "feature/AIDE-24",
      headSha: "def",
      upstream: "origin/feature/AIDE-24",
      ahead: 1,
      behind: 0,
      syncState: "AHEAD",
      baseAhead: 2,
      baseBehind: 0,
      hasStagedChanges: false,
      hasUnstagedChanges: true,
      observedAt: activity.observedAt,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "worktree-1",
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(0) } }],
      },
      data: {
        branch: "feature/AIDE-24",
        headSha: "def",
        upstream: "origin/feature/AIDE-24",
        ahead: 1,
        behind: 0,
        syncState: "AHEAD",
        baseAhead: 2,
        baseBehind: 0,
        lastCheckedAt: new Date(0),
        hasStagedChanges: false,
        hasUnstagedChanges: true,
      },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ codebase: { agentId: "agent-1" } }),
      }),
    );

    findFirst.mockResolvedValueOnce(null);
    await expect(service().reportActivity("agent-2", activity)).rejects.toThrow(
      "source was not found",
    );
  });

  test("atomically ignores activity older than the stored observation", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    getPrismaClient.mockResolvedValue({
      worktree: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: "worktree-1", codebaseId: "codebase-1" }),
        updateMany,
      },
    });
    const publish = vi.spyOn(agentEventBus, "publish");

    await service().reportActivity("agent-1", {
      codebaseId: "codebase-1",
      gitDirectory: "/repo/.git",
      branch: "stale-branch",
      observedAt: new Date(5).toISOString(),
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "worktree-1",
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(5) } }],
        },
      }),
    );
    expect(publish).not.toHaveBeenCalledWith(
      WORKTREE_CHANGED_TOPIC,
      expect.anything(),
    );
    publish.mockRestore();
  });

  test("deletes a hidden inspection job when inspection fails", async () => {
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob: vi.fn().mockResolvedValue({ id: "inspect-1" }),
      getJob: vi.fn().mockResolvedValue({
        id: "inspect-1",
        status: "FAILED",
        resultJson: null,
        error: "Inspection failed",
      }),
    } as unknown as AgentControlService;
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          id: "worktree-1",
          codebaseId: "codebase-1",
          folder: "/repo",
          gitDirectory: "/repo/.git",
          baseBranchOverride: null,
          missingAt: null,
          availability: "AVAILABLE",
          codebase: {
            agentId: "agent-1",
            defaultBranch: "main",
            agent: {
              lastSeenAt: new Date(),
              disconnectedAt: null,
              capabilitiesJson: JSON.stringify(["worktree.inspect"]),
            },
            repository: { canonicalOrigin: "github.com/openai/codex" },
          },
        }),
      },
      agentJob: { findFirst: vi.fn().mockResolvedValue(null), deleteMany },
      worktreeMove: { findFirst: vi.fn().mockResolvedValue(null) },
    });

    await expect(
      service(control).inspect("worktree-1", "request-1"),
    ).rejects.toThrow("Inspection failed");
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "inspect-1", visibility: "SYSTEM" },
    });
  });

  test("waits for a racing diff job and retries lazy diff inspection", async () => {
    const conflict = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["codebaseId"] },
    });
    const createJob = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ id: "diff-2" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn((id: string) =>
        Promise.resolve(
          id === "diff-active"
            ? {
                id,
                status: "SUCCEEDED",
                resultJson: '{"diff":{"files":[]}}',
                error: null,
              }
            : {
                id,
                status: "SUCCEEDED",
                resultJson: '{"diff":{"patch":"+ready"}}',
                error: null,
              },
        ),
      ),
    } as unknown as AgentControlService;
    const runnable = {
      id: "worktree-1",
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      baseBranchOverride: null,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        agentId: "agent-1",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify(["worktree.diff.inspect"]),
        },
        repository: { canonicalOrigin: "github.com/openai/codex" },
      },
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "diff-active",
        idempotencyKey: "another-request",
        kind: "worktree.diff.inspect",
      })
      .mockResolvedValueOnce(null);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(runnable) },
      agentJob: { findFirst, deleteMany },
    });

    await expect(
      service(control).inspectDiff(
        "worktree-1",
        { scope: "BRANCH", path: "Sources/App.swift" },
        "request-2",
      ),
    ).resolves.toEqual({ patch: "+ready" });
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "diff-2", visibility: "SYSTEM" },
    });
  });

  test("holds a Git state inspection behind unrelated codebase work", async () => {
    const createJob = vi.fn().mockResolvedValue({ id: "git-state-1" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn((id: string) =>
        Promise.resolve({
          id,
          status: "SUCCEEDED",
          resultJson:
            id === "sync-active"
              ? "{}"
              : JSON.stringify({
                  state: {
                    dirty: true,
                    branches: [],
                    branchesTruncated: false,
                    stashes: [],
                    stashesTruncated: false,
                  },
                }),
          error: null,
        }),
      ),
    } as unknown as AgentControlService;
    const runnable = {
      id: "worktree-1",
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      baseBranchOverride: null,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        agentId: "agent-1",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify([WORKTREE_GIT_INSPECT_JOB_KIND]),
        },
        repository: { canonicalOrigin: "github.com/openai/codex" },
      },
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "sync-active",
        idempotencyKey: "another-request",
        kind: "worktree.operation",
      })
      .mockResolvedValueOnce(null);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(runnable) },
      agentJob: { findFirst, deleteMany },
    });

    await expect(
      service(control).inspectGitState("worktree-1", "request-1"),
    ).resolves.toMatchObject({ dirty: true });
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(createJob).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: WORKTREE_GIT_INSPECT_JOB_KIND }),
    );
  });

  test("serializes diff image transfers behind other diff jobs", async () => {
    const createJob = vi.fn().mockResolvedValue({ id: "asset-job" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn((id: string) =>
        Promise.resolve({
          id,
          status: "SUCCEEDED",
          resultJson: '{"exitCode":0}',
          error: null,
        }),
      ),
    } as unknown as AgentControlService;
    const runnable = {
      id: "worktree-1",
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      baseBranchOverride: null,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        agentId: "agent-1",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify([WORKTREE_DIFF_ASSET_JOB_KIND]),
        },
        repository: { canonicalOrigin: "github.com/openai/codex" },
      },
    };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "diff-active",
        idempotencyKey: "another-request",
        kind: "worktree.diff.inspect",
      })
      .mockResolvedValueOnce(null);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktree: { findUnique: vi.fn().mockResolvedValue(runnable) },
      agentJob: { findFirst, deleteMany },
    });

    await service(control).prepareDiffAsset(
      "worktree-1",
      {
        scope: "STAGED",
        path: "after.png",
        previousPath: "before.png",
        side: "BEFORE",
      },
      "upload-1",
    );

    expect(createJob).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: WORKTREE_DIFF_ASSET_JOB_KIND,
        payload: expect.objectContaining({ previousPath: "before.png" }),
      }),
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: "asset-job", visibility: "SYSTEM" },
    });
  });

  test("starts a demand-scoped watcher and stops it after unsubscribe", async () => {
    const createJob = vi
      .fn()
      .mockResolvedValueOnce({ id: "watch-start" })
      .mockResolvedValueOnce({ id: "watch-stop" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
      getJob: vi.fn((id: string) =>
        Promise.resolve({
          id,
          status: "SUCCEEDED",
          resultJson: '{"exitCode":0}',
          error: null,
        }),
      ),
    } as unknown as AgentControlService;
    const runnable = {
      id: "worktree-1",
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      baseBranchOverride: null,
      missingAt: null,
      availability: "AVAILABLE",
      codebase: {
        agentId: "agent-1",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify(["worktree.watch"]),
        },
        repository: { canonicalOrigin: "github.com/openai/codex" },
      },
    };
    const prisma = {
      worktree: {
        findUnique: vi.fn().mockResolvedValue(runnable),
        findFirst: vi.fn().mockResolvedValue({ id: "worktree-1" }),
      },
      agentJob: {
        findFirst: vi.fn().mockResolvedValue({ id: "active-operation" }),
        deleteMany: vi.fn(),
      },
    };
    getPrismaClient.mockResolvedValue(prisma);
    const worktrees = service(control);
    const iterator = worktrees.subscribeInspection("worktree-1");
    const next = iterator.next();
    await vi.waitFor(() => expect(control.createJob).toHaveBeenCalledTimes(1));

    await worktrees.reportActivity("agent-1", {
      codebaseId: "codebase-1",
      gitDirectory: "/repo/.git",
      observedAt: new Date(0).toISOString(),
    });
    await expect(next).resolves.toMatchObject({
      value: {
        worktreeInspectionChanged: { worktreeId: "worktree-1" },
      },
    });
    await iterator.return(undefined);

    expect(control.createJob).toHaveBeenCalledTimes(2);
    expect(prisma.agentJob.findFirst).not.toHaveBeenCalled();
    expect(control.createJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "worktree.watch",
        payload: expect.objectContaining({ action: "START" }),
      }),
    );
    expect(control.createJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: "worktree.watch",
        payload: expect.objectContaining({ action: "STOP" }),
      }),
    );
    expect(createJob.mock.calls[0]?.[0]).not.toHaveProperty("codebaseId");
    expect(createJob.mock.calls[1]?.[0]).not.toHaveProperty("codebaseId");
  });

  test("starts a durable move only for a clean matching repository checkout", async () => {
    const source = {
      id: "worktree-source",
      codebaseId: "codebase-source",
      folder: "/source-linked",
      gitDirectory: "/source/.git/worktrees/source-linked",
      branch: "feature/move",
      headSha: "abc",
      primary: false,
      missingAt: null,
      availability: "AVAILABLE",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      pushStatus: "READY",
      codebase: {
        id: "codebase-source",
        agentId: "agent-source",
        repositoryId: "repository-1",
        folder: "/source",
        defaultBranch: "main",
        agent: {
          lastSeenAt: new Date(),
          disconnectedAt: null,
          capabilitiesJson: JSON.stringify([
            WORKTREE_MOVE_PUSH_JOB_KIND,
            "worktree.delete",
          ]),
        },
        repository: {
          canonicalOrigin: "github.com/openai/codex",
        },
      },
    };
    const target = {
      id: "codebase-target",
      agentId: "agent-target",
      repositoryId: "repository-1",
      folder: "/target",
      defaultBranch: "main",
      availability: "AVAILABLE",
      agent: {
        lastSeenAt: new Date(),
        disconnectedAt: null,
        capabilitiesJson: JSON.stringify([WORKTREE_MOVE_CHECKOUT_JOB_KIND]),
      },
      repository: { canonicalOrigin: "github.com/openai/codex" },
    };
    const move = {
      id: "move-1",
      requestId: "request-1",
      sourceWorktreeId: source.id,
      sourceCodebaseId: source.codebaseId,
      targetCodebaseId: target.id,
      targetWorktreeId: null,
      destinationMode: "NEW",
      branch: source.branch,
      headSha: source.headSha,
      baseBranch: "main",
      deleteSource: true,
      status: "PUSHING",
      sourceJobId: null,
    };
    const update = vi.fn().mockImplementation(({ data }) => ({
      ...move,
      ...data,
    }));
    getPrismaClient.mockResolvedValue({
      worktree: {
        findUnique: vi.fn().mockResolvedValue(source),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      codebase: { findUnique: vi.fn().mockResolvedValue(target) },
      agentJob: { findFirst: vi.fn().mockResolvedValue(null) },
      worktreeMove: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(move),
        update,
      },
    });
    const createJob = vi.fn().mockResolvedValue({ id: "push-job" });
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob,
    } as unknown as AgentControlService;

    await expect(
      service(control).moveWorktree({
        sourceWorktreeId: source.id,
        targetCodebaseId: target.id,
        targetWorktreeId: null,
        deleteSource: true,
        requestId: "request-1",
      }),
    ).resolves.toMatchObject({ sourceJobId: "push-job" });
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: WORKTREE_MOVE_PUSH_JOB_KIND,
        agentId: "agent-source",
        payload: expect.objectContaining({
          branch: "feature/move",
          expectedHeadSha: "abc",
        }),
      }),
    );
  });

  test("advances a successful source push into destination checkout", async () => {
    const handlers = new Map<string, (job: never) => Promise<void>>();
    const createJob = vi.fn().mockResolvedValue({ id: "checkout-job" });
    const control = {
      registerCompletionHandler: vi.fn((kind, handler) =>
        handlers.set(kind, handler),
      ),
      createJob,
    } as unknown as AgentControlService;
    const move = {
      id: "move-1",
      sourceWorktreeId: "source-worktree",
      sourceCodebaseId: "source-codebase",
      targetCodebaseId: "target-codebase",
      targetWorktreeId: null,
      destinationMode: "NEW",
      branch: "feature/move",
      headSha: "abc",
      baseBranch: "main",
      status: "PUSHING",
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktreeMove: {
        findUnique: vi.fn().mockResolvedValue(move),
        updateMany,
      },
      codebase: {
        findUnique: vi.fn().mockResolvedValue({
          id: "target-codebase",
          agentId: "target-agent",
          folder: "/target",
          agent: {
            lastSeenAt: new Date(),
            disconnectedAt: null,
            capabilitiesJson: JSON.stringify([WORKTREE_MOVE_CHECKOUT_JOB_KIND]),
          },
          repository: { canonicalOrigin: "github.com/openai/codex" },
        }),
      },
      worktree: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    service(control);

    await handlers.get(WORKTREE_MOVE_PUSH_JOB_KIND)!({
      id: "push-job",
      payloadJson: JSON.stringify({ moveId: move.id }),
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        branch: move.branch,
        headSha: move.headSha,
      }),
      error: null,
    } as never);

    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: WORKTREE_MOVE_CHECKOUT_JOB_KIND,
        agentId: "target-agent",
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CHECKING_OUT",
          targetJobId: "checkout-job",
        }),
      }),
    );
  });

  test("persists a recoverable stash decision from destination checkout", async () => {
    const handlers = new Map<string, (job: never) => Promise<void>>();
    const control = {
      registerCompletionHandler: vi.fn((kind, handler) =>
        handlers.set(kind, handler),
      ),
    } as unknown as AgentControlService;
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      worktreeMove: {
        findUnique: vi.fn().mockResolvedValue({
          id: "move-1",
          sourceWorktreeId: "source-worktree",
          sourceCodebaseId: "source-codebase",
          status: "CHECKING_OUT",
        }),
        updateMany,
      },
    });
    service(control);

    await handlers.get(WORKTREE_MOVE_CHECKOUT_JOB_KIND)!({
      id: "checkout-job",
      payloadJson: JSON.stringify({ moveId: "move-1" }),
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        outcome: "NEEDS_STASH",
        message: "README.md would be overwritten",
      }),
      error: null,
    } as never);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AWAITING_STASH",
          error: "README.md would be overwritten",
        }),
      }),
    );
  });
});

describe("worktreeDisplayPath", () => {
  test("uses the agent repository root for paths inside it", () => {
    expect(
      worktreeDisplayPath(
        "/Users/test/Repositories/codex/.worktrees/feature",
        "/Users/test/Repositories",
      ),
    ).toBe("codex/.worktrees/feature");
  });

  test("uses the full directory for worktrees outside the repository root", () => {
    expect(
      worktreeDisplayPath(
        "/Users/test/Worktrees/feature",
        "/Users/test/Repositories",
      ),
    ).toBe("/Users/test/Worktrees/feature");
  });

  test("uses the full directory when no root is configured", () => {
    expect(worktreeDisplayPath("/Users/test/Repositories/codex", null)).toBe(
      "/Users/test/Repositories/codex",
    );
  });

  test("handles Windows repository directories on a non-Windows server", () => {
    expect(
      worktreeDisplayPath(
        "C:\\Users\\test\\Repositories\\codex",
        "C:\\Users\\test\\Repositories",
      ),
    ).toBe("codex");
    expect(
      worktreeDisplayPath(
        "D:\\Worktrees\\feature",
        "C:\\Users\\test\\Repositories",
      ),
    ).toBe("D:\\Worktrees\\feature");
  });
});
