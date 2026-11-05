import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/services/operation-locks/operation-locks.service", () => ({
  recoverMergeReservations: vi.fn(async () => {}),
}));

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { WORKTREE_AUTO_SYNC_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import type { WorktreeAutoMerge } from "@/generated/prisma/client";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { PollingService } from "@/services/polling";
import type { WorkflowsService } from "@/services/workflows";

import { WorktreeAutomationService } from "./worktree-automation.service";
import type { WorktreesService } from "./worktrees.service";
import { CodebaseBusyError } from "@/lib/codebase-busy";
import { LEGACY_CODEBASE_BUSY_MESSAGE } from "./merge-branch-sync";

type CompletionObserver = Parameters<
  AgentControlService["registerCompletionObserver"]
>[0];

function dependencies() {
  let completionObserver: CompletionObserver | undefined;
  const agentControl = {
    registerConnectionHandler: vi.fn(),
    registerCompletionObserver: vi.fn((observer: CompletionObserver) => {
      completionObserver = observer;
    }),
  } as unknown as AgentControlService;
  const polling = {
    register: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
  } as unknown as PollingService;

  new WorktreeAutomationService(
    {} as WorktreesService,
    {} as GitHubService,
    {} as JiraService,
    {} as WorkflowsService,
    agentControl,
    polling,
  );

  return { completionObserver: () => completionObserver, polling };
}

function completedJob(kind: string) {
  return {
    id: "job-1",
    agentId: "agent-1",
    codebaseId: "codebase-1",
    worktreeId: "worktree-1",
    buildDataCollectionId: null,
    kind,
    payloadJson: "{}",
    status: "SUCCEEDED",
    resultJson: "{}",
    error: null,
  };
}

function retargetFixture() {
  const worktree = {
    id: "wt",
    codebaseId: "cb",
    primary: false,
    branch: "feature",
    headSha: "a".repeat(40),
    codebase: {
      defaultBranch: "main",
      repository: {
        canonicalOrigin: "github.com/acme/widgets",
        defaultBranchPatternsJson: "[]",
      },
    },
  };
  let rule: WorktreeAutoMerge = {
    worktreeId: worktree.id,
    state: "WAITING_REQUIREMENTS",
    autoSync: false,
    syncStateJson: null,
    baseBranchUpdatesJson: null,
    repositoryNameWithOwner: "acme/widgets",
    pullRequestNumber: 17,
    branch: worktree.branch,
    mergeMethod: "SQUASH",
    commitHeadline: "Old",
    commitBody: "",
    authorEmail: null,
    deleteWorktree: false,
    moveTicketToDone: false,
    ticketKey: null,
    ticketMovedAt: null,
    deleteJobId: null,
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const update = vi.fn(
    async ({ data }: { data: Partial<WorktreeAutoMerge> }) =>
      (rule = { ...rule, ...data }),
  );
  const upsert = vi.fn(
    async ({ update }: { update: Partial<WorktreeAutoMerge> }) =>
      (rule = { ...rule, ...update }),
  );
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  getPrismaClient.mockResolvedValue({
    worktree: { findFirst: vi.fn().mockResolvedValue(worktree) },
    worktreeAutoMerge: {
      findUnique: vi.fn(async () => ({ ...rule })),
      findMany: vi.fn(async () => [{ ...rule, worktree }]),
      upsert,
      update,
      deleteMany,
    },
  });
  const remote = {
    state: "OPEN",
    headRefName: worktree.branch,
    headRefOid: worktree.headSha,
    headRepositoryNameWithOwner: "acme/widgets",
    autoMergeEnabled: false,
  };
  const github = {
    pullRequestAutomationState: vi.fn(
      async (_owner: string, _name: string, _number: number) => remote,
    ),
    pullRequestMergeOptions: vi.fn(
      async (_owner: string, _name: string, _number: number) => ({
        canMerge: true,
        blockedReason: null,
        canAutoMergeWithSync: true,
        availableMethods: ["SQUASH"],
      }),
    ),
    mergePullRequest: vi.fn(async () => ({ state: "MERGED" })),
  };
  const jira = {
    transitionTicketToConfiguredAutoMerge: vi.fn().mockResolvedValue(null),
  };
  const ticketKeyForWorktree = vi.fn().mockResolvedValue(null);
  const automation = new WorktreeAutomationService(
    {
      ticketKeyForWorktree,
      publishAutomationChange: vi.fn(),
    } as unknown as WorktreesService,
    github as unknown as GitHubService,
    jira as unknown as JiraService,
    {} as WorkflowsService,
    {
      registerCompletionObserver: vi.fn(),
      registerConnectionHandler: vi.fn(),
    } as unknown as AgentControlService,
  );
  vi.spyOn(
    automation as unknown as { changed(): void },
    "changed",
  ).mockImplementation(() => {});
  return {
    automation,
    github,
    upsert,
    jira,
    ticketKeyForWorktree,
    worktree,
    deleteMany,
    current: () => rule,
    remote,
    reconcile: () =>
      (
        automation as unknown as { reconcileAutoMerge(): Promise<void> }
      ).reconcileAutoMerge(),
    input: {
      worktreeId: worktree.id,
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 22,
      method: "SQUASH" as const,
      commitHeadline: "New",
      commitBody: "",
      deleteWorktree: false,
      moveTicketToDone: false,
    },
  };
}

describe("WorktreeAutomationService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    getPrismaClient.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  test("reconciles immediately when an Auto Sync job completes", async () => {
    const { completionObserver, polling } = dependencies();

    await completionObserver()?.(completedJob(WORKTREE_AUTO_SYNC_JOB_KIND));
    await vi.advanceTimersByTimeAsync(0);

    expect(polling.run).toHaveBeenCalledWith(
      "server:worktree-automations",
      expect.any(Function),
    );
  });

  test("reconciles when another codebase Git operation completes", async () => {
    const { completionObserver, polling } = dependencies();
    await completionObserver()?.(completedJob("worktree.git.operation"));
    await vi.advanceTimersByTimeAsync(0);
    expect(polling.run).toHaveBeenCalledOnce();
  });

  test("does not reconcile for completed jobs without a codebase", async () => {
    const { completionObserver, polling } = dependencies();

    await completionObserver()?.({
      ...completedJob("usage.collect"),
      codebaseId: null,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(polling.run).not.toHaveBeenCalled();
  });

  test("disables the previous pull request when Auto Merge is retargeted", async () => {
    const existing = {
      worktreeId: "worktree-1",
      state: "ACTIVE",
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 17,
      branch: "feature/AIDE-71",
      mergeMethod: "SQUASH",
      commitHeadline: "Old headline",
      commitBody: "Old body",
      authorEmail: null,
      deleteWorktree: false,
      moveTicketToDone: false,
      ticketKey: null,
      ticketMovedAt: null,
      deleteJobId: null,
      lastError: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const updated = {
      ...existing,
      repositoryNameWithOwner: "acme/widgets-next",
      pullRequestNumber: 22,
      commitHeadline: "New headline",
      updatedAt: new Date(1),
    };
    const upsert = vi.fn().mockResolvedValue(updated);
    getPrismaClient.mockResolvedValue({
      worktree: {
        findFirst: vi.fn().mockResolvedValue({
          id: "worktree-1",
          primary: false,
          branch: "feature/AIDE-71",
          codebaseId: "codebase-1",
          codebase: {
            repository: { canonicalOrigin: "github.com/acme/widgets" },
          },
        }),
      },
      worktreeAutoMerge: {
        findUnique: vi.fn().mockResolvedValue(existing),
        upsert,
      },
    });
    const enablePullRequestAutoMerge = vi.fn().mockResolvedValue(undefined);
    const disablePullRequestAutoMerge = vi.fn().mockResolvedValue(undefined);
    const github = {
      pullRequestAutomationState: vi.fn(
        async (_owner: string, _name: string, number: number) =>
          number === 22
            ? {
                state: "OPEN",
                headRefName: "feature/AIDE-71",
                headRepositoryNameWithOwner: "acme/widgets",
              }
            : { state: "OPEN", autoMergeEnabled: true },
      ),
      enablePullRequestAutoMerge,
      disablePullRequestAutoMerge,
      pullRequestMergeOptions: vi.fn().mockResolvedValue({
        canAutoMergeWithSync: true,
        availableMethods: ["SQUASH"],
      }),
    } as unknown as GitHubService;
    const worktrees = {
      ticketKeyForWorktree: vi.fn().mockResolvedValue(null),
      publishAutomationChange: vi.fn(),
    } as unknown as WorktreesService;
    const agentControl = {
      registerCompletionObserver: vi.fn(),
      registerConnectionHandler: vi.fn(),
    } as unknown as AgentControlService;
    const automation = new WorktreeAutomationService(
      worktrees,
      github,
      {} as JiraService,
      {} as WorkflowsService,
      agentControl,
    );
    vi.spyOn(
      automation as unknown as { changed: () => void },
      "changed",
    ).mockImplementation(() => undefined);

    await automation.configureAutoMerge({
      worktreeId: "worktree-1",
      repositoryNameWithOwner: "acme/widgets-next",
      pullRequestNumber: 22,
      method: "SQUASH",
      commitHeadline: "New headline",
      commitBody: "New body",
      deleteWorktree: false,
      moveTicketToDone: false,
    });

    expect(disablePullRequestAutoMerge).toHaveBeenCalledWith(
      {
        owner: "acme",
        name: "widgets",
        number: 17,
      },
      "WORKTREE_AUTOMATION",
    );
    expect(enablePullRequestAutoMerge).not.toHaveBeenCalled();
    expect(
      disablePullRequestAutoMerge.mock.invocationCallOrder[0],
    ).toBeLessThan(
      upsert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ pauseReason: expect.anything() }),
      }),
    );
  });

  test("waits for the previous PR worker before retargeting its worktree", async () => {
    const f = retargetFixture();
    const reached = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    f.github.pullRequestMergeOptions.mockImplementation(
      async (_owner, _name, number) => {
        if (number === 17) {
          reached.resolve();
          await proceed.promise;
        }
        return {
          canMerge: true,
          blockedReason: null,
          canAutoMergeWithSync: true,
          availableMethods: ["SQUASH"],
        };
      },
    );
    const worker = f.reconcile();
    await reached.promise;
    const retarget = f.automation.configureAutoMerge(f.input);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.upsert).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      await Promise.all([worker, retarget]);
    }
    expect(f.github.mergePullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ number: 17 }),
      "WORKTREE_AUTOMATION",
    );
    expect(f.current()).toMatchObject({
      pullRequestNumber: 22,
      state: "WAITING_REQUIREMENTS",
    });
  });

  test("ignores a discovered rule retargeted before its worker acquires the worktree", async () => {
    const f = retargetFixture();
    const reached = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    f.github.pullRequestAutomationState.mockImplementation(
      async (_owner, _name, number) => {
        if (number === 22) {
          reached.resolve();
          await proceed.promise;
        }
        return f.remote;
      },
    );
    const retarget = f.automation.configureAutoMerge(f.input);
    await reached.promise;
    const worker = f.reconcile();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(f.github.mergePullRequest).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      await Promise.all([retarget, worker]);
    }
    expect(f.github.mergePullRequest).not.toHaveBeenCalled();
    expect(f.current()).toMatchObject({
      pullRequestNumber: 22,
      state: "WAITING_REQUIREMENTS",
    });
  });

  test("unrelated pull requests can configure Auto Merge independently", async () => {
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const upsert = vi.fn(async ({ create }) => ({
      ...create,
      updatedAt: new Date(),
    }));
    getPrismaClient.mockResolvedValue({
      worktree: {
        findFirst: vi.fn(async ({ where }) => ({
          id: where.id,
          primary: false,
          branch: "feature",
          codebaseId: "cb",
          codebase: { repository: { canonicalOrigin: "github.com/team/repo" } },
        })),
      },
      worktreeAutoMerge: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert,
      },
    });
    const github = {
      pullRequestAutomationState: vi.fn(async (_owner, _name, number) => {
        if (number === 1) await gate;
        return {
          state: "OPEN",
          headRefName: "feature",
          headRepositoryNameWithOwner: "team/repo",
          autoMergeEnabled: false,
        };
      }),
      pullRequestMergeOptions: vi.fn().mockResolvedValue({
        canAutoMergeWithSync: true,
        availableMethods: ["SQUASH"],
      }),
    };
    const automation = new WorktreeAutomationService(
      {
        ticketKeyForWorktree: vi.fn().mockResolvedValue(null),
        publishAutomationChange: vi.fn(),
      } as unknown as WorktreesService,
      github as unknown as GitHubService,
      {} as JiraService,
      {} as WorkflowsService,
      {
        registerCompletionObserver: vi.fn(),
        registerConnectionHandler: vi.fn(),
      } as unknown as AgentControlService,
    );
    vi.spyOn(
      automation as unknown as { changed(): void },
      "changed",
    ).mockImplementation(() => {});
    const input = {
      worktreeId: "first",
      repositoryNameWithOwner: "team/repo",
      pullRequestNumber: 1,
      method: "SQUASH" as const,
      commitHeadline: "Merge",
      commitBody: "",
      deleteWorktree: false,
      moveTicketToDone: false,
    };
    const first = automation.configureAutoMerge(input);
    try {
      await expect(
        automation.configureAutoMerge({
          ...input,
          worktreeId: "second",
          pullRequestNumber: 2,
        }),
      ).resolves.toMatchObject({ worktreeId: "second" });
      expect(upsert).toHaveBeenCalledOnce();
    } finally {
      unblock();
      await first;
    }
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      name: "branch",
      worktreeBranch: "feature/other",
      worktreeHead: "pr-head",
      error: "worktree branch changed",
    },
    {
      name: "HEAD",
      worktreeBranch: "feature/AIDE-71",
      worktreeHead: "local-only-head",
      error: "worktree HEAD does not match",
    },
  ])(
    "does not delete a worktree when its $name no longer matches the merged PR",
    async ({ worktreeBranch, worktreeHead, error }) => {
      const updateMany = vi.fn().mockResolvedValue({ count: 1 });
      getPrismaClient.mockResolvedValue({
        worktreeAutoMerge: {
          findMany: vi.fn().mockResolvedValue([
            {
              worktreeId: "worktree-1",
              state: "POST_MERGE",
              repositoryNameWithOwner: "acme/widgets",
              pullRequestNumber: 17,
              branch: "feature/AIDE-71",
              deleteWorktree: true,
              moveTicketToDone: false,
              ticketKey: null,
              ticketMovedAt: null,
              deleteJobId: null,
              worktree: {
                codebaseId: "codebase-1",
                branch: worktreeBranch,
                headSha: worktreeHead,
                primary: false,
                codebase: {
                  repository: { canonicalOrigin: "github.com/acme/widgets" },
                },
              },
            },
          ]),
          update: vi.fn(),
          updateMany,
        },
      });
      const deleteWorktree = vi.fn();
      const worktrees = {
        deleteWorktree,
        publishAutomationChange: vi.fn(),
      } as unknown as WorktreesService;
      const github = {
        pullRequestAutomationState: vi.fn().mockResolvedValue({
          state: "MERGED",
          headRefName: "feature/AIDE-71",
          headRefOid: "pr-head",
          headRepositoryNameWithOwner: "acme/widgets",
        }),
      } as unknown as GitHubService;
      const agentControl = {
        registerCompletionObserver: vi.fn(),
        registerConnectionHandler: vi.fn(),
      } as unknown as AgentControlService;
      const automation = new WorktreeAutomationService(
        worktrees,
        github,
        {} as JiraService,
        {} as WorkflowsService,
        agentControl,
      );

      await (
        automation as unknown as { reconcileAutoMerge(): Promise<void> }
      ).reconcileAutoMerge();

      expect(deleteWorktree).not.toHaveBeenCalled();
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: "ACTION_REQUIRED",
            lastError: expect.stringContaining(error),
          }),
        }),
      );
    },
  );

  test("pins safe post-merge deletion to the merged PR head", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    getPrismaClient.mockResolvedValue({
      worktreeAutoMerge: {
        findMany: vi.fn().mockResolvedValue([
          {
            worktreeId: "worktree-1",
            state: "POST_MERGE",
            repositoryNameWithOwner: "acme/widgets",
            pullRequestNumber: 17,
            branch: "feature/AIDE-71",
            deleteWorktree: true,
            moveTicketToDone: false,
            ticketKey: null,
            ticketMovedAt: null,
            deleteJobId: null,
            worktree: {
              codebaseId: "codebase-1",
              branch: "feature/AIDE-71",
              headSha: "pr-head",
              primary: false,
              codebase: {
                repository: { canonicalOrigin: "github.com/acme/widgets" },
              },
            },
          },
        ]),
        update,
        updateMany: vi.fn(),
      },
    });
    const deleteWorktree = vi.fn().mockResolvedValue({ id: "delete-job" });
    const worktrees = {
      deleteWorktree,
      publishAutomationChange: vi.fn(),
    } as unknown as WorktreesService;
    const github = {
      pullRequestAutomationState: vi.fn().mockResolvedValue({
        state: "MERGED",
        headRefName: "feature/AIDE-71",
        headRefOid: "pr-head",
        headRepositoryNameWithOwner: "acme/widgets",
      }),
    } as unknown as GitHubService;
    const agentControl = {
      registerCompletionObserver: vi.fn(),
      registerConnectionHandler: vi.fn(),
    } as unknown as AgentControlService;
    const automation = new WorktreeAutomationService(
      worktrees,
      github,
      {} as JiraService,
      {} as WorkflowsService,
      agentControl,
    );

    await (
      automation as unknown as { reconcileAutoMerge(): Promise<void> }
    ).reconcileAutoMerge();

    expect(deleteWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        requireClean: true,
        expectedBranch: "feature/AIDE-71",
        expectedHeadSha: "pr-head",
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deleteJobId: "delete-job", lastError: null },
      }),
    );
  });
});

