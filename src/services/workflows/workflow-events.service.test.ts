import { beforeEach, describe, expect, test, vi } from "vitest";

import { WorkflowEventsService } from "./workflow-events.service";

const prisma = vi.hoisted(() => ({
  workflowTrigger: { findFirst: vi.fn() },
  workflowTriggerEvent: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => prisma,
}));

const input = {
  kind: "RUN_COMPLETED",
  subjectKey: "run-1",
  dedupeKey: "run-status:run-1:COMPLETED",
  payload: { sessionData: { run: { id: "run-1" } } },
};

describe("WorkflowEventsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workflowTriggerEvent.findMany.mockResolvedValue([]);
  });

  test("does not persist events that no active workflow observes", async () => {
    prisma.workflowTrigger.findFirst.mockResolvedValue(null);

    const result = await new WorkflowEventsService().record(input);

    expect(result).toBeNull();
    expect(prisma.workflowTrigger.findFirst).toHaveBeenCalledWith({
      where: {
        kind: input.kind,
        version: {
          activeFor: { is: { enabled: true, archivedAt: null } },
        },
      },
      select: { id: true },
    });
    expect(prisma.workflowTriggerEvent.create).not.toHaveBeenCalled();
  });

  test("persists an event when an active workflow observes its kind", async () => {
    prisma.workflowTrigger.findFirst.mockResolvedValue({ id: "trigger-1" });
    prisma.workflowTriggerEvent.findUnique.mockResolvedValue(null);
    prisma.workflowTriggerEvent.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );

    const result = await new WorkflowEventsService().record(input);

    expect(result).toEqual(
      expect.objectContaining({
        kind: input.kind,
        subjectKey: input.subjectKey,
        dedupeKey: input.dedupeKey,
        payloadJson: JSON.stringify(input.payload),
      }),
    );
  });

  test("deletes expired terminal rows before compacting recent receipts", async () => {
    prisma.workflowTriggerEvent.findMany.mockResolvedValueOnce([
      { id: "expired-1" },
    ]);
    const service = new WorkflowEventsService();

    await service.maintain();

    expect(prisma.workflowTriggerEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["expired-1"] } },
    });
    expect(prisma.workflowTriggerEvent.updateMany).not.toHaveBeenCalled();
  });

  test("compacts legacy processed payloads in bounded batches", async () => {
    prisma.workflowTriggerEvent.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "processed-1" }]);
    const service = new WorkflowEventsService();

    await service.maintain();

    expect(prisma.workflowTriggerEvent.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["processed-1"] } },
      data: { payloadJson: "{}" },
    });
  });
});
