import "server-only";
import { randomUUID } from "node:crypto";
import {
  WORKTREE_AUTO_SYNC_JOB_KIND,
  WORKTREE_REVIEWED_SYNC_CAPABILITY,
  WORKTREE_REVIEWED_SYNC_FINALIZE_CAPABILITY,
} from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import { isCodebaseBusyError } from "@/lib/codebase-busy";
import {
  workflowResourceKind,
  workflowTriggerChoices,
} from "@/lib/workflows/definition";
import type { AgentControlService } from "@/services/agent-control";
import type { WorkflowsService } from "@/services/workflows";
import type { WorktreesService } from "./worktrees.service";

export const MANAGED_MERGE_STATES = [
  "SYNCING",
  "RESOLVING",
  "WAITING_CI",
  "WAITING_REQUIREMENTS",
  "MERGING",
];
const FINISHED = ["COMPLETED", "CANCELED"];
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const locks = new Map<string, Promise<void>>();

// Older coordinators mistook this specific dispatch error for a permanent failure.
export const LEGACY_CODEBASE_BUSY_MESSAGE =
  "Another operation is active for this codebase";

export function isTransientMergeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  return (
    isCodebaseBusyError(error) ||
    /offline|busy|another operation|active job|temporar|fetch failed|ECONN|network|rate limit|timeout|timed out/i.test(
      message,
    ) ||
    status === 429 ||
    Boolean(status && status >= 500)
  );
}

/** Provider readiness changed before a merge mutation was sent; it is safe to recheck. */
export class MergeSyncNotSubmittedError extends Error {}

export async function withMergeSyncLock<T>(
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(id, next);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(id) === next) locks.delete(id);
  }
}

export type MergeSyncReadiness = {
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  sourceOrigin: string;
  sourceBranch: string;
  targetOrigin: string;
  targetUrl: string;
  targetBranch: string;
  targetSha: string;
  ciPassed: boolean;
  canMerge: boolean;
  hasConflicts?: boolean;
  blocker?: string | null;
  nativeAutoMerge: boolean;
};

type SyncIntent = {
  version: 1;
  sourceOrigin: string;
  sourceBranch: string;
  headSha: string;
  targetOrigin: string;
  targetUrl: string;
  targetBranch: string;
  syncedTargetSha: string | null;
  jobId: string | null;
  requestId: string | null;
  codebaseId: string;
  agentId: string;
  folder: string;
  gitDirectory: string;
  conflictWorkflow?: { id: string; choice: string | null };
  conflictResolution?: {
    runId: string;
    targetSha: string;
    finalizing: boolean;
  };
};

export type MergeConflictWorkflowFields = {
  mergeConflictWorkflows?: Array<{
    id: string;
    name: string;
    hasPlainTrigger?: boolean;
    triggerChoices?: Array<{ key: string; label: string }>;
  }>;
  defaultConflictWorkflowId?: string | null;
  defaultConflictWorkflowChoice?: string | null;
  conflictWorkflowBlockedReason?: string | null;
  autoSyncRequiresConflictWorkflow?: boolean;
};

export type MergeConflictWorkflowInput = {
  conflictWorkflowId?: string | null;
  conflictWorkflowChoice?: string | null;
};

const CONFLICT_WORKFLOW_AGENT_REQUIRED =
  "Update the agent to resolve Auto Merge conflicts with a workflow.";
const CONFLICT_WORKFLOW_REQUIRED =
  "Select a merge conflict workflow to resolve the branch conflicts automatically.";
const MANUAL_CONFLICT =
  "Resolve the rebase conflicts, finish and push the rebase, then resume Auto Merge.";
const CONFLICT_TARGET_CHANGED =
  "The target commit changed during conflict resolution. Review it before resuming Auto Merge.";

export function readMergeSync(value: string | null): SyncIntent {
  const parsed = JSON.parse(value ?? "null") as SyncIntent | null;
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.headSha ||
    !parsed.sourceOrigin ||
    !parsed.targetOrigin ||
    !parsed.targetBranch ||
    !parsed.agentId ||
    !parsed.gitDirectory
  )
    throw new Error(
      "The saved branch sync is invalid. Review and enable Auto Merge again.",
    );
  return parsed;
}