function syncFixture() {
  const rule = {
    worktreeId: "wt-1",
    state: "ACTIVE",
    branch: "feature",
    conflictWorkflowId: null as string | null,
    conflictWorkflowChoice: null,
    activeJobId: null as string | null,
    workflowRunId: null as string | null,
    lastError: null as string | null,
    pauseReason: null as string | null,
    lastSyncedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(),
    worktree: { codebaseId: "cb" },
  };
  const rules = [rule];
  const jobs: Array<{
    id: string;
    worktreeId: string;
    codebaseId: string;
    kind: string;
    payloadJson: string;
    resultJson: string | null;
    status: string;
    createdAt: Date;
    finishedAt: Date | null;
  }> = [];
  const database = {
    worktreeAutoSync: {
      findMany: vi.fn(async () =>
        rules.filter(
          (row) =>
            ["ACTIVE", "SYNCING", "RESOLVING"].includes(row.state) ||
            (row.state === "PAUSED" &&
              row.pauseReason === "ERROR" &&
              row.lastError === LEGACY_CODEBASE_BUSY_MESSAGE),
        ),
      ),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = rules.find(
          (entry) =>
            entry.worktreeId === where.worktreeId &&
            (!where.state || entry.state === where.state) &&
            (!where.lastError || entry.lastError === where.lastError),
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = rules.find(
          (entry) => entry.worktreeId === where.worktreeId,
        )!;
        Object.assign(row, data);
        return row;
      }),
    },
    worktree: {
      findUnique: vi.fn(async () => ({
        branch: "feature",
        codebaseId: "cb",
        folder: "/wt",
        gitDirectory: "/git/wt",
        codebase: { repository: { canonicalOrigin: "github.com/team/repo" } },
      })),
    },
    worktreeAutoMerge: { findFirst: vi.fn(async () => null) },
    gitLabMergeOperation: { findFirst: vi.fn(async () => null) },
    workflowRun: { findMany: vi.fn(async () => [{ id: "resolver" }]) },
    agentJob: {
      findFirst: vi.fn(async () => jobs.at(-1) ?? null),
      findMany: vi.fn(async ({ where }) =>
        jobs.filter(
          (job) =>
            job.worktreeId === where.worktreeId &&
            job.codebaseId === where.codebaseId &&
            job.status === "SUCCEEDED" &&
            job.finishedAt &&
            job.finishedAt >= where.finishedAt.gte,
        ),
      ),
    },
  };
  getPrismaClient.mockResolvedValue(database);
  const createAutoSyncJob = vi.fn(async (id: string, phase: string) => {
    if (jobs.some((job) => job.status === "RUNNING"))
      throw new CodebaseBusyError();
    const job = {
      id: `job-${jobs.length}`,
      worktreeId: id,
      codebaseId: "cb",
      kind: WORKTREE_AUTO_SYNC_JOB_KIND,
      payloadJson: JSON.stringify({ expectedBranch: "feature", phase }),
      status: "RUNNING",
      resultJson: null,
      createdAt: new Date(),
      finishedAt: null,
    };
    jobs.push(job);
    return job;
  });
  const workflows = { run: vi.fn(async () => ({ status: "SUCCEEDED" })) };
  const worktrees = { createAutoSyncJob, publishAutomationChange: vi.fn() };
  const service = new WorktreeAutomationService(
    worktrees as unknown as WorktreesService,
    {} as GitHubService,
    {} as JiraService,
    workflows as unknown as WorkflowsService,
    {
      registerCompletionObserver: vi.fn(),
      registerConnectionHandler: vi.fn(),
      getJob: vi.fn(async (id: string) => jobs.find((job) => job.id === id)),
    } as unknown as AgentControlService,
  );
  const tick = () =>
    (
      service as unknown as { reconcileAutoSync(): Promise<void> }
    ).reconcileAutoSync();
  const finish = (outcome = "NO_CHANGE") => {
    Object.assign(
      jobs.find((job) => job.status === "RUNNING")!,
      {
        status: "SUCCEEDED",
        resultJson: JSON.stringify({ outcome }),
        finishedAt: new Date(),
      },
    );
  };
  return {
    rule,
    rules,
    jobs,
    database,
    createAutoSyncJob,
    workflows,
    service,
    tick,
    finish,
  };
}

