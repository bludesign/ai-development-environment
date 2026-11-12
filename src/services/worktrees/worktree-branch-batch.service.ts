import { createHash, randomUUID } from "node:crypto";

import {
  validGitBranchName,
  WORKTREE_BRANCH_JOB_KIND,
} from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma, WorktreeBranchItem } from "@/generated/prisma/client";
import { isCodebaseBusyError } from "@/lib/codebase-busy";
import { parseJiraIssueKey } from "@/lib/jira-issue-key";
import type { AgentControlService } from "@/services/agent-control";
import type { PollingService } from "@/services/polling";

import type {
  WorktreeBranchSelection,
  WorktreesService,
} from "./worktrees.service";

const POLLING_ID = "server:worktree-bulk-change-branch";
const POLL_SECONDS = 5;
const UNFINISHED_ITEMS = ["PENDING", "RUNNING"];
const UNFINISHED_JOBS = ["QUEUED", "RUNNING", "CANCELLING"];
const batchInclude = { items: { orderBy: { position: "asc" as const } } };
const itemInclude = {
  batch: { select: { appId: true, branchName: true, mode: true } },
} as const;
type Batch = Prisma.WorktreeBranchBatchGetPayload<{
  include: typeof batchInclude;
}>;
type BatchItem = Prisma.WorktreeBranchItemGetPayload<{
  include: typeof itemInclude;
}>;
type Scope = { appId?: string | null; agentId?: string | null };

export const branchBatchTargetInclude = {
  codebase: {
    include: {
      agent: true,
      repository: { include: { preparations: true } },
      worktrees: { where: { missingAt: null }, select: { branch: true } },
    },
  },
} as const;
export type BranchBatchTarget = Prisma.WorktreeGetPayload<{
  include: typeof branchBatchTargetInclude;
}>;
export type BranchBatchTargetGuard = Pick<
  WorktreeBranchItem,
  | "id"
  | "worktreeId"
  | "codebaseId"
  | "agentId"
  | "repositoryId"
  | "folder"
  | "gitDirectory"
  | "expectedOrigin"
>;
export type BranchBatchTargetSelection = {
  mode: WorktreeBranchSelection["mode"];
  branchName: string;
  baseBranch: string;
  expectedBranch: string | null;
};
export type StartWorktreeBranchBatchInput = Scope & {
  requestId: string;
  mode: BranchBatchTargetSelection["mode"];
  branchName: string;
  ticketKey?: string | null;
  items: Array<{
    worktreeId: string;
    expectedBranch?: string | null;
    baseBranch: string;
  }>;
};

export function branchBatchScopeWhere({ appId, agentId }: Scope) {
  return {
    codebase: {
      ...(agentId != null ? { agentId } : {}),
      ...(appId != null ? { repository: { apps: { some: { appId } } } } : {}),
    },
  } satisfies Prisma.WorktreeWhereInput;
}

export class BranchBatchSkipError extends Error {}

export function bulkBranchChangeJobKey(itemId: string, worktreeId: string) {
  return `worktree:branch:bulk-change:${itemId}:${worktreeId}`;
}

