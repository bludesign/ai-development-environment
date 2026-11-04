// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { RunsService } from "./runs.service";

function notificationFixture(
  kind: "PLAN" | "SESSION",
  override: boolean | null,
  workflowEnabled: boolean | null,
) {
  const run = {
    id: "run-1",
    agentId: "agent-1",
    kind,
    displayNumber: 4,
    status: "IN_PROGRESS",
    phase: "RUNNING",
    worktreeId: "worktree-1",
    completionNotificationsEnabled: override,
    worktree: { highlightColor: "blue" },
    workflowRun:
      workflowEnabled === null
        ? null
        : { workflow: { completionNotificationsEnabled: workflowEnabled } },
  };
  const attempt = { id: "attempt-1", runId: run.id, generation: 0, run };
  const notification = { id: "notification-1" };
  const recordInTransaction = vi.fn().mockResolvedValue(notification);
  const created = vi.fn();
  const transaction = {
    runAttempt: {
      findUnique: vi.fn().mockResolvedValue(attempt),
      update: vi.fn().mockResolvedValue(attempt),
    },
    agentRun: {
      findUnique: vi.fn().mockResolvedValue(run),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const {
          worktree: _worktree,
          workflowRun: _workflowRun,
          ...scalars
        } = run;
        return { ...scalars, ...data };
      }),
    },
    runQuestionBatch: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "question-1", runId: run.id }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    worktreeRunLease: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  mocks.getPrismaClient.mockResolvedValue({
    $transaction: async (callback: (value: typeof transaction) => unknown) =>
      callback(transaction),
  });
  const service = new RunsService({ recordInTransaction, created } as never);
  vi.spyOn(service, "get").mockResolvedValue(run as never);
  const promote = vi
    .spyOn(
      service as unknown as {
        promoteQueuedLaneSafely: (
          worktreeId: string,
          kind: string,
        ) => Promise<void>;
      },
      "promoteQueuedLaneSafely",
    )
    .mockResolvedValue();
  return {
    service,
    run,
    transaction,
    recordInTransaction,
    created,
    notification,
    promote,
  };
}

describe.each(["PLAN", "SESSION"] as const)(
  "%s completion notifications",
  (kind) => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    test.each([
      { override: null, workflow: false, enabled: false },
      { override: null, workflow: true, enabled: true },
      { override: null, workflow: null, enabled: true },
      { override: true, workflow: false, enabled: true },
      { override: false, workflow: true, enabled: false },
      { override: false, workflow: null, enabled: false },
    ])(
      "uses override $override and workflow $workflow for successful completion",
      async ({ override, workflow, enabled }) => {
        const fixture = notificationFixture(kind, override, workflow);

        await fixture.service.finishAttempt("agent-1", "attempt-1", {
          status: "COMPLETED",
          finalOutput: "Finished the work",
        });

        expect(fixture.recordInTransaction).toHaveBeenCalledTimes(
          enabled ? 1 : 0,
        );
        if (enabled) {
          expect(fixture.recordInTransaction).toHaveBeenCalledWith(
            fixture.transaction,
            expect.objectContaining({ typeKey: "RUN_COMPLETED" }),
          );
          expect(fixture.created).toHaveBeenCalledWith(fixture.notification);
        } else {
          expect(fixture.created).toHaveBeenCalledWith(null);
        }
        expect(fixture.transaction.agentRun.update).toHaveBeenCalledWith({
          where: { id: "run-1" },
          data: expect.objectContaining({
            status: "COMPLETED",
            finalOutput: "Finished the work",
          }),
        });
        expect(
          fixture.transaction.runQuestionBatch.updateMany,
        ).toHaveBeenCalledWith({
          where: { runId: "run-1", status: "PENDING" },
          data: { status: "SUPERSEDED", supersededAt: expect.any(Date) },
        });
        expect(
          fixture.transaction.worktreeRunLease.deleteMany,
        ).toHaveBeenCalledOnce();
        expect(fixture.promote).toHaveBeenCalledWith("worktree-1", kind);
      },
    );

    test.each([
      { status: "FAILED", phase: "FAILED", typeKey: "RUN_FAILED" },
      { status: "CANCELLED", phase: "CANCELLED", typeKey: "RUN_CANCELLED" },
      {
        status: "PAUSED",
        phase: "RECOVERY_PAUSED",
        typeKey: "RUN_RECOVERY_PAUSED",
      },
    ])(
      "preserves $typeKey when successful completion notifications are disabled",
      async ({ status, phase, typeKey }) => {
        const fixture = notificationFixture(kind, false, false);

        await fixture.service.finishAttempt("agent-1", "attempt-1", {
          status,
          phase,
          error: "Needs attention",
        });

        expect(fixture.recordInTransaction).toHaveBeenCalledWith(
          fixture.transaction,
          expect.objectContaining({ typeKey }),
        );
      },
    );

    test("preserves questions when successful completion notifications are disabled", async () => {
      const fixture = notificationFixture(kind, false, false);

      await fixture.service.reportQuestion(
        "agent-1",
        "run-1",
        "attempt-1",
        "request-1",
        1,
        [{ prompt: "Which approach should I use?" }],
      );

      expect(
        fixture.transaction.runQuestionBatch.create,
      ).toHaveBeenCalledOnce();
      expect(fixture.transaction.agentRun.update).toHaveBeenCalledWith({
        where: { id: "run-1" },
        data: { phase: "WAITING_FOR_ANSWER" },
      });
      expect(fixture.recordInTransaction).toHaveBeenCalledWith(
        fixture.transaction,
        expect.objectContaining({ typeKey: "RUN_NEEDS_ANSWER" }),
      );
    });
  },
);