describe("Auto Sync contention and recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  test("waits for another Git operation without pausing or losing its phase", async () => {
    const f = syncFixture();
    f.createAutoSyncJob.mockRejectedValueOnce(new CodebaseBusyError());
    await f.tick();
    expect(f.rule).toMatchObject({
      state: "ACTIVE",
      lastError: null,
      pauseReason: null,
    });
    expect(f.database.worktreeAutoSync.updateMany).not.toHaveBeenCalled();
    await f.tick();
    expect(f.rule.state).toBe("SYNCING");
  });

  test("keeps a completed conflict workflow while FINALIZE waits for Git", async () => {
    const f = syncFixture();
    Object.assign(f.rule, { state: "RESOLVING", workflowRunId: "resolver" });
    f.createAutoSyncJob.mockRejectedValueOnce(new CodebaseBusyError());
    await f.tick();
    expect(f.rule).toMatchObject({
      state: "RESOLVING",
      workflowRunId: "resolver",
    });
    await f.tick();
    expect(f.createAutoSyncJob).toHaveBeenLastCalledWith(
      "wt-1",
      "FINALIZE",
      "feature",
      expect.any(String),
    );
    expect(f.rule).toMatchObject({ state: "SYNCING", workflowRunId: null });
  });

  test("lets two worktrees take turns and cools down successful NO_CHANGE cycles", async () => {
    const f = syncFixture();
    f.rules.push({ ...f.rule, worktreeId: "wt-2" });
    await f.tick();
    expect(f.rules.map((row) => row.state)).toEqual(["SYNCING", "ACTIVE"]);
    f.finish();
    await f.tick();
    expect(f.rules.map((row) => row.state)).toEqual(["ACTIVE", "SYNCING"]);
    f.finish();
    await f.tick();
    await f.tick();
    expect(f.jobs).toHaveLength(2);
    expect(f.rules.every((row) => row.state === "ACTIVE")).toBe(true);
    // A fresh runtime still observes durable successful-job timestamps.
    const recent = f.database.agentJob.findMany;
    expect(recent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ codebaseId: "cb" }),
      }),
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await f.tick();
    expect(f.jobs).toHaveLength(3);
    expect(f.database.worktreeAutoSync.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ updatedAt: "asc" }, { worktreeId: "asc" }],
      }),
    );
  });

  test("recovers only the exact legacy busy pause automatically", async () => {
    const f = syncFixture();
    Object.assign(f.rule, {
      state: "PAUSED",
      pauseReason: "ERROR",
      lastError: LEGACY_CODEBASE_BUSY_MESSAGE,
    });
    f.rules.push({ ...f.rule, worktreeId: "wt-2", lastError: "Rebase failed" });
    await f.tick();
    expect(f.rule).toMatchObject({
      state: "SYNCING",
      pauseReason: null,
      lastError: null,
    });
    expect(f.rules[1]).toMatchObject({
      state: "PAUSED",
      lastError: "Rebase failed",
    });
  });

  test.each([false, true])(
    "recovers the exact completed resolver only for the same checkout (moved=%s)",
    async (moved) => {
      const f = syncFixture();
      Object.assign(f.rule, {
        state: "PAUSED",
        pauseReason: "ERROR",
        lastError: LEGACY_CODEBASE_BUSY_MESSAGE,
        conflictWorkflowId: "conflict-workflow",
      });
      f.jobs.push({
        id: "conflict-job",
        worktreeId: "wt-1",
        codebaseId: "cb",
        kind: WORKTREE_AUTO_SYNC_JOB_KIND,
        payloadJson: JSON.stringify({
          expectedBranch: "feature",
          phase: "SYNC",
          folder: moved ? "/old-wt" : "/wt",
          gitDirectory: "/git/wt",
          expectedOrigin: "github.com/team/repo",
        }),
        resultJson: JSON.stringify({ outcome: "CONFLICT" }),
        status: "SUCCEEDED",
        createdAt: new Date(Date.now() - 2_000),
        finishedAt: new Date(Date.now() - 1_000),
      });
      await f.tick();
      if (moved) {
        expect(f.database.workflowRun.findMany).not.toHaveBeenCalled();
        expect(f.workflows.run).not.toHaveBeenCalled();
        expect(f.createAutoSyncJob).toHaveBeenCalledWith(
          "wt-1",
          "SYNC",
          "feature",
          expect.any(String),
        );
        return;
      }
      expect(f.database.workflowRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            triggerSubjectKey: "auto-sync:wt-1:conflict-job",
            workflowId: "conflict-workflow",
          }),
        }),
      );
      expect(f.workflows.run).toHaveBeenCalledWith("resolver");
      expect(f.createAutoSyncJob).toHaveBeenCalledWith(
        "wt-1",
        "FINALIZE",
        "feature",
        expect.any(String),
      );
    },
  );

  test("gives managed merges the first opportunity to use a free Git slot", async () => {
    const f = syncFixture();
    const coordinator = f.service as unknown as {
      reconcile(): Promise<void>;
      reconcileAutoMerge(): Promise<void>;
      reconcileAutoSync(): Promise<void>;
    };
    const merge = vi
      .spyOn(coordinator, "reconcileAutoMerge")
      .mockResolvedValue();
    const sync = vi.spyOn(coordinator, "reconcileAutoSync").mockResolvedValue();
    await coordinator.reconcile();
    expect(merge.mock.invocationCallOrder[0]).toBeLessThan(
      sync.mock.invocationCallOrder[0]!,
    );
  });
});

