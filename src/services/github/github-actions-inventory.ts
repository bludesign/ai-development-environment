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

const TERMINAL_WORKFLOW_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
]);

const TERMINAL_PIPELINE_STATUSES = [
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
] as const;

function workflowStatus(run: { status: string; conclusion?: string | null }) {
  const status = run.status.trim().toLowerCase();
  const conclusion = run.conclusion?.trim().toLowerCase();
  // Workflow conclusions describe a finished attempt even when another observation
  // still carries queued/in_progress. Keep the terminal fence for cached events too.
  return status === "completed" ||
    TERMINAL_WORKFLOW_CONCLUSIONS.has(status) ||
    (conclusion && TERMINAL_WORKFLOW_CONCLUSIONS.has(conclusion))
    ? "completed"
    : status;
}

function activeWorkflow(run: { status: string; conclusion?: string | null }) {
  const status = workflowStatus(run);
  return ACTIVE_WORKFLOW_STATUSES.some((active) => active === status);
}

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
    const status = workflowStatus(run);
    const active = activeWorkflow(run);
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
      activeStatus: status,
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
          activeWorkflow(run)
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

    // Repair memberships written before terminal conclusions were respected, and
    // completion observations learned by the canonical pipeline reducer. A fresh
    // count must not keep a finished run active until the next full provider scan.
    const activeRuns = await prisma.gitHubWorkflowRunObservation.findMany({
      where: {
        codebaseRepositoryId: { in: repositoryIds },
        countedActive: true,
      },
      select: {
        id: true,
        workflowRunId: true,
        runAttempt: true,
        status: true,
        conclusion: true,
        githubUpdatedAt: true,
        activeStatus: true,
        activeUpdatedAt: true,
        activeObservedAt: true,
      },
    });
    if (!activeRuns.length) return 0;
    const completed = await prisma.gitHubPipelineRecord.findMany({
      where: {
        sourceControlProvider: "GITHUB",
        workflowRunId: { in: activeRuns.map((run) => run.workflowRunId) },
        status: { in: [...TERMINAL_PIPELINE_STATUSES] },
        source: { not: "MUTATION" },
      },
      select: {
        workflowRunId: true,
        runAttempt: true,
        githubUpdatedAt: true,
        canRetry: true,
        retryUnavailableReason: true,
      },
    });
    const exclusions: Prisma.GitHubWorkflowRunObservationWhereInput[] = [];
    const repairs = activeRuns.flatMap((run) => {
      const revision = run.activeUpdatedAt ?? run.githubUpdatedAt;
      const terminalRecords = completed.filter((record) => {
        if (record.workflowRunId !== run.workflowRunId) return false;
        // An old attempt's completion can arrive after a rerun starts. An unknown
        // attempt is only safe for the original attempt, never for a later rerun.
        const attempt = record.runAttempt ?? 1;
        return (
          attempt > run.runAttempt ||
          (attempt === run.runAttempt &&
            record.githubUpdatedAt !== null &&
            record.githubUpdatedAt >= revision)
        );
      });
      if (terminalRecords.length) {
        // Child-job failures can make the displayed pipeline failed before the
        // whole workflow ends. Exclude that displayed outcome, but do not forge
        // a completed-workflow fence: a newer active canonical state can return.
        exclusions.push({
          id: run.id,
          runAttempt: run.runAttempt,
          activeStatus: run.activeStatus,
          activeUpdatedAt: run.activeUpdatedAt,
          activeObservedAt: run.activeObservedAt,
        });
      }
      const confirmations = [
        ...(workflowStatus(run) === "completed"
          ? [
              {
                runAttempt: run.runAttempt,
                githubUpdatedAt: run.githubUpdatedAt,
              },
            ]
          : []),
        ...terminalRecords.filter(
          (record) =>
            record.canRetry ||
            record.retryUnavailableReason === "GITHUB_APP_NOT_CONFIGURED" ||
            record.retryUnavailableReason === "WORKFLOW_RUN_UNAVAILABLE",
        ),
      ];
      const confirmation = confirmations.find((record) => {
        const attempt = record.runAttempt ?? 1;
        return (
          attempt > run.runAttempt ||
          (attempt === run.runAttempt &&
            record.githubUpdatedAt !== null &&
            record.githubUpdatedAt >= revision)
        );
      });
      return confirmation
        ? [
            {
              run,
              updatedAt:
                confirmation.githubUpdatedAt &&
                confirmation.githubUpdatedAt > revision
                  ? confirmation.githubUpdatedAt
                  : revision,
            },
          ]
        : [];
    });
    if (repairs.length) {
      const changed = await prisma.$transaction(async (transaction) => {
        let count = 0;
        for (const { run, updatedAt } of repairs) {
          const result =
            await transaction.gitHubWorkflowRunObservation.updateMany({
              // Do not erase a newer observation received while canonical records
              // were being read. Notification history belongs to its own reducer.
              where: {
                id: run.id,
                countedActive: true,
                runAttempt: run.runAttempt,
                activeStatus: run.activeStatus,
                activeUpdatedAt: run.activeUpdatedAt,
                activeObservedAt: run.activeObservedAt,
              },
              data: {
                countedActive: false,
                activeStatus: "completed",
                activeUpdatedAt: updatedAt,
                activeObservedAt: new Date(),
              },
            });
          count += result.count;
        }
        return count;
      });
      if (changed) this.publish();
    }
    return prisma.gitHubWorkflowRunObservation.count({
      where: {
        codebaseRepositoryId: { in: repositoryIds },
        countedActive: true,
        activeStatus: { in: [...ACTIVE_WORKFLOW_STATUSES] },
        ...(exclusions.length ? { NOT: exclusions } : {}),
      },
    });
  }
}
