import { randomUUID } from "node:crypto";

import {
  WORKTREE_AUTO_SYNC_JOB_KIND,
  WORKTREE_PREPARATION_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma, WorktreeSyncItem } from "@/generated/prisma/client";
import { isCodebaseBusyError } from "@/lib/codebase-busy";
import {
  agentOnlineWindowMs,
  type AgentControlService,
} from "@/services/agent-control";
import type { PollingService } from "@/services/polling";

import type { WorktreesService } from "./worktrees.service";

const PENDING_STATUSES = ["PENDING", "RUNNING"];
const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING", "CANCELLING"];
const POLLING_ID = "server:worktree-bulk-sync";
const POLL_SECONDS = 5;
const targetInclude = {
  codebase: {
    include: {
      agent: true,
      repository: { include: { preparations: true } },
    },
  },
} as const;
type Target = Prisma.WorktreeGetPayload<{ include: typeof targetInclude }>;
type Batch = Prisma.WorktreeSyncBatchGetPayload<{
  include: { items: true };
}>;
const batchInclude = { items: { orderBy: { position: "asc" as const } } };

export type StartWorktreeSyncBatchInput = {
  worktreeIds: string[];
  requestId: string;
  appId?: string | null;
  agentId?: string | null;
};

function capabilityList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function blockReason(target: Target): string | null {
  if (target.missingAt || target.availability !== "AVAILABLE")
    return "Worktree is unavailable";
  if (target.codebase.availability !== "AVAILABLE")
    return "Codebase is unavailable";
  const agent = target.codebase.agent;
  if (
    agent.disconnectedAt ||
    !agent.lastSeenAt ||
    Date.now() - agent.lastSeenAt.getTime() > agentOnlineWindowMs(agent)
  )
    return "Agent is offline";
  const capabilities = capabilityList(agent.capabilitiesJson);
  if (!capabilities.includes(WORKTREE_AUTO_SYNC_JOB_KIND))
    return "Update the agent to use Bulk Sync";
  if (
    target.codebase.repository.preparations.length > 0 &&
    !capabilities.includes(WORKTREE_PREPARATION_JOB_KIND)
  )
    return "Update the agent to use repository preparations";
  if (!target.branch) return "Sync requires a branch";
  if (!target.upstream) return "Sync requires an upstream branch";
  if (!(target.baseBranchOverride ?? target.codebase.defaultBranch))
    return "Sync requires a base branch";
  if (target.hasConflicts || target.rebaseInProgress)
    return "Resolve the current rebase or conflicts before syncing";
  if (target.hasStagedChanges || target.hasUnstagedChanges)
    return "Stash or commit changes before syncing";
  return null;
}

function batchView(batch: Batch) {
  return {
    ...batch,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    items: batch.items.map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      startedAt: item.startedAt?.toISOString() ?? null,
      finishedAt: item.finishedAt?.toISOString() ?? null,
    })),
  };
}

