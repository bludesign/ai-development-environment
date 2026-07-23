// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { RunsService } from "./runs.service";

describe("run review regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("transfers a resumed native session key to the new attempt", async () => {
    const run = { id: "run-1", agentId: "agent-1", provider: "CODEX" };
    const current = { id: "attempt-2", runId: run.id, run };
    const owner = {
      id: "attempt-1",
      runId: run.id,
      nativeKey: "agent-1:CODEX:thread-1",
    };
    const update = vi.fn(async ({ where, data }) => ({
      ...(where.id === current.id ? current : owner),
      ...data,
    }));
    const transaction = {
      runAttempt: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(current)
          .mockResolvedValueOnce(owner),
        update,
      },
      agentRun: { update: vi.fn() },
    };
    mocks.getPrismaClient.mockResolvedValue({
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    });

    await new RunsService().updateAttemptNativeId(
      "agent-1",
      current.id,
      "thread-1",
    );

    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: owner.id },
      data: { nativeKey: null },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: current.id },
      data: {
        nativeId: "thread-1",
        nativeKey: "agent-1:CODEX:thread-1",
      },
    });
  });

  test("supersedes pending questions as soon as a pause is requested", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      origin: "MANAGED",
      status: "IN_PROGRESS",
      phase: "WAITING_FOR_ANSWER",
    };
    const transaction = {
      agentRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        update: vi.fn().mockResolvedValue({
          ...run,
          phase: "PAUSE_REQUESTED",
        }),
      },
      runQuestionBatch: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      runCommand: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "pause-1",
          status: "QUEUED",
          run,
        }),
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

    await new RunsService().lifecycle(run.id, "PAUSE");

    expect(transaction.runQuestionBatch.updateMany).toHaveBeenCalledWith({
      where: { runId: run.id, status: "PENDING" },
      data: { status: "SUPERSEDED", supersededAt: expect.any(Date) },
    });
  });

  test("rejects an answer after its run is no longer active", async () => {
    const transaction = {
      runQuestionBatch: {
        findUnique: vi.fn().mockResolvedValue({
          id: "batch-1",
          runId: "run-1",
          status: "PENDING",
          answerRevisions: [],
          run: {
            id: "run-1",
            agentId: "agent-1",
            origin: "MANAGED",
            status: "PAUSED",
            phase: "PAUSED",
          },
        }),
        update: vi.fn(),
      },
      runAnswerRevision: { create: vi.fn() },
      agentRun: { update: vi.fn() },
      runCommand: { create: vi.fn() },
    };
    mocks.getPrismaClient.mockResolvedValue({
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    });

    await expect(
      new RunsService().answerQuestion("batch-1", { answer: "late" }),
    ).rejects.toThrow("Run is not active");
    expect(transaction.runAnswerRevision.create).not.toHaveBeenCalled();
  });

  test("routes active deletion through the agent even without a native ID", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      status: "IN_PROGRESS",
      attempts: [],
      inputs: [],
    };
    const create = vi.fn().mockResolvedValue({
      id: "delete-1",
      status: "QUEUED",
      run,
    });
    const transaction = {
      agentRun: { update: vi.fn().mockResolvedValue(run) },
      runQuestionBatch: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      runCommand: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create,
      },
    };
    const prisma = {
      agentRun: {
        findMany: vi.fn().mockResolvedValue([run]),
        delete: vi.fn(),
      },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    await new RunsService().deleteRuns([run.id]);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "DELETE_NATIVE",
          payloadJson: JSON.stringify({ attempts: [] }),
        }),
      }),
    );
    expect(prisma.agentRun.delete).not.toHaveBeenCalled();
  });

  test("requeues a failed native deletion instead of duplicating its key", async () => {
    const run = {
      id: "run-1",
      agentId: "agent-1",
      status: "FAILED",
      attempts: [{ id: "attempt-1", nativeId: "thread-1" }],
      inputs: [],
    };
    const failed = {
      id: "delete-1",
      status: "FAILED",
      idempotencyKey: "run-1:delete-native",
      run,
    };
    const update = vi.fn().mockResolvedValue({ ...failed, status: "QUEUED" });
    const transaction = {
      agentRun: { update: vi.fn().mockResolvedValue(run) },
      runQuestionBatch: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      runCommand: {
        findUnique: vi.fn().mockResolvedValue(failed),
        update,
        create: vi.fn(),
      },
    };
    mocks.getPrismaClient.mockResolvedValue({
      agentRun: { findMany: vi.fn().mockResolvedValue([run]) },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    });

    await new RunsService().deleteRuns([run.id]);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: failed.id },
        data: expect.objectContaining({
          status: "QUEUED",
          error: null,
          claimedAt: null,
          finishedAt: null,
        }),
      }),
    );
    expect(transaction.runCommand.create).not.toHaveBeenCalled();
  });

  test("imports every discovered history beyond the former 500-run cap", async () => {
    let nextDisplay = 0;
    const transaction = {
      runNumberSequence: {
        upsert: vi.fn(async () => ({ nextValue: (nextDisplay += 1) })),
      },
    };
    const create = vi.fn().mockResolvedValue({});
    const prisma = {
      runAttempt: { findUnique: vi.fn().mockResolvedValue(null) },
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          id: "worktree-1",
          branch: "main",
          codebase: {
            agentId: "agent-1",
            repository: { name: "aide" },
          },
        }),
      },
      agentRun: { create },
      runProviderSync: { upsert: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);
    const records = Array.from({ length: 501 }, (_, index) => ({
      nativeId: `thread-${index}`,
      worktreeId: "worktree-1",
    }));

    await expect(
      new RunsService().importRuns("agent-1", "CODEX", records),
    ).resolves.toBe(501);
    expect(create).toHaveBeenCalledTimes(501);
  });

  test("returns models only from the worktree's selected agent", async () => {
    const lastSeenAt = new Date();
    const prisma = {
      worktree: {
        findUnique: vi.fn().mockResolvedValue({
          codebase: { agentId: "agent-b" },
        }),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "agent-b",
            capabilitiesJson: JSON.stringify(["runs.provider.codex"]),
            lastSeenAt,
            disconnectedAt: null,
            heartbeatIntervalSeconds: 30,
          },
        ]),
      },
      runProviderSync: {
        findMany: vi.fn().mockResolvedValue([
          {
            agentId: "agent-b",
            provider: "CODEX",
            status: "IDLE",
            catalogJson: JSON.stringify({
              models: [{ id: "model-b", label: "Model B", efforts: ["high"] }],
            }),
          },
        ]),
      },
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    const catalog = await new RunsService().providerCatalog({
      worktreeId: "worktree-b",
    });

    expect(prisma.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "agent-b" } }),
    );
    expect(prisma.runProviderSync.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { agentId: "agent-b" } }),
    );
    expect(catalog.find(({ key }) => key === "CODEX")?.models).toEqual([
      { id: "model-b", label: "Model B", efforts: ["high"] },
    ]);
  });

  test("reaps runs whose agent went offline and releases their leases", async () => {
    const now = Date.now();
    const transaction = {
      runAttempt: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      agentRun: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      runCommand: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      worktreeRunLease: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const prisma = {
      agentRun: {
        findMany: vi.fn().mockResolvedValue([
          { id: "run-online", agentId: "agent-online" },
          { id: "run-offline", agentId: "agent-offline" },
          { id: "run-orphan", agentId: "agent-deleted" },
        ]),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "agent-online",
            lastSeenAt: new Date(now - 1_000),
            disconnectedAt: null,
            heartbeatIntervalSeconds: null,
          },
          {
            id: "agent-offline",
            lastSeenAt: new Date(now - 60 * 60_000),
            disconnectedAt: null,
            heartbeatIntervalSeconds: null,
          },
        ]),
      },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    const reaped = await new RunsService().reapOrphanedRuns(now);

    expect(reaped).toBe(2);
    expect(transaction.agentRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["run-offline", "run-orphan"] },
        status: { notIn: ["COMPLETED", "CANCELLED", "FAILED"] },
      },
      data: {
        status: "FAILED",
        phase: "AGENT_OFFLINE",
        error: "Agent went offline while this run was active",
        finishedAt: expect.any(Date),
      },
    });
    expect(transaction.worktreeRunLease.deleteMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-offline", "run-orphan"] } },
    });
  });

  test("leaves runs untouched while their agent is still online", async () => {
    const now = Date.now();
    const transaction = {
      runAttempt: { updateMany: vi.fn() },
      agentRun: { updateMany: vi.fn() },
      runCommand: { updateMany: vi.fn() },
      worktreeRunLease: { deleteMany: vi.fn() },
    };
    const prisma = {
      agentRun: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "run-1", agentId: "agent-1" }]),
      },
      agent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "agent-1",
            lastSeenAt: new Date(now - 2_000),
            disconnectedAt: null,
            heartbeatIntervalSeconds: null,
          },
        ]),
      },
      $transaction: vi.fn(
        async (callback: (value: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    mocks.getPrismaClient.mockResolvedValue(prisma);

    const reaped = await new RunsService().reapOrphanedRuns(now);

    expect(reaped).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(transaction.worktreeRunLease.deleteMany).not.toHaveBeenCalled();
  });
});
