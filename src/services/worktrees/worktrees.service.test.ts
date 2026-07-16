import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";
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
      }),
    );
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

    expect(transaction.worktree.updateMany).not.toHaveBeenCalled();
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
    const update = vi.fn();
    getPrismaClient.mockResolvedValue({ worktree: { findFirst, update } });
    const activity = {
      codebaseId: "codebase-1",
      gitDirectory: "/repo/.git",
      hasUnstagedChanges: true,
      observedAt: new Date(0).toISOString(),
    };

    await expect(
      service().reportActivity("agent-1", activity),
    ).resolves.toEqual({
      worktreeId: "worktree-1",
      hasUnstagedChanges: true,
      observedAt: activity.observedAt,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "worktree-1" },
      data: { hasUnstagedChanges: true },
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

  test("starts a demand-scoped watcher and stops it after unsubscribe", async () => {
    const control = {
      registerCompletionHandler: vi.fn(),
      createJob: vi
        .fn()
        .mockResolvedValueOnce({ id: "watch-start" })
        .mockResolvedValueOnce({ id: "watch-stop" }),
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