/** Durable, one-shot sync requests; independent of configured Auto Sync rules. */
export class WorktreeSyncService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerunRequested = false;
  private started = false;
  private polling?: PollingService;

  constructor(
    private readonly worktrees: WorktreesService,
    agentControl: AgentControlService,
  ) {
    agentControl.registerCompletionObserver((job) => {
      if (job.kind === WORKTREE_AUTO_SYNC_JOB_KIND) this.changed();
      return Promise.resolve();
    });
    agentControl.registerConnectionHandler(() => {
      this.changed();
      return Promise.resolve();
    });
  }

  startRuntime(polling?: PollingService): void {
    if (this.started) return;
    this.started = true;
    this.polling = polling;
    polling?.register({
      id: POLLING_ID,
      kind: "WORKTREE_AUTOMATION",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: POLL_SECONDS,
      details: { operation: "BULK_SYNC" },
    });
    this.changed();
  }

  private changed(): void {
    if (!this.started) return;
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    queueMicrotask(() => void this.reconcile());
  }

  async batch(id: string) {
    const prisma = await getPrismaClient();
    const batch = await prisma.worktreeSyncBatch.findUnique({
      where: { id },
      include: batchInclude,
    });
    return batch ? batchView(batch) : null;
  }

  async active(appId?: string | null, worktreeId?: string | null) {
    const prisma = await getPrismaClient();
    const repositories = appId
      ? await prisma.appRepository.findMany({
          where: { appId },
          select: { repositoryId: true },
        })
      : null;
    const batches = await prisma.worktreeSyncBatch.findMany({
      where: {
        status: "ACTIVE",
        ...(repositories || worktreeId
          ? {
              items: {
                some: {
                  ...(repositories
                    ? {
                        repositoryId: {
                          in: repositories.map((entry) => entry.repositoryId),
                        },
                      }
                    : {}),
                  ...(worktreeId ? { worktreeId } : {}),
                },
              },
            }
          : {}),
      },
      include: batchInclude,
      orderBy: { createdAt: "asc" },
    });
    return batches.map(batchView);
  }

  private existingBatch(batch: Batch, input: StartWorktreeSyncBatchInput) {
    if (
      batch.appId !== (input.appId ?? null) ||
      batch.agentId !== (input.agentId ?? null) ||
      batch.items.length !== input.worktreeIds.length ||
      batch.items.some((item) => !input.worktreeIds.includes(item.worktreeId))
    )
      throw new Error(
        "This request ID was already used for another Bulk Sync selection",
      );
    return batchView(batch);
  }

  async start(input: StartWorktreeSyncBatchInput) {
    const requestId = input.requestId.trim();
    const worktreeIds = [
      ...new Set(input.worktreeIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (!requestId) throw new Error("requestId is required");
    if (!worktreeIds.length)
      throw new Error("Select at least one worktree to sync");
    const normalized = { ...input, requestId, worktreeIds };
    const prisma = await getPrismaClient();
    const existing = await prisma.worktreeSyncBatch.findUnique({
      where: { requestId },
      include: batchInclude,
    });
    if (existing) return this.existingBatch(existing, normalized);
    const targets = await prisma.worktree.findMany({
      where: {
        id: { in: worktreeIds },
        codebase: {
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.appId
            ? { repository: { apps: { some: { appId: input.appId } } } }
            : {}),
        },
      },
      include: targetInclude,
    });
    const byId = new Map(targets.map((target) => [target.id, target]));
    if (byId.size !== worktreeIds.length)
      throw new Error(
        "Some selected worktrees no longer exist or are outside the page scope",
      );
    const items = await Promise.all(
      worktreeIds.map(async (id, position) => {
        const target = byId.get(id)!;
        const error =
          blockReason(target) ??
          (target.baseBehind === null
            ? "Worktree freshness is unknown; fetch and try again"
            : target.baseBehind <= 0
              ? "Worktree is already up to date"
              : null);
        const ticketKey = await this.worktrees.ticketKeyForWorktree(id);
        const cachedTicket = ticketKey
          ? await prisma.jiraCachedTicket.findUnique({
              where: { issueKey: ticketKey },
              select: { detailJson: true, summaryJson: true },
            })
          : null;
        let ticketTitle: string | null = null;
        try {
          const cached: unknown = JSON.parse(
            cachedTicket?.detailJson ?? cachedTicket?.summaryJson ?? "null",
          );
          if (cached && typeof cached === "object" && "fields" in cached) {
            const fields = cached.fields;
            if (
              fields &&
              typeof fields === "object" &&
              "summary" in fields &&
              typeof fields.summary === "string"
            )
              ticketTitle = fields.summary;
          }
        } catch {
          /* Cached metadata is optional; sync never calls Jira. */
        }
        return {
          id: randomUUID(),
          position,
          worktreeId: id,
          codebaseId: target.codebaseId,
          agentId: target.codebase.agentId,
          agentName: target.codebase.agent.name,
          repositoryId: target.codebase.repositoryId,
          repositoryName: target.codebase.repository.name,
          branch: target.branch ?? "",
          baseBranch:
            target.baseBranchOverride ?? target.codebase.defaultBranch ?? "",
          folder: target.folder,
          gitDirectory: target.gitDirectory,
          expectedOrigin: target.codebase.repository.canonicalOrigin,
          ticketKey,
          ticketTitle,
          baseBehind: target.baseBehind ?? 0,
          status: error ? "SKIPPED" : "PENDING",
          error,
          finishedAt: error ? new Date() : null,
        };
      }),
    );
    const active = items.some((item) => item.status === "PENDING");
    let batch;
    try {
      batch = await prisma.worktreeSyncBatch.create({
        data: {
          id: randomUUID(),
          requestId,
          appId: input.appId ?? null,
          agentId: input.agentId ?? null,
          status: active ? "ACTIVE" : "COMPLETED",
          finishedAt: active ? null : new Date(),
          items: { create: items },
        },
        include: batchInclude,
      });
    } catch (error) {
      const concurrent = await prisma.worktreeSyncBatch.findUnique({
        where: { requestId },
        include: batchInclude,
      });
      if (!concurrent) throw error;
      return this.existingBatch(concurrent, normalized);
    }
    this.worktrees.publishAutomationChange(worktreeIds[0]!, null);
    this.changed();
    return batchView(batch);
  }

  private async updateItem(
    item: WorktreeSyncItem,
    data: Prisma.WorktreeSyncItemUpdateManyMutationInput,
  ) {
    const prisma = await getPrismaClient();
    const changed = await prisma.$transaction(async (transaction) => {
      const result = await transaction.worktreeSyncItem.updateMany({
        where: { id: item.id, status: item.status },
        data,
      });
      if (result.count)
        await transaction.worktreeSyncBatch.update({
          where: { id: item.batchId },
          data: { updatedAt: new Date() },
        });
      return result.count > 0;
    });
    if (changed)
      this.worktrees.publishAutomationChange(item.worktreeId, item.codebaseId);
  }

  private async advance(item: WorktreeSyncItem): Promise<void> {
    const prisma = await getPrismaClient();
    // Recover before checking busy/eligibility: insertion may have succeeded just
    // before the previous process died, without linking that job to this item.
    const job = item.jobId
      ? await prisma.agentJob.findUnique({ where: { id: item.jobId } })
      : await prisma.agentJob.findUnique({
          where: {
            agentId_idempotencyKey: {
              agentId: item.agentId,
              idempotencyKey: `worktree:auto-sync:sync:${item.id}:${item.worktreeId}`,
            },
          },
        });
    if (job) {
      if (ACTIVE_JOB_STATUSES.includes(job.status)) {
        if (item.status !== "RUNNING" || !item.jobId)
          await this.updateItem(item, {
            status: "RUNNING",
            jobId: job.id,
            startedAt: job.createdAt,
          });
        return;
      }
      let status = "FAILED";
      let error = job.error;
      if (job.status === "SUCCEEDED") {
        let result: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(job.resultJson ?? "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            result = parsed as Record<string, unknown>;
        } catch {
          /* Invalid results fail closed. */
        }
        if (result.outcome === "SYNCED" || result.outcome === "NO_CHANGE") {
          status = "SUCCEEDED";
          error = null;
        } else if (
          result.outcome === "CONFLICT" ||
          result.outcome === "PREPARATION_CONFLICT"
        ) {
          status = "ATTENTION_REQUIRED";
          error =
            result.outcome === "CONFLICT"
              ? "Resolve the rebase conflicts in this worktree"
              : "Repository preparation paths require manual attention";
        } else error = "Sync returned an unknown result; inspect the agent job";
      } else error ||= `Sync ${job.status.toLowerCase()}`;
      await this.updateItem(item, {
        status,
        error,
        jobId: job.id,
        startedAt: job.createdAt,
        finishedAt: job.finishedAt ?? new Date(),
      });
      this.rerunRequested = true;
      return;
    }
    if (item.jobId) {
      await this.updateItem(item, {
        status: "FAILED",
        error: "The sync job is no longer available",
        finishedAt: new Date(),
      });
      this.rerunRequested = true;
      return;
    }
    const target = await prisma.worktree.findUnique({
      where: { id: item.worktreeId },
      include: targetInclude,
    });
    const identityChanged =
      target &&
      (target.codebaseId !== item.codebaseId ||
        target.codebase.agentId !== item.agentId ||
        target.branch !== item.branch ||
        target.folder !== item.folder ||
        target.gitDirectory !== item.gitDirectory ||
        target.codebase.repository.canonicalOrigin !== item.expectedOrigin ||
        (target.baseBranchOverride ?? target.codebase.defaultBranch) !==
          item.baseBranch);
    const reason = !target
      ? "Worktree was deleted"
      : identityChanged
        ? "Worktree identity, branch, or base changed; select it again to sync"
        : blockReason(target);
    if (reason) {
      await this.updateItem(item, {
        status: "SKIPPED",
        error: reason,
        finishedAt: new Date(),
      });
      this.rerunRequested = true;
      return;
    }
    let submitted;
    try {
      submitted = await this.worktrees.createAutoSyncJob(
        item.worktreeId,
        "SYNC",
        item.branch,
        item.id,
        false,
        item,
      );
    } catch (error) {
      if (isCodebaseBusyError(error)) return;
      // A post-insertion delivery failure can still leave a real job. Recover
      // it on the next pass rather than claiming that running Git work failed.
      const inserted = await prisma.agentJob.findUnique({
        where: {
          agentId_idempotencyKey: {
            agentId: item.agentId,
            idempotencyKey: `worktree:auto-sync:sync:${item.id}:${item.worktreeId}`,
          },
        },
      });
      if (inserted) {
        this.rerunRequested = true;
        return;
      }
      await this.updateItem(item, {
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(),
      });
      this.rerunRequested = true;
      return;
    }
    // Linking failures must remain recoverable; never turn a submitted job
    // into a failed item solely because its database projection needs retrying.
    await this.updateItem(item, {
      status: "RUNNING",
      jobId: submitted.id,
      startedAt: submitted.createdAt,
    });
  }

  /** Also exposed for focused recovery tests; runtime callers use startRuntime. */
  async reconcile(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      const operation = async () => {
        do {
          this.rerunRequested = false;
          const prisma = await getPrismaClient();
          const items = await prisma.worktreeSyncItem.findMany({
            where: {
              status: { in: PENDING_STATUSES },
              batch: { status: "ACTIVE" },
            },
            orderBy: [
              { createdAt: "asc" },
              { batchId: "asc" },
              { position: "asc" },
            ],
          });
          const lanes = new Map<string, WorktreeSyncItem>();
          for (const item of items) {
            const previous = lanes.get(item.codebaseId);
            if (
              !previous ||
              (previous.status !== "RUNNING" && item.status === "RUNNING")
            )
              lanes.set(item.codebaseId, item);
          }
          // Collect all results before surfacing a coordinator error, so an
          // independent repository still makes progress when another is broken.
          const results = await Promise.allSettled(
            [...lanes.values()].map((item) => this.advance(item)),
          );
          const finished = await prisma.worktreeSyncBatch.findMany({
            where: {
              status: "ACTIVE",
              items: { none: { status: { in: PENDING_STATUSES } } },
            },
            select: { id: true },
          });
          if (finished.length) {
            await prisma.worktreeSyncBatch.updateMany({
              where: {
                id: { in: finished.map((batch) => batch.id) },
                status: "ACTIVE",
              },
              data: { status: "COMPLETED", finishedAt: new Date() },
            });
            this.worktrees.publishAutomationChange(null, null);
          }
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure?.status === "rejected") throw failure.reason;
        } while (this.rerunRequested);
      };
      if (this.polling) await this.polling.run(POLLING_ID, operation);
      else await operation();
    } catch (error) {
      if (!this.polling)
        console.error("Bulk Sync reconciliation failed", error);
    } finally {
      this.running = false;
      if (this.started) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(
          () => void this.reconcile(),
          POLL_SECONDS * 1000,
        );
        this.timer.unref();
        this.polling?.schedule(
          POLLING_ID,
          new Date(Date.now() + POLL_SECONDS * 1000),
        );
      }
    }
  }
}