async function syncWorktree(worktreeId: string) {
  return (await getPrismaClient()).worktree.findUnique({
    where: { id: worktreeId },
    include: { codebase: { include: { agent: true, repository: true } } },
  });
}

function hasSyncCapability(
  worktree: NonNullable<Awaited<ReturnType<typeof syncWorktree>>>,
  capability: string,
): boolean {
  try {
    const capabilities: unknown = JSON.parse(
      worktree.codebase.agent.capabilitiesJson,
    );
    return Array.isArray(capabilities) && capabilities.includes(capability);
  } catch {
    return false;
  }
}

async function conflictWorkflows(repositoryId: string) {
  const prisma = await getPrismaClient();
  const rows = await prisma.workflow.findMany({
    where: {
      enabled: true,
      archivedAt: null,
      activeVersionId: { not: null },
      quickActionKind: "MERGE_CONFLICT",
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
    return triggers.length > 0 ? [{ workflow, triggers }] : [];
  });
}

async function validateConflictWorkflow(
  worktree: NonNullable<Awaited<ReturnType<typeof syncWorktree>>>,
  selected: NonNullable<SyncIntent["conflictWorkflow"]>,
) {
  if (!hasSyncCapability(worktree, WORKTREE_REVIEWED_SYNC_FINALIZE_CAPABILITY))
    throw new Error(CONFLICT_WORKFLOW_AGENT_REQUIRED);
  const eligible = (
    await conflictWorkflows(worktree.codebase.repository.id)
  ).find(({ workflow }) => workflow.id === selected.id);
  if (!eligible)
    throw new Error(
      "Select an enabled merge conflict workflow for this repository.",
    );
  const validChoice = selected.choice
    ? eligible.triggers.some(
        ({ kind, config }) =>
          kind === "RESOURCE_MANUAL_CHOICE" &&
          workflowTriggerChoices(config).some(
            ({ key }) => key === selected.choice,
          ),
      )
    : eligible.triggers.some(({ kind }) => kind === "RESOURCE_MANUAL");
  if (!validChoice)
    throw new Error("Select a valid trigger for the merge conflict workflow.");
}

export async function mergeConflictWorkflowOptions(
  worktreeId?: string | null,
  syncStateJson?: string | null,
) {
  const worktree = worktreeId ? await syncWorktree(worktreeId) : null;
  const supportsResolution =
    worktree &&
    hasSyncCapability(worktree, WORKTREE_REVIEWED_SYNC_FINALIZE_CAPABILITY);
  const workflows = supportsResolution
    ? (await conflictWorkflows(worktree.codebase.repository.id)).map(
        ({ workflow }) => workflow,
      )
    : [];
  let selected: SyncIntent["conflictWorkflow"];
  if (syncStateJson) {
    try {
      selected = readMergeSync(syncStateJson).conflictWorkflow;
    } catch {
      // Older or invalid saved sync data does not prevent reviewing the sheet.
    }
  }
  return {
    mergeConflictWorkflows: workflows,
    defaultConflictWorkflowId: selected?.id ?? null,
    defaultConflictWorkflowChoice: selected?.choice ?? null,
    conflictWorkflowBlockedReason:
      worktree && !supportsResolution
        ? CONFLICT_WORKFLOW_AGENT_REQUIRED
        : workflows.length === 0
          ? "No merge conflict workflow is available for this repository."
          : null,
  };
}

export async function mergeSyncUnavailableReason(
  worktreeId?: string | null,
): Promise<string | null> {
  if (!worktreeId)
    return "Link a matching worktree to automatically sync this branch.";
  const worktree = await syncWorktree(worktreeId);
  if (!worktree || worktree.missingAt || worktree.availability !== "AVAILABLE")
    return "The linked worktree is unavailable.";
  if (!hasSyncCapability(worktree, WORKTREE_REVIEWED_SYNC_CAPABILITY))
    return "Update the agent to use Auto Merge branch syncing.";
  return null;
}

export async function managedMergeOwnsWorktree(
  worktreeId: string,
  except?: { provider: "GITHUB" | "GITLAB"; id: string },
): Promise<boolean> {
  const prisma = await getPrismaClient();
  const [github, gitlab] = await Promise.all([
    except?.provider === "GITHUB"
      ? null
      : prisma.worktreeAutoMerge.findFirst({
          where: { worktreeId, autoSync: true, state: { notIn: FINISHED } },
        }),
    prisma.gitLabMergeOperation.findFirst({
      where: {
        worktreeId,
        autoSync: true,
        state: { notIn: FINISHED },
        ...(except?.provider === "GITLAB" ? { id: { not: except.id } } : {}),
      },
    }),
  ]);
  return Boolean(github || gitlab);
}

export async function prepareMergeSync(
  worktreeId: string,
  ready: MergeSyncReadiness,
  owner: { provider: "GITHUB" | "GITLAB"; id: string },
  selection: MergeConflictWorkflowInput = {},
): Promise<string> {
  const reason = await mergeSyncUnavailableReason(worktreeId);
  if (reason) throw new Error(reason);
  if (await managedMergeOwnsWorktree(worktreeId, owner))
    throw new Error("Another Auto Merge operation owns this worktree.");
  const prisma = await getPrismaClient();
  const standalone = await prisma.worktreeAutoSync.findUnique({
    where: { worktreeId },
  });
  if (standalone?.activeJobId || standalone?.workflowRunId)
    throw new Error(
      "Wait for the active Auto Sync operation before enabling Auto Merge.",
    );
  const worktree = await syncWorktree(worktreeId);
  if (!worktree) throw new Error("The linked worktree is unavailable.");
  const workflowId = selection.conflictWorkflowId?.trim();
  const workflowChoice = selection.conflictWorkflowChoice?.trim() || null;
  if (workflowChoice && !workflowId)
    throw new Error(
      "Select a merge conflict workflow before choosing its trigger.",
    );
  const conflictWorkflow = workflowId
    ? { id: workflowId, choice: workflowChoice }
    : undefined;
  if (conflictWorkflow)
    await validateConflictWorkflow(worktree, conflictWorkflow);
  else if (ready.hasConflicts) throw new Error(CONFLICT_WORKFLOW_REQUIRED);
  if (
    worktree.branch !== ready.sourceBranch ||
    worktree.codebase.repository.canonicalOrigin.toLowerCase() !==
      ready.sourceOrigin.toLowerCase() ||
    worktree.headSha !== ready.headSha
  )
    throw new Error(
      "The linked worktree does not match the reviewed source branch and commit. Refresh it before enabling Auto Merge.",
    );
  if (
    worktree.hasConflicts ||
    worktree.rebaseInProgress ||
    worktree.hasStagedChanges ||
    worktree.hasUnstagedChanges
  )
    throw new Error(
      "Resolve conflicts and stash or commit changes before enabling Auto Merge.",
    );
  const intent: SyncIntent = {
    version: 1,
    sourceOrigin: ready.sourceOrigin,
    sourceBranch: ready.sourceBranch,
    headSha: ready.headSha,
    targetOrigin: ready.targetOrigin,
    targetUrl: ready.targetUrl,
    targetBranch: ready.targetBranch,
    syncedTargetSha: null,
    jobId: null,
    requestId: null,
    codebaseId: worktree.codebaseId,
    agentId: worktree.codebase.agentId,
    folder: worktree.folder,
    gitDirectory: worktree.gitDirectory,
    conflictWorkflow,
  };
  return JSON.stringify(intent);
}

export type MergeSyncPatch = {
  state: string;
  syncStateJson: string;
  lastError: string | null;
  acceptedHeadSha?: string;
};

/** One durable step. Provider coordinators retain their own merge/follow-up locks. */
export async function advanceMergeSync(input: {
  worktreeId: string;
  state: string;
  syncStateJson: string | null;
  updatedAt: Date;
  worktrees: WorktreesService;
  agents: AgentControlService;
  workflows?: Pick<WorkflowsService, "trigger" | "run" | "lifecycle">;
  readiness: () => Promise<MergeSyncReadiness>;
  save: (patch: MergeSyncPatch) => Promise<unknown>;
  merge: (sha: string, targetSha: string) => Promise<unknown>;
}): Promise<boolean> {
  return withMergeSyncLock(input.worktreeId, async () => {
    const intent = readMergeSync(input.syncStateJson);
    let state = input.state;
    const save = async (next: string, error: string | null = null) => {
      state = next;
      await input.save({
        state,
        syncStateJson: JSON.stringify(intent),
        lastError: error,
        acceptedHeadSha: intent.headSha,
      });
    };
    const identityMatches = (ready: MergeSyncReadiness) =>
      ready.sourceOrigin === intent.sourceOrigin &&
      ready.sourceBranch === intent.sourceBranch &&
      ready.targetOrigin === intent.targetOrigin &&
      ready.targetBranch === intent.targetBranch;
    try {
      let ready = await input.readiness();
      if (!identityMatches(ready))
        throw new Error(
          "The source repository, branch or merge target changed. Review it before resuming Auto Merge.",
        );
      if (ready.state === "MERGED") {
        if (ready.headSha !== intent.headSha)
          throw new Error(
            "A different source commit was merged. Review the follow-ups manually.",
          );
        return true;
      }
      if (ready.state !== "OPEN")
        throw new Error("The request closed without merging.");
      if (ready.nativeAutoMerge)
        throw new Error(
          "Native Auto Merge was enabled separately. Cancel it before resuming branch syncing.",
        );
      if (state === "MERGING") {
        if (Date.now() - input.updatedAt.getTime() > 120_000)
          await save(
            "ACTION_REQUIRED",
            "The provider has not confirmed the merge. Review its state before resuming.",
          );
        return false;
      }
      const worktree = await syncWorktree(input.worktreeId);
      if (
        !worktree ||
        worktree.missingAt ||
        worktree.branch !== intent.sourceBranch ||
        worktree.codebaseId !== intent.codebaseId ||
        worktree.codebase.agentId !== intent.agentId ||
        worktree.folder !== intent.folder ||
        worktree.gitDirectory !== intent.gitDirectory ||
        worktree.codebase.repository.canonicalOrigin.toLowerCase() !==
          intent.sourceOrigin.toLowerCase()
      )
        throw new Error(
          "The linked worktree identity changed. Review it before resuming Auto Merge.",
        );
      if (state === "RESOLVING") {
        if (!intent.conflictResolution || !input.workflows)
          throw new Error("The merge conflict workflow run is missing.");
        const blocker =
          ready.blocker ??
          (ready.headSha !== intent.headSha
            ? "The source commit changed during conflict resolution."
            : ready.targetSha !== intent.conflictResolution.targetSha
              ? CONFLICT_TARGET_CHANGED
              : null);
        if (blocker) {
          await input.workflows.lifecycle(
            intent.conflictResolution.runId,
            "CANCEL",
          );
          throw new Error(blocker);
        }
        const run = await input.workflows.run(intent.conflictResolution.runId);
        if (!run)
          throw new Error("The merge conflict workflow run is missing.");
        if (run.status !== "SUCCEEDED") {
          if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(run.status))
            throw new Error(
              `The merge conflict workflow ${run.status.toLowerCase()}.`,
            );
          return false;
        }
        intent.conflictResolution.finalizing = true;
        intent.jobId = null;
        intent.requestId = randomUUID();
        await save("SYNCING");
        return false;
      }
      if (intent.requestId) {
        const phase = intent.conflictResolution?.finalizing
          ? "FINALIZE"
          : "SYNC";
        const prisma = await getPrismaClient();
        let job = intent.jobId
          ? await input.agents.getJob(intent.jobId)
          : await prisma.agentJob.findFirst({
              where: {
                agentId: intent.agentId,
                idempotencyKey: `worktree:auto-sync:${phase.toLowerCase()}:${intent.requestId}:${input.worktreeId}`,
              },
            });
        if (
          phase === "FINALIZE" &&
          (!job || !TERMINAL.has(job.status)) &&
          (ready.blocker ||
            ready.targetSha !== intent.conflictResolution?.targetSha)
        ) {
          if (job) await input.agents.cancelJob(job.id);
          throw new Error(ready.blocker ?? CONFLICT_TARGET_CHANGED);
        }
        if (!job) {
          if (ready.headSha !== intent.headSha)
            throw new Error(
              "The source commit changed. Review it before resuming Auto Merge.",
            );
          job = await input.worktrees.createAutoSyncJob(
            input.worktreeId,
            phase,
            intent.sourceBranch,
            intent.requestId,
            false,
            {
              codebaseId: intent.codebaseId,
              agentId: intent.agentId,
              folder: intent.folder,
              gitDirectory: intent.gitDirectory,
              expectedOrigin: intent.sourceOrigin,
            },
            {
              expectedHeadSha: intent.headSha,
              targetUrl: intent.targetUrl,
              targetBranch: intent.targetBranch,
              targetSha:
                intent.conflictResolution?.targetSha ?? ready.targetSha,
            },
          );
        }
        intent.jobId = job.id;
        if (!TERMINAL.has(job.status)) {
          await save("SYNCING");
          return false;
        }
        if (job.status !== "SUCCEEDED") {
          await save(
            "ACTION_REQUIRED",
            job.error ||
              "Branch sync failed. Review the worktree before resuming.",
          );
          return false;
        }
        const result = JSON.parse(job.resultJson ?? "null") as {
          outcome?: string;
          previousHeadSha?: string;
          syncedHeadSha?: string;
          syncedTargetSha?: string;
        } | null;
        if (result?.outcome === "CONFLICT") {
          if (
            phase === "FINALIZE" ||
            !intent.conflictWorkflow ||
            !input.workflows
          )
            throw new Error(MANUAL_CONFLICT);
          if (ready.blocker) throw new Error(ready.blocker);
          if (
            ready.headSha !== intent.headSha ||
            result.previousHeadSha !== intent.headSha ||
            !result.syncedTargetSha
          )
            throw new Error(
              "The conflicted rebase does not match the reviewed revisions.",
            );
          if (ready.targetSha !== result.syncedTargetSha)
            throw new Error(CONFLICT_TARGET_CHANGED);
          await validateConflictWorkflow(worktree, intent.conflictWorkflow);
          const key = `auto-merge-conflict:${job.id}`;
          const run = await input.workflows.trigger(
            {
              workflowId: intent.conflictWorkflow.id,
              resourceKind: "WORKTREE",
              resourceId: input.worktreeId,
              subjectKey: key,
              choice: intent.conflictWorkflow.choice,
            },
            key,
          );
          if (!run)
            throw new Error("The merge conflict workflow did not start.");
          intent.conflictResolution = {
            runId: run.id,
            targetSha: result.syncedTargetSha,
            finalizing: false,
          };
          await save("RESOLVING");
          return false;
        }
        if (result?.outcome === "UNRESOLVED")
          throw new Error(
            "The merge conflict workflow did not fully resolve the rebase.",
          );
        if (result?.outcome === "PREPARATION_CONFLICT")
          throw new Error(
            "Repository preparations block the rebase. Resolve them before resuming Auto Merge.",
          );
        if (
          !result ||
          !["SYNCED", "NO_CHANGE"].includes(result.outcome ?? "") ||
          result.previousHeadSha !== intent.headSha ||
          !result.syncedHeadSha ||
          !result.syncedTargetSha ||
          (phase === "FINALIZE" &&
            result.syncedTargetSha !== intent.conflictResolution?.targetSha)
        )
          throw new Error(
            "Branch sync did not return a verified source and target revision.",
          );
        ready = await input.readiness();
        if (!identityMatches(ready) || ready.headSha !== result.syncedHeadSha)
          throw new Error(
            "The source commit changed after syncing. Review it before resuming Auto Merge.",
          );
        intent.headSha = result.syncedHeadSha;
        intent.syncedTargetSha = result.syncedTargetSha;
        intent.jobId = null;
        intent.requestId = null;
        delete intent.conflictResolution;
        if (
          phase === "FINALIZE" &&
          ready.targetSha !== intent.syncedTargetSha
        ) {
          await save("ACTION_REQUIRED", CONFLICT_TARGET_CHANGED);
          return false;
        }
        await save("WAITING_CI");
        // The completion handler projects the new checkout status separately.
        // Recheck it on the next pass instead of acting on the pre-job snapshot.
        if (phase === "FINALIZE") return false;
      }
      if (ready.headSha !== intent.headSha)
        throw new Error(
          "The source commit changed. Review it before resuming Auto Merge.",
        );
      if (
        !intent.requestId &&
        worktree.headSha !== intent.headSha &&
        worktree.headSha !== readMergeSync(input.syncStateJson).headSha
      )
        throw new Error(
          "The local source commit changed. Review it before resuming Auto Merge.",
        );
      if (
        !intent.requestId &&
        (worktree.hasConflicts ||
          worktree.rebaseInProgress ||
          worktree.hasStagedChanges ||
          worktree.hasUnstagedChanges)
      )
        throw new Error(
          "Resolve conflicts and stash or commit worktree changes before resuming Auto Merge.",
        );
      if (ready.blocker) throw new Error(ready.blocker);
      if (ready.hasConflicts && !intent.conflictWorkflow)
        throw new Error(MANUAL_CONFLICT);
      if (intent.syncedTargetSha !== ready.targetSha) {
        intent.requestId = randomUUID();
        await save("SYNCING");
        return false;
      }
      if (!ready.ciPassed) {
        await save("WAITING_CI");
        return false;
      }
      if (!ready.canMerge) {
        await save("WAITING_REQUIREMENTS");
        return false;
      }
      // Read again immediately before submission; green checks on an older head never authorize a merge.
      ready = await input.readiness();
      if (!identityMatches(ready) || ready.headSha !== intent.headSha)
        throw new Error(
          "The source commit or merge target changed before merging.",
        );
      if (ready.targetSha !== intent.syncedTargetSha) {
        intent.requestId = randomUUID();
        await save("SYNCING");
        return false;
      }
      if (ready.blocker) throw new Error(ready.blocker);
      if (!ready.ciPassed || !ready.canMerge || ready.nativeAutoMerge) {
        await save("WAITING_REQUIREMENTS");
        return false;
      }
      await save("MERGING");
      await input.merge(intent.headSha, intent.syncedTargetSha!);
      const merged = await input.readiness();
      return (
        merged.state === "MERGED" &&
        identityMatches(merged) &&
        merged.headSha === intent.headSha
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = isTransientMergeError(error);
      await save(
        error instanceof MergeSyncNotSubmittedError
          ? "WAITING_REQUIREMENTS"
          : state === "MERGING"
            ? "MERGING"
            : transient
              ? state
              : "ACTION_REQUIRED",
        message,
      );
      return false;
    }
  });
}

export async function cancelMergeSync(
  value: string | null,
  agents: AgentControlService,
  workflows?: Pick<WorkflowsService, "lifecycle">,
) {
  const intent = readMergeSync(value);
  const job = intent.jobId
    ? await agents.getJob(intent.jobId)
    : intent.requestId
      ? await (
          await getPrismaClient()
        ).agentJob.findFirst({
          where: {
            agentId: intent.agentId,
            idempotencyKey: { contains: intent.requestId },
            kind: WORKTREE_AUTO_SYNC_JOB_KIND,
          },
        })
      : null;
  if (job && !TERMINAL.has(job.status)) await agents.cancelJob(job.id);
  if (intent.conflictResolution && !intent.conflictResolution.finalizing)
    await workflows?.lifecycle(intent.conflictResolution.runId, "CANCEL");
}
