import "server-only";

import { randomUUID } from "node:crypto";
import { WORKTREE_OPERATION_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import type { Worktree } from "@/generated/prisma/client";
import {
  workflowResourceKind,
  workflowTriggerChoices,
} from "@/lib/workflows/definition";
import type { AgentControlService } from "@/services/agent-control";
import type { WorkflowsService } from "@/services/workflows";

export type PipelineWorkflowInput = {
  pipelineWorkflowId?: string | null;
  pipelineWorkflowChoice?: string | null;
};

export type PipelineWorkflowSelection = { id: string; choice: string | null };

export type FailingPipeline = {
  provider: "GITHUB" | "GITLAB";
  id: string;
  status: string;
  url: string | null;
  headSha: string;
  repositoryGithubId?: string;
  projectId?: string;
  workflowRunId?: string;
};

export type PipelineCI = {
  passed: boolean;
  failures: FailingPipeline[];
  /** The provider's identity for the failed run(s), including rerun information. */
  failureKey?: string;
};

export type PipelineRepair = {
  id: string;
  checkout: string;
  headSha: string;
  retryCount: number;
  maxRetries: number;
  failureKey?: string;
  verifiedAt?: number;
};

export function pipelineWorkflowSelection(
  input: PipelineWorkflowInput,
  previous?: PipelineWorkflowSelection,
): PipelineWorkflowSelection | undefined {
  const id =
    input.pipelineWorkflowId === undefined
      ? previous?.id
      : input.pipelineWorkflowId?.trim();
  const choice =
    input.pipelineWorkflowChoice === undefined && id === previous?.id
      ? (previous?.choice ?? null)
      : input.pipelineWorkflowChoice?.trim() || null;
  if (choice && !id)
    throw new PipelineRepairError(
      "Select a failing pipeline workflow before choosing its trigger.",
    );
  return id ? { id, choice } : undefined;
}

export async function worktreeAutomationWorkflows(
  repositoryId: string,
  kind: "FAILING_PIPELINE" | "MERGE_CONFLICT",
) {
  const prisma = await getPrismaClient();
  const rows = await prisma.workflow.findMany({
    where: {
      enabled: true,
      archivedAt: null,
      activeVersionId: { not: null },
      quickActionKind: kind,
      OR: [
        { quickActionRepositories: { none: {} } },
        { quickActionRepositories: { some: { repositoryId } } },
      ],
    },
    include: { activeVersion: { include: { triggers: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return rows.flatMap((workflow) => {
    const triggers = (workflow.activeVersion?.triggers ?? []).flatMap(
      ({ kind, configJson }) => {
        if (kind !== "RESOURCE_MANUAL" && kind !== "RESOURCE_MANUAL_CHOICE")
          return [];
        try {
          const config = JSON.parse(configJson);
          return workflowResourceKind(config) === "WORKTREE"
            ? [{ kind, config }]
            : [];
        } catch {
          return [];
        }
      },
    );
    return triggers.length ? [{ workflow, triggers }] : [];
  });
}

export async function validatePipelineWorkflow(
  repositoryId: string,
  selection: PipelineWorkflowSelection,
) {
  const eligible = (
    await worktreeAutomationWorkflows(repositoryId, "FAILING_PIPELINE")
  ).find(({ workflow }) => workflow.id === selection.id);
  if (!eligible)
    throw new PipelineRepairError(
      "Select an enabled failing pipeline workflow for this repository.",
    );
  const validChoice = selection.choice
    ? eligible.triggers.some(
        ({ kind, config }) =>
          kind === "RESOURCE_MANUAL_CHOICE" &&
          workflowTriggerChoices(config).some(
            ({ key }) => key === selection.choice,
          ),
      )
    : eligible.triggers.some(({ kind }) => kind === "RESOURCE_MANUAL");
  if (!validChoice)
    throw new PipelineRepairError(
      "Select a valid trigger for the failing pipeline workflow.",
    );
  return eligible.workflow;
}

export class PipelineRepairError extends Error {}

type Checkout = Pick<
  Worktree,
  | "id"
  | "codebaseId"
  | "branch"
  | "headSha"
  | "folder"
  | "gitDirectory"
  | "hasConflicts"
  | "rebaseInProgress"
  | "hasStagedChanges"
  | "hasUnstagedChanges"
  | "availability"
> & { codebase: { agentId: string; repositoryId: string } };

function checkoutKey(worktree: Checkout) {
  return JSON.stringify([
    worktree.codebaseId,
    worktree.codebase.agentId,
    worktree.codebase.repositoryId,
    worktree.branch,
    worktree.folder,
    worktree.gitDirectory,
  ]);
}

function isClean(worktree: Checkout) {
  return (
    worktree.availability === "AVAILABLE" &&
    !worktree.hasConflicts &&
    !worktree.rebaseInProgress &&
    !worktree.hasStagedChanges &&
    !worktree.hasUnstagedChanges
  );
}

function runKey(repair: PipelineRepair) {
  return `auto-pipeline-repair:${repair.id}:${repair.retryCount}`;
}

export async function cancelPipelineRepair(
  repair: PipelineRepair | undefined | null,
  workflows?: Pick<WorkflowsService, "lifecycle">,
  agents?: Pick<AgentControlService, "cancelJob">,
) {
  if (!repair || repair.verifiedAt || !workflows) return;
  const prisma = await getPrismaClient();
  const run = await prisma.workflowRun.findUnique({
    where: { idempotencyKey: runKey(repair) },
    select: { id: true, status: true },
  });
  if (!run) return;
  if (!["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(run.status))
    await workflows.lifecycle(run.id, "CANCEL", { ignoreMissing: true });
  if (!agents) return;

  // A Git job already dispatched by the run can outlive the workflow itself.
  const waits = await prisma.workflowWait.findMany({
    where: {
      runId: run.id,
      kind: "AGENT_JOB",
      status: { in: ["PENDING", "CANCELLED", "FAILED"] },
      externalKey: { not: null },
      attempt: { kind: "WORKTREE_OPERATION" },
    },
    select: { externalKey: true },
  });
  const ids = waits.flatMap(({ externalKey }) =>
    externalKey ? [externalKey] : [],
  );
  if (!ids.length) return;
  const activeJobs = await prisma.agentJob.findMany({
    where: {
      id: { in: ids },
      kind: WORKTREE_OPERATION_JOB_KIND,
      status: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"] },
    },
    select: { id: true },
  });
  await Promise.all(activeJobs.map(({ id }) => agents.cancelJob(id)));
}

async function recordedPush(
  runId: string,
  worktree: Checkout,
  headSha: string,
) {
  const prisma = await getPrismaClient();
  const waits = await prisma.workflowWait.findMany({
    where: {
      runId,
      kind: "AGENT_JOB",
      status: "RESOLVED",
      externalKey: { not: null },
      attempt: {
        kind: "WORKTREE_OPERATION",
        status: "SUCCEEDED",
        supersededAt: null,
      },
    },
    select: { externalKey: true },
  });
  const ids = waits.flatMap(({ externalKey }) =>
    externalKey ? [externalKey] : [],
  );
  if (!ids.length) return false;
  const jobs = await prisma.agentJob.findMany({
    where: {
      id: { in: ids },
      worktreeId: worktree.id,
      codebaseId: worktree.codebaseId,
      agentId: worktree.codebase.agentId,
      kind: WORKTREE_OPERATION_JOB_KIND,
      status: "SUCCEEDED",
    },
    select: { payloadJson: true, resultJson: true },
  });
  return jobs.some(({ payloadJson, resultJson }) => {
    const payload = JSON.parse(payloadJson);
    const result = JSON.parse(resultJson ?? "null");
    return (
      payload.operation === "PUSH" &&
      result?.pushedHeadSha === headSha &&
      result.worktree?.headSha === headSha &&
      result.worktree.branch === worktree.branch &&
      result.worktree.gitDirectory === worktree.gitDirectory &&
      result.worktree.folder === worktree.folder
    );
  });
}

/** Move at most one checkpoint per poll. Scheduling is keyed by the persisted attempt. */
export async function advancePipelineRepair({
  worktree,
  selection,
  repair,
  headSha,
  ci,
  workflows,
  save,
  now = Date.now(),
}: {
  worktree: Checkout;
  selection: PipelineWorkflowSelection;
  repair?: PipelineRepair | null;
  headSha: string | null;
  ci?: PipelineCI;
  workflows: Pick<WorkflowsService, "trigger">;
  save: (
    next: PipelineRepair | null,
    acceptedHeadSha?: string,
  ) => Promise<void>;
  now?: number;
}): Promise<boolean> {
  const checkout = checkoutKey(worktree);
  if (repair && repair.checkout !== checkout)
    throw new PipelineRepairError(
      "The worktree changed during pipeline repair. Review it before resuming.",
    );
  if (!repair) {
    if (
      !headSha ||
      headSha !== worktree.headSha ||
      !isClean(worktree) ||
      !ci?.failures.length
    )
      return false;
    const workflow = await validatePipelineWorkflow(
      worktree.codebase.repositoryId,
      selection,
    );
    await save({
      id: randomUUID(),
      checkout,
      headSha,
      retryCount: 0,
      maxRetries: workflow.maxPipelineRepairRetries,
      failureKey: ci.failureKey,
    });
    return true;
  }

  if (repair.verifiedAt) {
    if (!headSha) return true;
    if (repair.headSha !== headSha)
      throw new PipelineRepairError(
        "The source commit changed while waiting for pipeline results. Review it before resuming.",
      );
    if (ci?.passed) {
      await save(null);
      return false;
    }
    if (!ci?.failures.length) return true;
    if (ci.failureKey === repair.failureKey && now - repair.verifiedAt < 60_000)
      return true;
    if (repair.retryCount >= repair.maxRetries)
      throw new PipelineRepairError(
        "CI is still failing after pipeline repair. Review the run and retry or resume the automation.",
      );
    if (worktree.headSha !== headSha || !isClean(worktree))
      throw new PipelineRepairError(
        "The checkout changed after pipeline repair. Restore a clean checkout before resuming.",
      );
    await save({
      ...repair,
      retryCount: repair.retryCount + 1,
      failureKey: ci.failureKey,
      verifiedAt: undefined,
    });
    return true;
  }

  const prisma = await getPrismaClient();
  const key = runKey(repair);
  const run = await prisma.workflowRun.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, status: true, finishedAt: true },
  });
  if (!run) {
    if (!headSha) return true;
    if (
      headSha !== repair.headSha ||
      worktree.headSha !== repair.headSha ||
      !isClean(worktree)
    )
      throw new PipelineRepairError(
        "The checkout changed before pipeline repair started. Review it before resuming.",
      );
    // Recheck the failure before dispatch if a restart interrupted scheduling.
    if (!ci?.failures.length) {
      if (ci?.passed) {
        await save(null);
        return false;
      }
      return true;
    }
    if (ci.failureKey !== repair.failureKey) {
      await save({ ...repair, failureKey: ci.failureKey });
      return true;
    }
    await validatePipelineWorkflow(worktree.codebase.repositoryId, selection);
    const scheduled = await workflows.trigger(
      {
        workflowId: selection.id,
        resourceKind: "WORKTREE",
        resourceId: worktree.id,
        subjectKey: key,
        choice: selection.choice,
        sessionData: {
          worktree: {
            failingPipelines: ci.failures,
            pipelineRepair: {
              retryCount: repair.retryCount,
              maxRetries: repair.maxRetries,
            },
          },
        },
      },
      key,
    );
    if (!scheduled)
      throw new PipelineRepairError(
        "The failing pipeline workflow did not start.",
      );
    return true;
  }

  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(run.status))
    throw new PipelineRepairError(
      `Pipeline repair workflow ${run.status.toLowerCase()}. Review the run before resuming.`,
    );
  if (run.status !== "SUCCEEDED" || !headSha) return true;
  if (
    headSha !== worktree.headSha &&
    now - (run.finishedAt?.getTime() ?? now) < 60_000
  )
    return true;
  if (headSha !== worktree.headSha || !isClean(worktree))
    throw new PipelineRepairError(
      "Pipeline repair must leave a clean checkout at the pushed branch revision.",
    );
  if (
    headSha !== repair.headSha &&
    !(await recordedPush(run.id, worktree, headSha))
  )
    throw new PipelineRepairError(
      "Pipeline repair changed the source commit without a verified worktree Push step. Review the new commit before resuming.",
    );
  await save(
    {
      ...repair,
      headSha,
      verifiedAt: run.finishedAt?.getTime() ?? now,
    },
    headSha,
  );
  return true;
}
