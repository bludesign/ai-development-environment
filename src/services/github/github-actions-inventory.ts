import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  agentEventBus,
  GITHUB_ACTIONS_COUNT_CHANGED_TOPIC,
} from "@/services/agent-control";

export const ACTIVE_WORKFLOW_STATUSES = [
  "in_progress",
  "queued",
  "requested",
  "waiting",
  "pending",
] as const;

export type ActiveWorkflowObservation = {
  id: string;
  workflowId: string;
  runAttempt: number;
  status: string;
  conclusion?: string | null;
  updatedAt: Date;
  observedAt?: Date;
};

export function githubCredentialKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function githubWebhookCoverageKey(
  installationId: string,
  verifiedAt: Date,
): string {
  return JSON.stringify([installationId, verifiedAt.toISOString()]);
}

/** Notification observations also hold count membership; completeness is recorded separately. */
export class GitHubActionsInventory {
  private publish() {
    agentEventBus.publish(GITHUB_ACTIONS_COUNT_CHANGED_TOPIC, {
      githubActionsCountChanged: true,
    });
  }

  private async write(
    transaction: Prisma.TransactionClient,
    repositoryId: string,
    run: ActiveWorkflowObservation,
    source: string,
    observedAt: Date,
  ): Promise<void> {
    if (!Number.isFinite(run.updatedAt.getTime()))
      throw new Error("Invalid workflow observation timestamp");
    const latest = await transaction.gitHubWorkflowRunObservation.findFirst({
      where: { codebaseRepositoryId: repositoryId, workflowRunId: run.id },
      orderBy: { runAttempt: "desc" },
    });
    if (latest && latest.runAttempt > run.runAttempt) return;
    const active = ACTIVE_WORKFLOW_STATUSES.some(
      (status) => status === run.status,
    );
    if (latest?.runAttempt === run.runAttempt && latest.activeUpdatedAt) {
      const delta = run.updatedAt.getTime() - latest.activeUpdatedAt.getTime();
      if (
        delta < 0 ||
        (delta === 0 &&
          ((latest.activeObservedAt && observedAt < latest.activeObservedAt) ||
            (latest.activeStatus === "completed" && active) ||
            (latest.activeObservedAt &&
              observedAt <= latest.activeObservedAt &&
              !latest.countedActive &&
              active)))
      )
        return;
    }
    await transaction.gitHubWorkflowRunObservation.updateMany({
      where: {
        codebaseRepositoryId: repositoryId,
        workflowRunId: run.id,
        runAttempt: { lt: run.runAttempt },
        countedActive: true,
      },
      data: { countedActive: false },
    });
    const membership = {
      countedActive: active,
      activeStatus: run.status,
      activeUpdatedAt: run.updatedAt,
      activeObservedAt: observedAt,
    };
    await transaction.gitHubWorkflowRunObservation.upsert({
      where: {
        codebaseRepositoryId_workflowRunId_runAttempt: {
          codebaseRepositoryId: repositoryId,
          workflowRunId: run.id,
          runAttempt: run.runAttempt,
        },
      },
      create: {
        id: randomUUID(),
        codebaseRepositoryId: repositoryId,
        workflowRunId: run.id,
        runAttempt: run.runAttempt,
        workflowId: run.workflowId,
        status: run.status,
        conclusion: run.conclusion ?? null,
        githubUpdatedAt: run.updatedAt,
        source,
        lastObservedAt: observedAt,
        ...membership,
      },
      // Notification status and notifiedAt belong to the notification reducer.
      update: {
        ...membership,
        lastObservedAt:
          latest && latest.lastObservedAt > observedAt
            ? latest.lastObservedAt
            : observedAt,
      },
    });
  }

  async observe(
    repositoryId: string,
    runs: ActiveWorkflowObservation[],
    source: string,
  ): Promise<void> {
    if (!runs.length) return;
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      const state = await transaction.gitHubActionsPollingState.findUnique({
        where: { codebaseRepositoryId: repositoryId },
        select: { activeReconciledAt: true },
      });
      for (const run of runs) {
        const observedAt = run.observedAt ?? new Date(Date.now());
        // A complete scan also fences stale active runs that have no stored row.
        if (
          state?.activeReconciledAt &&
          observedAt < state.activeReconciledAt &&
          ACTIVE_WORKFLOW_STATUSES.some((status) => status === run.status)
        )
          continue;
        await this.write(transaction, repositoryId, run, source, observedAt);
      }
    });
    this.publish();
  }

  async reconcile(
    repositoryId: string,
    credentialKey: string,
    runs: ActiveWorkflowObservation[],
    startedAt: Date,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      for (const run of runs)
        await this.write(transaction, repositoryId, run, "REST", startedAt);
      await transaction.gitHubWorkflowRunObservation.updateMany({
        where: {
          codebaseRepositoryId: repositoryId,
          countedActive: true,
          workflowRunId: { notIn: runs.map((run) => run.id) },
          OR: [
            { activeObservedAt: { lte: startedAt } },
            { activeObservedAt: null },
          ],
        },
        data: { countedActive: false, activeObservedAt: startedAt },
      });
      await transaction.gitHubActionsPollingState.upsert({
        where: { codebaseRepositoryId: repositoryId },
        create: {
          codebaseRepositoryId: repositoryId,
          initializedAt: startedAt,
          activeReconciledAt: startedAt,
          activeCredentialKey: credentialKey,
        },
        update: {
          activeReconciledAt: startedAt,
          activeCredentialKey: credentialKey,
        },
      });
    });
    this.publish();
  }

  async state(repositoryId: string) {
    return (await getPrismaClient()).gitHubActionsPollingState.findUnique({
      where: { codebaseRepositoryId: repositoryId },
    });
  }

  async markWebhookCoverage(repositoryId: string, key: string): Promise<void> {
    await (
      await getPrismaClient()
    ).gitHubActionsPollingState.upsert({
      where: { codebaseRepositoryId: repositoryId },
      create: {
        codebaseRepositoryId: repositoryId,
        initializedAt: new Date(),
        activeWebhookKey: key,
      },
      update: { activeWebhookKey: key },
    });
  }

  async count(
    repositoryIds: string[],
    credentialKey: string,
  ): Promise<number | null> {
    if (!repositoryIds.length) return 0;
    const prisma = await getPrismaClient();
    const states = await prisma.gitHubActionsPollingState.findMany({
      where: {
        codebaseRepositoryId: { in: repositoryIds },
        activeCredentialKey: credentialKey,
        activeReconciledAt: { not: null },
      },
    });
    if (states.length !== repositoryIds.length) return null;
    return prisma.gitHubWorkflowRunObservation.count({
      where: {
        codebaseRepositoryId: { in: repositoryIds },
        countedActive: true,
      },
    });
  }
}