describe("native GitHub Auto Merge cancellation", () => {
  function fixture() {
    const refreshPullRequest = vi.fn().mockResolvedValue({
      branch: "feature",
      codebaseId: "cb",
      codebase: { repository: { canonicalOrigin: "github.com/fork/repo" } },
      pullRequest: { number: 17, repositoryNameWithOwner: "team/repo" },
    });
    const pullRequestAutomationState = vi.fn().mockResolvedValue({
      state: "OPEN",
      autoMergeEnabled: true,
      headRefName: "feature",
      headRepositoryNameWithOwner: "fork/repo",
    });
    const disablePullRequestAutoMerge = vi.fn();
    getPrismaClient.mockResolvedValue({
      worktreeAutoMerge: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const service = new WorktreeAutomationService(
      {
        refreshPullRequest,
        publishAutomationChange: vi.fn(),
      } as unknown as WorktreesService,
      {
        pullRequestAutomationState,
        disablePullRequestAutoMerge,
      } as unknown as GitHubService,
      {} as JiraService,
      {} as WorkflowsService,
      {
        registerCompletionObserver: vi.fn(),
        registerConnectionHandler: vi.fn(),
      } as unknown as AgentControlService,
    );
    return {
      service,
      refreshPullRequest,
      pullRequestAutomationState,
      disablePullRequestAutoMerge,
    };
  }
  test("cancels a freshly resolved native request without a saved rule", async () => {
    const f = fixture();
    expect(await f.service.cancelAutoMerge("wt")).toBe(true);
    expect(f.pullRequestAutomationState).toHaveBeenCalledWith(
      "team",
      "repo",
      17,
      true,
    );
    expect(f.disablePullRequestAutoMerge).toHaveBeenCalledWith(
      { owner: "team", name: "repo", number: 17 },
      "WORKTREE_AUTOMATION",
    );
    expect(f.refreshPullRequest).toHaveBeenCalledTimes(2);
  });
  test("cancels the current native request instead of a stale saved rule", async () => {
    const f = fixture();
    getPrismaClient.mockResolvedValue({
      worktreeAutoMerge: {
        findUnique: vi.fn().mockResolvedValue({
          branch: "feature",
          repositoryNameWithOwner: "team/repo",
          pullRequestNumber: 3,
        }),
      },
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          branch: "feature",
          pullRequest: { number: 17, repositoryNameWithOwner: "team/repo" },
        }),
      },
    });
    expect(await f.service.cancelAutoMerge("wt")).toBe(true);
    expect(f.disablePullRequestAutoMerge).toHaveBeenCalledExactlyOnceWith(
      { owner: "team", name: "repo", number: 17 },
      "WORKTREE_AUTOMATION",
    );
  });
  test.each([
    { headRefName: "other", headRepositoryNameWithOwner: "fork/repo" },
    { headRefName: "feature", headRepositoryNameWithOwner: "other/repo" },
  ])(
    "rejects a native request whose source no longer matches",
    async (identity) => {
      const f = fixture();
      f.pullRequestAutomationState.mockResolvedValue({
        state: "OPEN",
        autoMergeEnabled: true,
        ...identity,
      });
      await expect(f.service.cancelAutoMerge("wt")).rejects.toThrow(
        "does not match",
      );
      expect(f.disablePullRequestAutoMerge).not.toHaveBeenCalled();
    },
  );
});

