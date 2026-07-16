import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";

import { WorktreesService } from "./worktrees.service";

function service() {
  const control = {
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
});
