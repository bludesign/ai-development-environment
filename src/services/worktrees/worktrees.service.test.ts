import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";
import {
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
  return new WorktreesService(control, jira, github);
}

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

  test("upserts inventory and tombstones rows absent from a complete scan", async () => {
    const transaction = {
      codebase: { update: vi.fn() },
      worktree: {
        upsert: vi.fn().mockResolvedValue({ id: "worktree-1" }),
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
        upsert: vi.fn().mockResolvedValue({ id: "worktree-1" }),
        updateMany: vi.fn(),
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
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: "worktree-1", codebaseId: "codebase-1" });
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