describe("GitHub post-merge contention", () => {
  function fixture(legacy: boolean) {
    const rule = {
      worktreeId: "wt",
      branch: "feature",
      state: legacy ? "ACTION_REQUIRED" : "POST_MERGE",
      lastError: legacy ? LEGACY_CODEBASE_BUSY_MESSAGE : null,
      autoSync: false,
      repositoryNameWithOwner: "team/repo",
      pullRequestNumber: 17,
      deleteWorktree: true,
      deleteJobId: null,
      moveTicketToDone: true,
      ticketKey: "AIDE-1",
      ticketMovedAt: null,
      updatedAt: new Date(),
      worktree: {
        codebaseId: "cb",
        branch: "feature",
        headSha: "head",
        primary: false,
        codebase: { repository: { canonicalOrigin: "github.com/team/repo" } },
      },
    };
    const update = vi.fn(async ({ data }) => Object.assign(rule, data));
    getPrismaClient.mockResolvedValue({
      worktreeAutoMerge: {
        findMany: vi.fn(async () => [rule]),
        update,
        updateMany: vi.fn(async ({ data }) => {
          Object.assign(rule, data);
          return { count: 1 };
        }),
      },
    });
    const deleteWorktree = vi
      .fn()
      .mockRejectedValueOnce(new CodebaseBusyError())
      .mockResolvedValue({ id: "delete" });
    const jira = {
      transitionTicketToConfiguredDone: vi.fn().mockResolvedValue(undefined),
    };
    const pullRequestAutomationState = vi.fn().mockResolvedValue({
      state: "MERGED",
      headRefName: "feature",
      headRefOid: "head",
      headRepositoryNameWithOwner: "team/repo",
    });
    const service = new WorktreeAutomationService(
      {
        deleteWorktree,
        publishAutomationChange: vi.fn(),
      } as unknown as WorktreesService,
      { pullRequestAutomationState } as unknown as GitHubService,
      jira as unknown as JiraService,
      {} as WorkflowsService,
      {
        registerCompletionObserver: vi.fn(),
        registerConnectionHandler: vi.fn(),
        getJob: vi.fn().mockResolvedValue({ status: "SUCCEEDED" }),
      } as unknown as AgentControlService,
    );
    const tick = () =>
      (
        service as unknown as { reconcileAutoMerge(): Promise<void> }
      ).reconcileAutoMerge();
    return { rule, tick, deleteWorktree, jira, pullRequestAutomationState };
  }
  test.each([false, true])(
    "waits for cleanup and recovers legacy=%s without repeating Jira",
    async (legacy) => {
      const f = fixture(legacy);
      await f.tick();
      expect(f.rule.state).toBe("POST_MERGE");
      await f.tick();
      expect(f.deleteWorktree).toHaveBeenCalledTimes(2);
      await f.tick();
      expect(f.rule.state).toBe("COMPLETED");
      expect(f.jira.transitionTicketToConfiguredDone).toHaveBeenCalledOnce();
    },
  );
  test("does not recover a legacy cleanup pause for a different merged commit", async () => {
    const f = fixture(true);
    f.pullRequestAutomationState.mockResolvedValue({
      state: "MERGED",
      headRefName: "feature",
      headRefOid: "different",
      headRepositoryNameWithOwner: "team/repo",
    });
    await f.tick();
    expect(f.rule.state).toBe("ACTION_REQUIRED");
    expect(f.deleteWorktree).not.toHaveBeenCalled();
    expect(f.jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
  });
  test("preserves legacy recovery after a transient confirmation failure", async () => {
    const f = fixture(true);
    f.pullRequestAutomationState.mockRejectedValueOnce(
      new Error("network timeout"),
    );
    await f.tick();
    expect(f.rule).toMatchObject({
      state: "ACTION_REQUIRED",
      lastError: LEGACY_CODEBASE_BUSY_MESSAGE,
    });
    await f.tick();
    expect(f.rule.state).toBe("POST_MERGE");
    expect(f.deleteWorktree).toHaveBeenCalledOnce();
  });
});

describe("auto merge Jira activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrismaClient.mockReset();
  });

  test("transitions after accepted activation, but skips an active edit and already merged requests", async () => {
    const f = retargetFixture();
    f.ticketKeyForWorktree.mockResolvedValue("APP-1");
    const first = await f.automation.configureAutoMerge(f.input);
    expect(first.ticketTransitionError).toBeNull();
    expect(f.jira.transitionTicketToConfiguredAutoMerge).toHaveBeenCalledWith(
      "APP-1",
    );
    expect(f.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      f.jira.transitionTicketToConfiguredAutoMerge.mock.invocationCallOrder[0]!,
    );
    await f.automation.configureAutoMerge(f.input);
    expect(f.jira.transitionTicketToConfiguredAutoMerge).toHaveBeenCalledOnce();
    f.current().state = "ACTION_REQUIRED";
    f.remote.state = "MERGED";
    await f.automation.configureAutoMerge(f.input);
    expect(f.jira.transitionTicketToConfiguredAutoMerge).toHaveBeenCalledOnce();
  });

  test("preserves enabled automation and returns a warning when Jira requires manual input", async () => {
    const f = retargetFixture();
    f.ticketKeyForWorktree.mockResolvedValue("APP-1");
    f.jira.transitionTicketToConfiguredAutoMerge.mockRejectedValue(
      new Error("Complete required field: Comment"),
    );
    const result = await f.automation.configureAutoMerge(f.input);
    expect(result.state).toBe("WAITING_REQUIREMENTS");
    expect(result.ticketTransitionError).toContain("Auto merge is enabled");
    expect(result.ticketTransitionError).toContain("Comment");
  });

  test("rejects default branch activation and removes an existing managed rule without merging", async () => {
    const f = retargetFixture();
    f.worktree.codebase.repository.defaultBranchPatternsJson = '["feature"]';
    await expect(f.automation.configureAutoMerge(f.input)).rejects.toThrow(
      "default branches",
    );
    await expect(
      f.automation.configureAutoSync({ worktreeId: "wt" }),
    ).rejects.toThrow("repository keep up to date");
    await f.reconcile();
    expect(f.deleteMany).toHaveBeenCalledWith({ where: { worktreeId: "wt" } });
    expect(f.github.mergePullRequest).not.toHaveBeenCalled();
  });
});

