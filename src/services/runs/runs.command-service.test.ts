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

  test("terminalizes an existing cancel request without enqueuing a duplicate", async () => {
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
        update: vi.fn().mockResolvedValue({
          ...run,
          status: "CANCELLED",
          phase: "CANCELLED",
        }),
      },
      runAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      worktreeRunLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      runCommand: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
      agentRun: {
        findUnique: vi.fn().mockResolvedValue({
          ...run,
          status: "CANCELLED",
          phase: "CANCELLED",
        }),
      },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().lifecycle("run-1", "CANCEL");

    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        status: "CANCELLED",
        phase: "CANCELLED",
        finishedAt: expect.any(Date),
      },
    });
    expect(transaction.runAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        runId: "run-1",
        status: {
          notIn: ["PAUSED", "COMPLETED", "CANCELLED", "FAILED"],
        },
      },
      data: { status: "CANCELLED", finishedAt: expect.any(Date) },
    });
    expect(transaction.worktreeRunLease.deleteMany).toHaveBeenCalledWith({
      where: { runId: "run-1" },
    });
    expect(transaction.runCommand.create).not.toHaveBeenCalled();
  });

  test("terminalizes cancellation before enqueuing provider cleanup", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      origin: "MANAGED",
      status: "IN_PROGRESS",
      phase: "RUNNING",
    };
    const cancelled = { ...run, status: "CANCELLED", phase: "CANCELLED" };
    const command = { id: "command-1", runId: run.id, type: "CANCEL" };
    const transaction = {
      agentRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn().mockResolvedValue(cancelled),
      },
      runAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      worktreeRunLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      runCommand: {
        findFirst: vi.fn().mockResolvedValue({ sequence: 2 }),
        create: vi.fn().mockResolvedValue(command),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
      agentRun: { findUnique: vi.fn().mockResolvedValue(cancelled) },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().lifecycle("run-1", "CANCEL");

    expect(transaction.agentRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: {
        status: "CANCELLED",
        phase: "CANCELLED",
        finishedAt: expect.any(Date),
      },
    });
    expect(transaction.runCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "CANCEL", sequence: 3 }),
      }),
    );
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
      agentRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
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

    expect(prisma.agentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] },
      },
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

  test("does not begin a new attempt after cancellation", async () => {
    const create = vi.fn();
    mocks.getPrismaClient.mockResolvedValue({
      agentRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          agentId: "agent-1",
          status: "CANCELLED",
          attempts: [],
        }),
      },
      runAttempt: { create },
    });

    await expect(
      new RunsService().beginAttempt("agent-1", "run-1"),
    ).rejects.toThrow("Run is already finished");
    expect(create).not.toHaveBeenCalled();
  });

  test("namespaces repeated provider question IDs by batch", async () => {
    const questionIds: string[] = [];
    const transaction = {
      agentRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "run-1",
          agentId: "agent-1",
          kind: "SESSION",
          displayNumber: 1,
          worktree: null,
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      runQuestionBatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(
          async ({
            data,
          }: {
            data: {
              id: string;
              runId: string;
              questions: { create: Array<{ id: string }> };
            };
          }) => {
            questionIds.push(
              ...data.questions.create.map(
                (question: { id: string }) => question.id,
              ),
            );
            return { id: data.id, runId: data.runId, questions: [] };
          },
        ),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);
    const service = new RunsService();
    const question = {
      id: "0",
      prompt: "Which API approach should be used?",
      options: [{ label: "REST API" }],
    };

    await service.reportQuestion(
      "agent-1",
      "run-1",
      "attempt-1",
      "request-1",
      1,
      [question],
    );
    await service.reportQuestion(
      "agent-1",
      "run-1",
      "attempt-1",
      "request-2",
      2,
      [question],
    );

    expect(questionIds).toHaveLength(2);
    expect(new Set(questionIds).size).toBe(2);
    expect(questionIds).toEqual([
      expect.stringMatching(/:0:0$/),
      expect.stringMatching(/:0:0$/),
    ]);
  });

  test("does not overwrite cancellation with a late provider completion", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      kind: "SESSION",
      displayNumber: 1,
      status: "CANCELLED",
      phase: "CANCELLED",
      worktreeId: "worktree-1",
      worktree: null,
    };
    const attempt = {
      id: "attempt-1",
      generation: 0,
      runId: run.id,
      run,
    };
    const transaction = {
      runAttempt: {
        findUnique: vi.fn().mockResolvedValue(attempt),
        update: vi.fn().mockResolvedValue({ ...attempt, status: "CANCELLED" }),
      },
      agentRun: { update: vi.fn() },
      worktreeRunLease: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
      agentRun: { findUnique: vi.fn().mockResolvedValue(run) },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().finishAttempt("agent-1", "attempt-1", {
      status: "COMPLETED",
      finalOutput: "Too late",
    });

    expect(transaction.runAttempt.update).toHaveBeenCalledWith({
      where: { id: "attempt-1" },
      data: { status: "CANCELLED", finishedAt: expect.any(Date) },
    });
    expect(transaction.agentRun.update).not.toHaveBeenCalled();
  });
});
