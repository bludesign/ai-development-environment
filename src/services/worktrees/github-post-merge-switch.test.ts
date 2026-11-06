import { beforeEach, describe, expect, test, vi } from "vitest";
import { WORKTREE_POST_MERGE_SWITCH_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { WorkflowsService } from "@/services/workflows";
import type { WorktreesService } from "./worktrees.service";
import { WorktreeAutomationService } from "./worktree-automation.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

const input = {
  owner: "acme",
  name: "widgets",
  number: 17,
  method: "SQUASH" as const,
  commitHeadline: "APP-42 Ship API",
  commitBody: "",
  worktreeId: "primary",
  switchToDefaultBranch: true,
  moveTicketToDone: true,
};

function fixture() {
  const worktree = {
    id: "primary",
    codebaseId: "codebase",
    folder: "/repo",
    gitDirectory: "/repo/.git",
    primary: true,
    branch: "feature/APP-42",
    headSha: "a".repeat(40),
    missingAt: null,
    availability: "AVAILABLE",
    baseBranchOverride: null,
    codebase: {
      defaultBranch: "main",
      remoteBranchesJson: '["main","feature/APP-42"]',
      agent: {
        capabilitiesJson: JSON.stringify([WORKTREE_POST_MERGE_SWITCH_JOB_KIND]),
      },
      repository: { canonicalOrigin: "github.com/acme/widgets" },
    },
  };
  const remote = {
    id: "pr",
    state: "OPEN",
    url: "https://github.com/acme/widgets/pull/17",
    mergedAt: null as string | null,
    headRefName: worktree.branch,
    headRefOid: worktree.headSha,
    headRepositoryNameWithOwner: "acme/widgets",
    baseRefName: "main",
    mergeCommitSha: "b".repeat(40),
  };
  let saved: Record<string, unknown> | null = null;
  const attached = () => (saved ? { ...saved, worktree: linked() } : null);
  const linked = () => ({ ...worktree, autoMerge: saved });
  const prisma = {
    worktree: {
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; branch?: string } }) =>
          (!where.id || where.id === worktree.id) &&
          (!where.branch || where.branch === worktree.branch)
            ? linked()
            : null,
      ),
      findUnique: vi.fn(async () => linked()),
      findUniqueOrThrow: vi.fn(async () => linked()),
      findMany: vi.fn(async () => []),
    },
    gitHubRepository: { findMany: vi.fn(async () => []) },
    jiraProject: { findUnique: vi.fn(async () => ({ doneStatusId: "done" })) },
    worktreeAutoMerge: {
      findFirst: vi.fn(async () => attached()),
      findUnique: vi.fn(async () => saved),
      findUniqueOrThrow: vi.fn(async () => saved),
      findMany: vi.fn(async () => (saved ? [attached()] : [])),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          saved = {
            autoSync: false,
            syncStateJson: null,
            baseBranchUpdatesJson: null,
            postMergeSwitchJson: null,
            ...saved,
            ...(saved ? update : create),
            updatedAt: new Date(),
          };
          return attached();
        },
      ),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(saved!, data, { updatedAt: new Date() });
        return attached();
      }),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(saved!, data, { updatedAt: new Date() });
        return { count: 1 };
      }),
    },
  };
  getPrismaClient.mockResolvedValue(prisma);
  const jobs = new Map<
    string,
    { id: string; status: string; error?: string }
  >();
  const agents = {
    registerCompletionObserver: vi.fn(),
    registerConnectionHandler: vi.fn(),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
  };
  const github = {
    pullRequestMergeOptions: vi.fn(async () => ({
      ...remote,
      availableMethods: ["SQUASH"],
      defaultMethod: "SQUASH",
      defaultCommitHeadline: input.commitHeadline,
      defaultCommitBody: "",
      defaultCommitEmail: null,
      defaultMoveTicketToDone: false,
      defaultDeleteWorktree: false,
      canMerge: true,
    })),
    getSettings: vi.fn(async () => ({
      defaultJiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b`,
    })),
    mergePullRequest: vi.fn(async () => {
      remote.state = "MERGED";
      remote.mergedAt = new Date().toISOString();
      return {
        id: remote.id,
        state: remote.state,
        url: remote.url,
        mergedAt: remote.mergedAt,
        mergeCommitSha: remote.mergeCommitSha,
      };
    }),
    pullRequestAutomationState: vi.fn(async () => ({ ...remote })),
  };
  const worktrees = {
    ticketKeyForWorktree: vi.fn(async () => "APP-42"),
    publishAutomationChange: vi.fn(),
    postMergeSwitch: vi.fn(async () => {
      const id = `switch-${jobs.size + 1}`;
      jobs.set(id, { id, status: "RUNNING" });
      return { id };
    }),
  };
  const jira = { transitionTicketToConfiguredDone: vi.fn(async () => ({})) };
  const service = new WorktreeAutomationService(
    worktrees as unknown as WorktreesService,
    github as unknown as GitHubService,
    jira as unknown as JiraService,
    {} as WorkflowsService,
    agents as unknown as AgentControlService,
  );
  vi.spyOn(
    service as unknown as { changed(): void },
    "changed",
  ).mockImplementation(() => {});
  const tick = () =>
    (
      service as unknown as { reconcileAutoMergeRules(): Promise<void> }
    ).reconcileAutoMergeRules();
  const row = () => {
    if (!saved) throw new Error("Merge intent has not been saved");
    return saved;
  };
  const plan = () =>
    JSON.parse(String(row().postMergeSwitchJson)) as {
      state: string;
      branch: string;
      expectedBranch: string;
      expectedHeadSha: string;
      jobId: string | null;
      requestId: string;
      lastError: string | null;
    };
  const merge = () => service.mergePullRequest(input, "WORKTREE_AUTOMATION");
  const finish = () => {
    const id = plan().jobId!;
    worktree.branch = "main";
    worktree.headSha = remote.mergeCommitSha;
    jobs.set(id, { id, status: "SUCCEEDED" });
  };
  return {
    service,
    prisma,
    worktree,
    remote,
    agents,
    github,
    worktrees,
    jira,
    jobs,
    tick,
    row,
    plan,
    merge,
    finish,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("GitHub primary checkout post-merge coordination", () => {
  test("saves immutable intent before merging and waits for the projected switch before Jira", async () => {
    const f = fixture();
    expect(await f.merge()).toMatchObject({
      state: "MERGED",
      postMergeSwitch: { branch: "main", state: "PENDING" },
    });
    expect(
      f.prisma.worktreeAutoMerge.upsert.mock.invocationCallOrder[0],
    ).toBeLessThan(f.github.mergePullRequest.mock.invocationCallOrder[0]!);
    expect(f.plan()).toMatchObject({
      branch: "main",
      expectedBranch: "feature/APP-42",
      expectedHeadSha: "a".repeat(40),
      state: "PENDING",
    });
    await f.tick();
    expect(f.worktrees.postMergeSwitch).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: "primary",
        branch: "main",
        expectedHeadSha: "a".repeat(40),
        mergeCommitSha: "b".repeat(40),
      }),
    );
    expect(f.plan().state).toBe("UPDATING");
    expect(f.jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
    await f.tick();
    expect(f.worktrees.postMergeSwitch).toHaveBeenCalledOnce();
    expect(f.jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
    f.finish();
    await f.tick();
    await f.tick();
    expect(f.plan().state).toBe("COMPLETED");
    expect(f.row().state).toBe("COMPLETED");
    expect(
      f.jira.transitionTicketToConfiguredDone,
    ).toHaveBeenCalledExactlyOnceWith("APP-42");
    expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
  });

  test.each(["target", "source", "repository"])(
    "stops follow-ups when confirmed %s differs from reviewed intent",
    async (change) => {
      const f = fixture();
      await f.merge();
      if (change === "target") f.remote.baseRefName = "release";
      else if (change === "source") f.remote.headRefOid = "c".repeat(40);
      else f.remote.headRepositoryNameWithOwner = "fork/widgets";
      await f.tick();
      expect(f.row().state).toBe("ACTION_REQUIRED");
      expect(f.worktrees.postMergeSwitch).not.toHaveBeenCalled();
      expect(f.jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
      expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
    },
  );

  test("retries only the failed switch job without submitting another merge", async () => {
    const f = fixture();
    await f.merge();
    await f.tick();
    const previous = f.plan();
    f.jobs.set(previous.jobId!, {
      id: previous.jobId!,
      status: "FAILED",
      error: "Local main diverged",
    });
    await f.tick();
    expect(f.row().state).toBe("ACTION_REQUIRED");
    expect(f.plan()).toMatchObject({
      state: "ACTION_REQUIRED",
      lastError: "Local main diverged",
    });
    await f.service.retryAutoMerge("primary");
    expect(f.plan().jobId).toBeNull();
    expect(f.plan().requestId).not.toBe(previous.requestId);
    await f.tick();
    expect(f.worktrees.postMergeSwitch).toHaveBeenCalledTimes(2);
    f.finish();
    await f.tick();
    expect(f.row().state).toBe("COMPLETED");
    expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
  });

  test("blocks checkout retry until the provider confirms the merge", async () => {
    const f = fixture();
    f.github.mergePullRequest.mockRejectedValueOnce(
      new Error("Network timeout"),
    );
    await expect(f.merge()).rejects.toThrow("Network timeout");
    expect(f.row().state).toBe("ACTION_REQUIRED");
    await expect(f.service.retryAutoMerge("primary")).rejects.toThrow(
      "merge must be confirmed",
    );
    expect(f.worktrees.postMergeSwitch).not.toHaveBeenCalled();
    expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
  });

  test("recovers an interrupted manual submission by observing confirmation without submitting again", async () => {
    const f = fixture();
    f.github.mergePullRequest.mockRejectedValueOnce(
      new Error("Connection lost after submission"),
    );
    await expect(f.merge()).rejects.toThrow("Connection lost");
    // Reproduce a process stopping after durable intent but before recording the outcome.
    f.row().state = "MERGING";
    expect(JSON.parse(String(f.row().postMergeSwitchJson))).toMatchObject({
      manualMerge: true,
    });
    await f.tick();
    expect(f.row().state).toBe("ACTION_REQUIRED");
    expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
    expect(f.worktrees.postMergeSwitch).not.toHaveBeenCalled();
    f.remote.state = "MERGED";
    f.remote.mergedAt = new Date().toISOString();
    await f.tick();
    expect(f.worktrees.postMergeSwitch).toHaveBeenCalledOnce();
    expect(f.jira.transitionTicketToConfiguredDone).not.toHaveBeenCalled();
    f.finish();
    await f.tick();
    expect(f.row().state).toBe("COMPLETED");
    expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
  });

  test("restores saved options and completed status after primary no longer matches the source branch", async () => {
    const f = fixture();
    await f.merge();
    await f.tick();
    f.finish();
    await f.tick();
    const options = await f.service.pullRequestMergeOptions(
      "acme",
      "widgets",
      17,
      "PULL_REQUEST_DETAILS",
    );
    expect(options).toMatchObject({
      worktreeId: "primary",
      worktreeFolder: "/repo",
      defaultSwitchToDefaultBranch: true,
      switchToDefaultBranchName: "main",
      autoMergeOperation: {
        state: "COMPLETED",
        postMergeSwitch: { state: "COMPLETED", branch: "main" },
      },
    });
    expect(f.prisma.worktreeAutoMerge.findFirst).toHaveBeenCalled();
    expect(f.github.mergePullRequest).toHaveBeenCalledOnce();
  });
});
