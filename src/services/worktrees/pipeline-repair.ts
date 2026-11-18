import "server-only";

import { randomUUID } from "node:crypto";
import {
  WORKTREE_COMMIT_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_PUSH_EVIDENCE_CAPABILITY,
} from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma, WorkflowRun, Worktree } from "@/generated/prisma/client";
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
  /** A final CI result that neither permits the merge nor can be repaired. */
  terminalStatus?: string;
};

const CI_SETTLE_MS = 60_000;
const CI_RESULT_TIMEOUT_MS = 60 * 60_000;

export type PipelineRepair = {
  id: string;
  checkout: string;
  headSha: string;
  retryCount: number;
  maxRetries: number;
  failureKey?: string;
  scheduledAt?: number;
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

export function requirePipelineRepairCapability(agent: {
  capabilitiesJson: string;
}) {
  try {
    const capabilities: unknown = JSON.parse(agent.capabilitiesJson);
    if (
      Array.isArray(capabilities) &&
      capabilities.includes(WORKTREE_PUSH_EVIDENCE_CAPABILITY)
    )
      return;
  } catch {
    // An unreadable inventory cannot confirm support for verified pushes.
  }
  throw new PipelineRepairError(
    "Update the agent to use automatic pipeline repair. It must be able to verify worktree pushes.",
  );
}

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
  | "missingAt"
> & {
  codebase: {
    agentId: string;
    repositoryId: string;
    agent: { capabilitiesJson: string };
  };
};

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

const RUN_KEY_PREFIX = "auto-pipeline-repair:";
const TERMINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"];

export const PIPELINE_REPAIR_DISPATCH_STATUSES = ["RUNNING", "WAITING"];

export function isPipelineRepairRun(idempotencyKey: string | null | undefined) {
  return idempotencyKey?.startsWith(RUN_KEY_PREFIX) === true;
}

type RepairRun = Pick<
  WorkflowRun,
  "id" | "idempotencyKey" | "parentRunId" | "status"
>;

export async function findPipelineRepairRoot(
  prisma: Pick<Prisma.TransactionClient, "workflowRun">,
  run: RepairRun | null,
) {
  while (run) {
    if (isPipelineRepairRun(run.idempotencyKey)) return run;
    if (!run.parentRunId) break;
    run = await prisma.workflowRun.findUnique({
      where: { id: run.parentRunId },
      select: {
        id: true,
        idempotencyKey: true,
        parentRunId: true,
        status: true,
      },
    });
  }
  return null;
}

function runKey(repair: PipelineRepair) {
  return `${RUN_KEY_PREFIX}${repair.id}:${repair.retryCount}`;
}

export async function cancelPipelineRepair(
  repair: PipelineRepair | undefined | null,
  workflows?: Pick<WorkflowsService, "lifecycle">,
  agents?: Pick<AgentControlService, "cancelJob">,
) {
  if (!repair || !workflows) return;
  const prisma = await getPrismaClient();
  const run = await prisma.workflowRun.findUnique({
    where: { idempotencyKey: runKey(repair) },
    select: { id: true, status: true },
  });
  if (!run) return;
  if (!TERMINAL_RUN_STATUSES.includes(run.status))
    await workflows.lifecycle(run.id, "CANCEL", { ignoreMissing: true });
  const runIds = [run.id];
  let parents = [run.id];
  while (parents.length) {
    const children = await prisma.workflowRun.findMany({
      where: { parentRunId: { in: parents } },
      select: { id: true, status: true },
    });
    for (const child of children) {
      if (!TERMINAL_RUN_STATUSES.includes(child.status))
        await workflows.lifecycle(child.id, "CANCEL", { ignoreMissing: true });
    }
    parents = children.map(({ id }) => id);
    runIds.push(...parents);
  }
  if (!agents) return;

  // The job link is saved at dispatch, which can precede creation of the wait.
  const [links, waits] = await Promise.all([
    prisma.workflowRunResourceLink.findMany({
      where: { runId: { in: runIds }, kind: "AGENT_JOB" },
      select: { resourceId: true },
    }),
    prisma.workflowWait.findMany({
      where: {
        runId: { in: runIds },
        kind: "AGENT_JOB",
        status: { in: ["PENDING", "CANCELLED", "FAILED"] },
        externalKey: { not: null },
        attempt: { kind: { in: ["WORKTREE_COMMIT", "WORKTREE_OPERATION"] } },
      },
      select: { externalKey: true },
    }),
  ]);
  const ids = [
    ...new Set([
      ...links.map(({ resourceId }) => resourceId),
      ...waits.flatMap(({ externalKey }) => (externalKey ? [externalKey] : [])),
    ]),
  ];
  if (!ids.length) return;
  const activeJobs = await prisma.agentJob.findMany({
    where: {
      id: { in: ids },
      kind: { in: [WORKTREE_COMMIT_JOB_KIND, WORKTREE_OPERATION_JOB_KIND] },
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

function waitForCIResult(since: number, now: number, terminalStatus?: string) {
  const elapsed = now - since;
  if (terminalStatus && elapsed >= CI_SETTLE_MS)
    throw new PipelineRepairError(
      `CI reported ${terminalStatus} during pipeline repair. Review the pipeline before resuming.`,
    );
  if (elapsed >= CI_RESULT_TIMEOUT_MS)
    throw new PipelineRepairError(
      "Timed out waiting for CI during pipeline repair. Check that CI is running before resuming.",
    );
  return true;
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
  if (worktree.missingAt) {
    if (repair)
      throw new PipelineRepairError(
        "The worktree disappeared during pipeline repair. Restore it before resuming.",
      );
    return false;
  }
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
    requirePipelineRepairCapability(worktree.codebase.agent);
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
      scheduledAt: now,
    });
    return true;
  }

  if (repair.verifiedAt) {
    if (!headSha) return waitForCIResult(repair.verifiedAt, now);
    if (repair.headSha !== headSha)
      throw new PipelineRepairError(
        "The source commit changed while waiting for pipeline results. Review it before resuming.",
      );
    if (ci?.passed) {
      await save(null);
      return false;
    }
    if (!ci?.failures.length)
      return waitForCIResult(repair.verifiedAt, now, ci?.terminalStatus);
    if (
      ci.failureKey === repair.failureKey &&
      now - repair.verifiedAt < CI_SETTLE_MS
    )
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
      scheduledAt: now,
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
    if (
      headSha &&
      (headSha !== repair.headSha ||
        worktree.headSha !== repair.headSha ||
        !isClean(worktree))
    )
      throw new PipelineRepairError(
        "The checkout changed before pipeline repair started. Review it before resuming.",
      );
    // Recheck the failure before dispatch if a restart interrupted scheduling.
    if (!headSha || !ci?.failures.length) {
      if (headSha && ci?.passed) {
        await save(null);
        return false;
      }
      const scheduledAt = repair.scheduledAt ?? now;
      if (repair.scheduledAt === undefined)
        await save({ ...repair, scheduledAt });
      return waitForCIResult(
        scheduledAt,
        now,
        headSha ? ci?.terminalStatus : undefined,
      );
    }
    if (ci.failureKey !== repair.failureKey) {
      await save({ ...repair, failureKey: ci.failureKey });
      return true;
    }
    requirePipelineRepairCapability(worktree.codebase.agent);
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
  if (run.status !== "SUCCEEDED") return true;
  const finishedAt = run.finishedAt?.getTime() ?? now;
  if (!headSha) return waitForCIResult(finishedAt, now);
  if (headSha !== worktree.headSha && now - finishedAt < CI_SETTLE_MS)
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
      verifiedAt: finishedAt,
    },
    headSha,
  );
  return true;
}
