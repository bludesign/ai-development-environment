import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import { agentEventBus } from "@/services/agent-control";

export const WORKFLOW_TRIGGER_EVENTS_TOPIC = "workflow:trigger-events";

export type RecordWorkflowEventInput = {
  kind: string;
  subjectKey: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
};

export class WorkflowEventsService {
  async record(input: RecordWorkflowEventInput) {
    const prisma = await getPrismaClient();
    const event = await this.recordInTransaction(prisma, input);
    this.created(event.id);
    return event;
  }

  async recordInTransaction(
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

  created(id: string): void {
    agentEventBus.publish(WORKFLOW_TRIGGER_EVENTS_TOPIC, {
      workflowTriggerEventCreated: { id },
    });
  }

  subscribe() {
    return agentEventBus.iterate<{
      workflowTriggerEventCreated: { id: string };
    }>(WORKFLOW_TRIGGER_EVENTS_TOPIC);
  }
}