function batchView(batch: Batch) {
  return {
    ...batch,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    finishedAt: batch.finishedAt?.toISOString() ?? null,
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jobOutcome(
  job: { status: string; error: string | null; resultJson: string | null },
  branchName: string,
) {
  if (job.status !== "SUCCEEDED") {
    return {
      status: "FAILED",
      error: job.error || `Branch change ${job.status.toLowerCase()}`,
    };
  }
  let result: Record<string, unknown> | null = null;
  try {
    result = readObject(JSON.parse(job.resultJson ?? "null"));
  } catch {
    // An invalid result cannot confirm the checkout.
  }
  if (readObject(result?.worktree)?.branch !== branchName) {
    return {
      status: "FAILED",
      error:
        "The agent did not confirm the destination branch; inspect the agent job",
    };
  }
  const failures = Array.isArray(result?.preparations)
    ? result.preparations
        .map(readObject)
        .filter((item) => item?.state === "ERROR")
    : [];
  const messages = failures.flatMap((item) =>
    typeof item?.message === "string" && item.message.trim()
      ? [item.message]
      : [],
  );
  return {
    status: "SUCCEEDED",
    warning: failures.length
      ? messages.join("\n") || "Repository preparations require attention"
      : null,
  };
}

export class WorktreeBranchBatchService {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private rerun = false;
  private polling?: PollingService;

  constructor(
    private readonly worktrees: Pick<
      WorktreesService,
      "bulkBranchTargetIssue" | "dispatchBulkBranchChange"
    >,
    private readonly agentControl: Pick<
      AgentControlService,
      "getJob" | "getJobByIdempotencyKey" | "registerCompletionObserver"
    >,
  ) {}

  startRuntime(polling: PollingService) {
    if (this.polling) return;
    this.polling = polling;
    polling.register({
      id: POLLING_ID,
      kind: "WORKTREE_AUTOMATION",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: POLL_SECONDS,
      details: { operation: "BULK_CHANGE_BRANCH" },
    });
    this.agentControl.registerCompletionObserver((job) => {
      if (job.kind === WORKTREE_BRANCH_JOB_KIND) this.wake();
      return Promise.resolve();
    });
    this.wake();
  }

  private wake() {
    if (!this.polling) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.reconcile(), 0).unref();
  }

  async batch(id: string) {
    const prisma = await getPrismaClient();
    const batch = await prisma.worktreeBranchBatch.findUnique({
      where: { id },
      include: batchInclude,
    });
    return batch ? batchView(batch) : null;
  }

  async batches(scope: Scope) {
    const prisma = await getPrismaClient();
    const where = {
      appId: scope.appId ?? null,
      agentId: scope.agentId ?? null,
    };
    const [active, recent] = await Promise.all([
      prisma.worktreeBranchBatch.findMany({
        where: { ...where, status: "ACTIVE" },
        include: batchInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
      prisma.worktreeBranchBatch.findFirst({
        where: { ...where, status: "COMPLETED" },
        include: batchInclude,
        orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
      }),
    ]);
    return [...active, ...(recent ? [recent] : [])].map(batchView);
  }

  async start(input: StartWorktreeBranchBatchInput) {
    const requestId = input.requestId.trim();
    if (!requestId) throw new Error("requestId is required");
    if (!input.items.length) throw new Error("Select at least one worktree");
    const appId = input.appId ?? null;
    const agentId = input.agentId ?? null;
    const mode = input.mode;
    const branchName = input.branchName.trim();
    if (!validGitBranchName(branchName))
      throw new Error("Enter a valid Git branch name");
    const ticketKey =
      mode === "TICKET" ? parseJiraIssueKey(input.ticketKey ?? "") : null;
    if (mode === "TICKET" && !ticketKey)
      throw new Error("Enter a valid Jira issue key");
    const selections = input.items.map(
      ({ worktreeId, expectedBranch, baseBranch }) => ({
        worktreeId,
        expectedBranch: expectedBranch ?? null,
        baseBranch: baseBranch.trim(),
      }),
    );
    const worktreeIds = selections.map(({ worktreeId }) => worktreeId);
    if (new Set(worktreeIds).size !== selections.length)
      throw new Error("Select each worktree only once");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          appId,
          agentId,
          mode,
          branchName,
          ticketKey,
          selections,
        }),
      )
      .digest("hex");
    const reuse = (batch: Batch) => {
      if (batch.fingerprint !== fingerprint)
        throw new Error(
          "This request ID was already used for another branch change selection",
        );
      return batchView(batch);
    };
    const prisma = await getPrismaClient();
    const readRequest = () =>
      prisma.worktreeBranchBatch.findUnique({
        where: { requestId },
        include: batchInclude,
      });
    const existing = await readRequest();
    if (existing) return reuse(existing);

    const targets = await prisma.worktree.findMany({
      where: {
        id: { in: worktreeIds },
        ...branchBatchScopeWhere({ appId, agentId }),
      },
      include: branchBatchTargetInclude,
    });
    if (targets.length !== selections.length)
      throw new Error(
        "Some selected worktrees no longer exist or are outside this scope",
      );
    if (
      new Set(targets.map(({ codebaseId }) => codebaseId)).size !==
      targets.length
    )
      throw new Error(
        "Select only one worktree per codebase for a branch change",
      );
    const byId = new Map(targets.map((target) => [target.id, target]));
    const items = selections.map((selection, position) => {
      const { worktreeId, expectedBranch, baseBranch } = selection;
      const target = byId.get(worktreeId)!;
      const { codebase } = target;
      const error = this.worktrees.bulkBranchTargetIssue(target, {
        ...selection,
        mode,
        branchName,
      });
      return {
        id: randomUUID(),
        position,
        worktreeId,
        codebaseId: target.codebaseId,
        agentId: codebase.agentId,
        agentName: codebase.agent.name,
        repositoryId: codebase.repositoryId,
        repositoryName: codebase.repository.name,
        sourceBranch: expectedBranch,
        baseBranch,
        folder: target.folder,
        gitDirectory: target.gitDirectory,
        expectedOrigin: codebase.repository.canonicalOrigin,
        status: error ? "SKIPPED" : "PENDING",
        error,
      };
    });
    const active = items.some((item) => item.status === "PENDING");
    try {
      const batch = await prisma.worktreeBranchBatch.create({
        data: {
          id: randomUUID(),
          requestId,
          fingerprint,
          appId,
          agentId,
          mode,
          branchName,
          ticketKey,
          status: active ? "ACTIVE" : "COMPLETED",
          finishedAt: active ? null : new Date(),
          items: { create: items },
        },
        include: batchInclude,
      });
      if (active) this.wake();
      return batchView(batch);
    } catch (error) {
      const concurrent = await readRequest();
      if (concurrent) return reuse(concurrent);
      throw error;
    }
  }

  private async updateItem(
    item: BatchItem,
    data: Prisma.WorktreeBranchItemUpdateManyMutationInput,
  ) {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (tx) => {
      const result = await tx.worktreeBranchItem.updateMany({
        where: { id: item.id, status: item.status },
        data,
      });
      if (result.count) {
        await tx.worktreeBranchBatch.update({
          where: { id: item.batchId },
          data: { updatedAt: new Date() },
        });
      }
    });
  }

  private async advance(item: BatchItem) {
    const recover = () =>
      this.agentControl.getJobByIdempotencyKey(
        item.agentId,
        bulkBranchChangeJobKey(item.id, item.worktreeId),
      );
    // Recover a job inserted before a restart or lost dispatch response before
    // checking the source, since the job may already have switched the branch.
    const job = item.jobId
      ? await this.agentControl.getJob(item.jobId)
      : await recover();
    if (job) {
      if (UNFINISHED_JOBS.includes(job.status)) {
        if (item.status !== "RUNNING")
          await this.updateItem(item, { status: "RUNNING", jobId: job.id });
        return;
      }
      await this.updateItem(item, {
        ...jobOutcome(job, item.batch.branchName),
        jobId: job.id,
      });
      this.rerun = true;
      return;
    }
    if (item.jobId) {
      await this.updateItem(item, {
        status: "FAILED",
        error: "The branch change job is no longer available",
      });
      this.rerun = true;
      return;
    }
    let submitted;
    try {
      submitted = await this.worktrees.dispatchBulkBranchChange(
        item,
        {
          expectedBranch: item.sourceBranch,
          baseBranch: item.baseBranch,
          branchName: item.batch.branchName,
          mode: item.batch.mode as BranchBatchTargetSelection["mode"],
        },
        item.batch.appId,
      );
    } catch (error) {
      if (await recover()) {
        this.rerun = true;
        return;
      }
      if (isCodebaseBusyError(error)) return;
      await this.updateItem(item, {
        status: error instanceof BranchBatchSkipError ? "SKIPPED" : "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
      this.rerun = true;
      return;
    }
    await this.updateItem(item, { status: "RUNNING", jobId: submitted.id });
  }

  async reconcile() {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    try {
      const run = async () => {
        const prisma = await getPrismaClient();
        do {
          this.rerun = false;
          const items = await prisma.worktreeBranchItem.findMany({
            where: {
              status: { in: UNFINISHED_ITEMS },
              batch: { status: "ACTIVE" },
            },
            include: itemInclude,
            orderBy: [
              { batch: { createdAt: "asc" } },
              { batchId: "asc" },
              { position: "asc" },
            ],
          });
          const lanes = new Map<string, BatchItem>();
          for (const item of items) {
            const current = lanes.get(item.codebaseId);
            if (
              !current ||
              (item.status === "RUNNING" && current.status !== "RUNNING")
            )
              lanes.set(item.codebaseId, item);
          }
          const results = await Promise.allSettled(
            [...lanes.values()].map((item) => this.advance(item)),
          );
          await prisma.worktreeBranchBatch.updateMany({
            where: {
              status: "ACTIVE",
              items: { none: { status: { in: UNFINISHED_ITEMS } } },
            },
            data: { status: "COMPLETED", finishedAt: new Date() },
          });
          const failure = results.find(
            (result) => result.status === "rejected",
          );
          if (failure) throw failure.reason;
        } while (this.rerun);
      };
      if (this.polling) await this.polling.run(POLLING_ID, run);
      else await run();
    } catch (error) {
      if (!this.polling) throw error;
    } finally {
      this.running = false;
      if (this.polling) {
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () => void this.reconcile(),
          POLL_SECONDS * 1000,
        ).unref();
        this.polling.schedule(
          POLLING_ID,
          new Date(Date.now() + POLL_SECONDS * 1000),
        );
      }
    }
  }
}
