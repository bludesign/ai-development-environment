import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { WORKTREE_AUTO_SYNC_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { PollingService } from "@/services/polling";
import type { WorkflowsService } from "@/services/workflows";

import { WorktreeAutomationService } from "./worktree-automation.service";
import type { WorktreesService } from "./worktrees.service";

type CompletionObserver = Parameters<
  AgentControlService["registerCompletionObserver"]
>[0];

function dependencies() {
  let completionObserver: CompletionObserver | undefined;
  const agentControl = {
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

  test("does not reconcile for unrelated completed jobs", async () => {
    const { completionObserver, polling } = dependencies();

    await completionObserver()?.(completedJob("worktree.inspect"));
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
    } as unknown as GitHubService;
    const worktrees = {
      ticketKeyForWorktree: vi.fn().mockResolvedValue(null),
      publishAutomationChange: vi.fn(),
    } as unknown as WorktreesService;
    const agentControl = {
      registerCompletionObserver: vi.fn(),
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
    expect(
      disablePullRequestAutoMerge.mock.invocationCallOrder[0],
    ).toBeLessThan(
      enablePullRequestAutoMerge.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
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
        }),
      } as unknown as GitHubService;
      const agentControl = {
        registerCompletionObserver: vi.fn(),
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
      }),
    } as unknown as GitHubService;
    const agentControl = {
      registerCompletionObserver: vi.fn(),
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
