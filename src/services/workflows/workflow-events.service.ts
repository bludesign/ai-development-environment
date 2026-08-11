import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";

const FAILED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const MAINTENANCE_BATCH_SIZE = 1_000;

export type RecordWorkflowEventInput = {
  kind: string;
  subjectKey: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export class WorkflowEventsService {
  private nextMaintenanceAt = 0;

  async record(input: RecordWorkflowEventInput) {
    const prisma = await getPrismaClient();
    const observed = await prisma.workflowTrigger.findFirst({
      where: {
        kind: input.kind,
        version: {
          activeFor: {
            is: { enabled: true, archivedAt: null },
          },
        },
      },
      select: { id: true },
    });
    if (!observed) return null;
    return this.recordInTransaction(prisma, input);
  }

  private async recordInTransaction(
    transaction: Prisma.TransactionClient,
    input: RecordWorkflowEventInput,
  ) {
    const existing = await transaction.workflowTriggerEvent.findUnique({
      where: { dedupeKey: input.dedupeKey },
    });
    if (existing) return existing;
    return transaction.workflowTriggerEvent.create({
      data: {
        id: randomUUID(),
        kind: input.kind,
        subjectKey: input.subjectKey,
        dedupeKey: input.dedupeKey,
        payloadJson: JSON.stringify(input.payload),
      },
    });
  }

  async maintain(): Promise<void> {
    const now = Date.now();
    if (now < this.nextMaintenanceAt) return;

    const prisma = await getPrismaClient();
    // PROCESSED rows are durable producer-key receipts. Deleting them would let
    // a provider retry create another run after per-run delivery history is gone.
    const expired = await prisma.workflowTriggerEvent.findMany({
      where: {
        status: "FAILED",
        receivedAt: { lt: new Date(now - FAILED_EVENT_RETENTION_MS) },
      },
      select: { id: true },
      orderBy: { receivedAt: "asc" },
      take: MAINTENANCE_BATCH_SIZE,
    });
    if (expired.length) {
      await prisma.workflowTriggerEvent.deleteMany({
        where: { id: { in: expired.map(({ id }) => id) } },
      });
      // Keep draining a legacy backlog on subsequent runtime ticks.
      this.nextMaintenanceAt = 0;
      return;
    }

    this.nextMaintenanceAt = now + MAINTENANCE_INTERVAL_MS;
  }
}
