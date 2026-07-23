// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { RunsService } from "./runs.service";

describe("run command persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("loads the relations required to start or resume a provider run", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.getPrismaClient.mockResolvedValue({ runCommand: { findMany } });

    await new RunsService().pendingCommands("agent-1");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          run: {
            include: {
              worktree: true,
              inputs: { include: { attachments: true } },
              attempts: true,
              sourcePlan: { include: { attempts: true } },
              parentRun: { include: { attempts: true } },
            },
          },
        },
      }),
    );
  });

  test("terminalizes a cancelled run even when no attempt was created", async () => {
    const command = {
      id: "command-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "CANCEL",
      status: "RUNNING",
      error: null,
    };
    const prisma = {
      runCommand: {
        findUnique: vi.fn().mockResolvedValue(command),
        update: vi.fn().mockResolvedValue({
          ...command,
          status: "SUCCEEDED",
        }),
      },
      agentRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      worktreeRunLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().completeCommand(
      "agent-1",
      "command-1",
      "SUCCEEDED",
    );

    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] },
      },
      data: {
        status: "CANCELLED",
        phase: "CANCELLED",
        finishedAt: expect.any(Date),
      },
    });
    expect(prisma.worktreeRunLease.deleteMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
    });
  });

  test("does not enqueue duplicate cancellation commands", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      origin: "MANAGED",
      status: "IN_PROGRESS",
      phase: "CANCEL_REQUESTED",
    };
    const transaction = {
      agentRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn(),
      },
      runCommand: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
      agentRun: { findUnique: vi.fn().mockResolvedValue(run) },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().lifecycle("run-1", "CANCEL");

    expect(transaction.agentRun.update).not.toHaveBeenCalled();
    expect(transaction.runCommand.create).not.toHaveBeenCalled();
  });

  test("terminalizes a start command that fails before its first attempt", async () => {
    const command = {
      id: "command-1",
      runId: "run-1",
      agentId: "agent-1",
      type: "START",
      status: "RUNNING",
      error: null,
    };
    const prisma = {
      runCommand: {
        findUnique: vi.fn().mockResolvedValue(command),
        update: vi.fn().mockResolvedValue({
          ...command,
          status: "FAILED",
          error: "Run worktree is unavailable",
        }),
      },
      agentRun: { update: vi.fn().mockResolvedValue({}) },
      worktreeRunLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().completeCommand(
      "agent-1",
      "command-1",
      "FAILED",
      "Run worktree is unavailable",
    );

    expect(prisma.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        error: "Run worktree is unavailable",
        phase: "START_FAILED",
        status: "FAILED",
        finishedAt: expect.any(Date),
      },
    });
    expect(prisma.worktreeRunLease.deleteMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
    });
  });
});