test("default branch classification stops and removes existing auto sync work", async () => {
  const cancelJob = vi.fn().mockResolvedValue(undefined);
  const lifecycle = vi.fn().mockResolvedValue(undefined);
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  getPrismaClient.mockResolvedValue({
    worktreeAutoSync: {
      findMany: vi.fn().mockResolvedValue([
        {
          worktreeId: "wt",
          branch: "feature",
          state: "SYNCING",
          activeJobId: "sync-job",
          workflowRunId: "conflict-workflow",
          worktree: { codebaseId: "cb" },
        },
      ]),
      deleteMany,
    },
    worktree: {
      findUnique: vi.fn().mockResolvedValue({
        branch: "release/next",
        codebase: {
          defaultBranch: "main",
          repository: { defaultBranchPatternsJson: '["release/*"]' },
        },
      }),
    },
  });
  const service = new WorktreeAutomationService(
    { publishAutomationChange: vi.fn() } as unknown as WorktreesService,
    {} as GitHubService,
    {} as JiraService,
    { lifecycle } as unknown as WorkflowsService,
    {
      cancelJob,
      registerCompletionObserver: vi.fn(),
      registerConnectionHandler: vi.fn(),
    } as unknown as AgentControlService,
  );
  await (
    service as unknown as { reconcileAutoSync(): Promise<void> }
  ).reconcileAutoSync();
  expect(cancelJob).toHaveBeenCalledWith("sync-job");
  expect(lifecycle).toHaveBeenCalledWith("conflict-workflow", "CANCEL");
  expect(deleteMany).toHaveBeenCalledWith({ where: { worktreeId: "wt" } });
});
