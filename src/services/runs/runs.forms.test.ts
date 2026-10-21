// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));
import { RunsService } from "./runs.service";

function database() {
  const run = {
    id: "run",
    agentId: "agent",
    provider: "OPENCODE",
    origin: "MANAGED",
    status: "IN_PROGRESS",
    phase: "WAITING_FOR_ANSWER",
  };
  const fields = [
    { key: "enabled", type: "boolean", required: true },
    { key: "count", type: "integer", minimum: 0 },
  ];
  const batch = {
    id: "batch",
    runId: run.id,
    nativeRequestId: "frm_one",
    status: "PENDING",
    run,
    answerRevisions: [] as unknown[],
    answeredAt: null,
    questions: fields.map((field, index) => ({
      id: `db-${index}`,
      fieldJson: JSON.stringify(field),
    })),
  };
  const transaction = {
    runQuestionBatch: {
      findUnique: vi.fn().mockResolvedValue(batch),
      update: vi.fn(async ({ data }) => Object.assign(batch, data)),
      count: vi
        .fn()
        .mockImplementation(async () => (batch.status === "PENDING" ? 1 : 0)),
    },
    runAnswerRevision: {
      create: vi.fn(async ({ data }) => {
        batch.answerRevisions.push(data);
        return data;
      }),
      updateMany: vi.fn(),
    },
    agentRun: {
      update: vi.fn(async ({ data }) => Object.assign(run, data)),
      findUnique: vi.fn().mockResolvedValue({
        ...run,
        attempts: [],
        inputs: [],
        events: [],
        questionBatches: [],
        modelUsages: [],
        checkpoints: [],
      }),
    },
    runCommand: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "cmd",
        runId: run.id,
        agentId: run.agentId,
        type: "ANSWER",
      }),
    },
  };
  mocks.getPrismaClient.mockResolvedValue({
    ...transaction,
    $transaction: async (callback: (tx: typeof transaction) => unknown) =>
      callback(transaction),
  });
  return { batch, run, transaction, service: new RunsService() };
}
beforeEach(() => vi.clearAllMocks());
describe("native form persistence and delivery", () => {
  test("validates typed answers before enqueueing and preserves false/zero", async () => {
    const { service, transaction } = database();
    await expect(
      service.answerQuestion("batch", { enabled: { value: "false" } }),
    ).rejects.toThrow("type");
    expect(transaction.runCommand.create).not.toHaveBeenCalled();
    await service.answerQuestion("batch", {
      enabled: { value: false },
      count: { value: 0 },
    });
    expect(transaction.runAnswerRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        answersJson: '{"enabled":{"value":false},"count":{"value":0}}',
      }),
    });
  });
  test("accepts native resolutions idempotently and restores rejected submissions to pending", async () => {
    const { service, transaction, batch } = database();
    const resolution = {
      status: "ANSWERED",
      answers: { enabled: { value: false } },
    };
    await service.resolveQuestion("agent", "run", "frm_one", resolution);
    await service.resolveQuestion("agent", "run", "frm_one", resolution);
    expect(transaction.runAnswerRevision.create).toHaveBeenCalledOnce();
    await service.resolveQuestion("agent", "run", "frm_one", {
      status: "PENDING",
      error: "Native validation rejected the value",
    });
    expect(batch.status).toBe("PENDING");
    expect(transaction.runQuestionBatch.update).toHaveBeenLastCalledWith({
      where: { id: batch.id },
      data: {
        status: "PENDING",
        answeredAt: null,
        error: "Native validation rejected the value",
      },
    });
  });
  test("enforces agent ownership and never reopens a cancelled form", async () => {
    const { service, transaction } = database();
    await expect(
      service.resolveQuestion("other", "run", "frm_one", {
        status: "CANCELLED",
      }),
    ).rejects.toThrow("not found");
    await service.resolveQuestion("agent", "run", "frm_one", {
      status: "CANCELLED",
    });
    const count = transaction.runQuestionBatch.update.mock.calls.length;
    await service.resolveQuestion("agent", "run", "frm_one", {
      status: "PENDING",
    });
    expect(transaction.runQuestionBatch.update).toHaveBeenCalledTimes(count);
  });
  test("records a different authoritative native answer and ignores object-key ordering", async () => {
    const { service, transaction } = database();
    await service.resolveQuestion("agent", "run", "frm_one", {
      status: "ANSWERED",
      answers: { enabled: { value: true }, count: { value: 0 } },
    });
    await service.resolveQuestion("agent", "run", "frm_one", {
      status: "ANSWERED",
      answers: { count: { value: 0 }, enabled: { value: true } },
    });
    expect(transaction.runAnswerRevision.create).toHaveBeenCalledOnce();
    await service.resolveQuestion("agent", "run", "frm_one", {
      status: "ANSWERED",
      answers: { enabled: { value: false }, count: { value: 0 } },
    });
    expect(transaction.runAnswerRevision.create).toHaveBeenCalledTimes(2);
    expect(transaction.runAnswerRevision.updateMany).toHaveBeenCalled();
  });
  test("enqueues native cancellation without pretending it already completed", async () => {
    const { service, transaction, batch } = database();
    await service.cancelQuestion("batch");
    expect(transaction.runCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "CANCEL_QUESTION",
          payloadJson: '{"batchId":"batch","nativeRequestId":"frm_one"}',
        }),
      }),
    );
    expect(batch.status).toBe("PENDING");
  });
});
