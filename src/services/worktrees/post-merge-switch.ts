import { randomUUID } from "node:crypto";
import { WORKTREE_POST_MERGE_SWITCH_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import { getPrismaClient } from "@/data/prisma-client";
import type { AgentControlService } from "@/services/agent-control";
import type { WorktreesService } from "./worktrees.service";

export type PostMergeSwitchStatus = {
  branch: string;
  state: "PENDING" | "UPDATING" | "COMPLETED" | "ACTION_REQUIRED";
  lastError: string | null;
};

export type PostMergeSwitchOptions = {
  canSwitchToDefaultBranch: boolean;
  defaultSwitchToDefaultBranch: boolean;
  switchToDefaultBranchName: string | null;
  switchToDefaultBranchUnavailableReason: string | null;
};

type SwitchPlan = PostMergeSwitchStatus & {
  manualMerge?: boolean;
  worktreeId: string;
  codebaseId: string;
  folder: string;
  gitDirectory: string;
  expectedOrigin: string;
  expectedBranch: string;
  expectedHeadSha: string;
  mergeCommitSha: string | null;
  confirmedAt: string | null;
  requestId: string;
  jobId: string | null;
  completedAt: string | null;
};

function readPlan(json: string): SwitchPlan {
  return JSON.parse(json) as SwitchPlan;
}

export function postMergeSwitchRequiresConfirmation(
  json: string | null | undefined,
): boolean {
  return Boolean(json && readPlan(json).manualMerge);
}

export function postMergeSwitchView(
  json: string | null | undefined,
): PostMergeSwitchStatus | null {
  if (!json) return null;
  const { branch, state, lastError } = readPlan(json);
  return { branch, state, lastError };
}

export async function getPostMergeSwitchOptions(
  worktreeId: string | null | undefined,
  targetOrigin: string,
  targetBranch: string,
  savedJson?: string | null,
): Promise<PostMergeSwitchOptions> {
  const empty: PostMergeSwitchOptions = {
    canSwitchToDefaultBranch: false,
    defaultSwitchToDefaultBranch: false,
    switchToDefaultBranchName: null,
    switchToDefaultBranchUnavailableReason: null,
  };
  if (!worktreeId) return empty;
  const worktree = await (
    await getPrismaClient()
  ).worktree.findUnique({
    where: { id: worktreeId },
    include: { codebase: { include: { repository: true, agent: true } } },
  });
  if (!worktree?.primary) return empty;
  const branch = worktree.codebase.defaultBranch;
  let reason: string | null = null;
  let capabilities: unknown = [];
  try {
    capabilities = JSON.parse(
      worktree.codebase.agent?.capabilitiesJson ?? "[]",
    );
  } catch {
    // An unreadable capability inventory cannot authorize an unattended switch.
  }
  if (!branch) reason = "Fetch the repository to discover its default branch.";
  else if (worktree.missingAt || worktree.availability !== "AVAILABLE")
    reason = "The primary checkout is unavailable.";
  else if (
    worktree.codebase.repository.canonicalOrigin.toLowerCase() !==
    targetOrigin.toLowerCase()
  )
    reason = "The primary checkout must belong to the merge target repository.";
  else if (branch !== targetBranch)
    reason = "The request must target the repository's default branch.";
  else if (
    !Array.isArray(capabilities) ||
    !capabilities.includes(WORKTREE_POST_MERGE_SWITCH_JOB_KIND)
  )
    reason = "Update the agent to switch the primary checkout after merging.";
  return {
    canSwitchToDefaultBranch: !reason,
    defaultSwitchToDefaultBranch: !reason && savedJson !== null,
    switchToDefaultBranchName: branch,
    switchToDefaultBranchUnavailableReason: reason,
  };
}

export async function preparePostMergeSwitch(
  worktreeId: string | null | undefined,
  target: {
    origin: string;
    branch: string;
    sourceBranch: string;
    sourceSha: string;
  },
  enabled: boolean,
  manualMerge = false,
): Promise<string | null> {
  if (!enabled) return null;
  const options = await getPostMergeSwitchOptions(
    worktreeId,
    target.origin,
    target.branch,
  );
  if (!options.canSwitchToDefaultBranch)
    throw new Error(
      options.switchToDefaultBranchUnavailableReason ??
        "A matching primary checkout is required to switch after merging.",
    );
  const worktree = await (
    await getPrismaClient()
  ).worktree.findUniqueOrThrow({
    where: { id: worktreeId! },
  });
  if (worktree.branch !== target.sourceBranch || !target.sourceSha)
    throw new Error(
      "The primary checkout source changed. Refresh the merge options.",
    );
  const plan: SwitchPlan = {
    manualMerge,
    worktreeId: worktree.id,
    codebaseId: worktree.codebaseId,
    folder: worktree.folder,
    gitDirectory: worktree.gitDirectory,
    expectedOrigin: target.origin,
    expectedBranch: target.sourceBranch,
    expectedHeadSha: target.sourceSha,
    branch: target.branch,
    mergeCommitSha: null,
    confirmedAt: null,
    requestId: randomUUID(),
    jobId: null,
    completedAt: null,
    state: "PENDING",
    lastError: null,
  };
  return JSON.stringify(plan);
}

/** Only managed sync's accepted revision may replace the reviewed source. */
export function updatePostMergeSwitchSource(
  json: string | null | undefined,
  sourceSha: string,
): string | null {
  if (!json) return null;
  const plan = readPlan(json);
  if (!plan.jobId && !plan.completedAt && !plan.confirmedAt)
    plan.expectedHeadSha = sourceSha;
  return JSON.stringify(plan);
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);

export async function advancePostMergeSwitch(
  json: string,
  confirmed: {
    origin: string;
    branch: string;
    sourceBranch: string;
    sourceSha: string;
    mergeCommitSha: string | null;
  },
  worktrees: WorktreesService,
  agents: AgentControlService,
  save: (json: string) => Promise<unknown>,
): Promise<boolean> {
  const plan = readPlan(json);
  if (plan.completedAt) return true;
  try {
    if (
      confirmed.origin.toLowerCase() !== plan.expectedOrigin.toLowerCase() ||
      confirmed.branch !== plan.branch ||
      confirmed.sourceBranch !== plan.expectedBranch ||
      confirmed.sourceSha !== plan.expectedHeadSha
    )
      throw new Error(
        "The merged source or target differs from the reviewed checkout switch.",
      );
    plan.confirmedAt ??= new Date().toISOString();
    if (!plan.mergeCommitSha && confirmed.mergeCommitSha)
      plan.mergeCommitSha = confirmed.mergeCommitSha;
    if (!plan.mergeCommitSha) {
      if (Date.now() - Date.parse(plan.confirmedAt) >= 120_000)
        throw new Error(
          "The request merged, but its resulting commit is not available yet. Retry switching after the provider finishes updating.",
        );
      await save(JSON.stringify(plan));
      return false;
    }
    const current = await (
      await getPrismaClient()
    ).worktree.findUnique({
      where: { id: plan.worktreeId },
      include: { codebase: { include: { repository: true } } },
    });
    if (
      !current ||
      !current.primary ||
      current.missingAt ||
      current.codebaseId !== plan.codebaseId ||
      current.folder !== plan.folder ||
      current.gitDirectory !== plan.gitDirectory ||
      current.codebase.repository.canonicalOrigin.toLowerCase() !==
        plan.expectedOrigin.toLowerCase() ||
      current.codebase.defaultBranch !== plan.branch
    )
      throw new Error(
        "The primary checkout or its default branch changed after merging.",
      );
    // The stable request ID recovers a job created just before the server stopped.
    if (!plan.jobId) {
      // Freeze merge evidence before dispatch; recovery must not depend on the
      // provider returning this metadata again after the agent already switched.
      plan.state = "UPDATING";
      plan.lastError = null;
      await save(JSON.stringify(plan));
      const job = await worktrees.postMergeSwitch({
        worktreeId: plan.worktreeId,
        codebaseId: plan.codebaseId,
        folder: plan.folder,
        gitDirectory: plan.gitDirectory,
        expectedOrigin: plan.expectedOrigin,
        expectedBranch: plan.expectedBranch,
        expectedHeadSha: plan.expectedHeadSha,
        branch: plan.branch,
        mergeCommitSha: plan.mergeCommitSha,
        requestId: plan.requestId,
      });
      plan.jobId = job.id;
      plan.state = "UPDATING";
      plan.lastError = null;
      await save(JSON.stringify(plan));
    }
    const job = await agents.getJob(plan.jobId);
    if (!job || !TERMINAL.has(job.status)) return false;
    if (job.status !== "SUCCEEDED")
      throw new Error(
        job.error || `Switching to ${plan.branch} ${job.status.toLowerCase()}.`,
      );
    plan.completedAt = new Date().toISOString();
    plan.state = "COMPLETED";
    plan.lastError = null;
    await save(JSON.stringify(plan));
    return true;
  } catch (error) {
    // Busy scheduling is retriable without changing the recorded intent.
    if (
      error instanceof Error &&
      ["CodebaseBusyError", "ResourceBusyError"].includes(error.name)
    )
      return false;
    plan.state = "ACTION_REQUIRED";
    plan.lastError = error instanceof Error ? error.message : String(error);
    await save(JSON.stringify(plan));
    throw error;
  }
}

export async function retryPostMergeSwitch(
  json: string | null | undefined,
  agents: AgentControlService,
): Promise<string | null> {
  if (!json) return null;
  const plan = readPlan(json);
  if (plan.completedAt) return json;
  if (plan.jobId) {
    const job = await agents.getJob(plan.jobId);
    if (job && TERMINAL.has(job.status) && job.status !== "SUCCEEDED") {
      plan.jobId = null;
      plan.requestId = randomUUID();
    }
  }
  plan.confirmedAt = null;
  plan.state = plan.jobId ? "UPDATING" : "PENDING";
  plan.lastError = null;
  return JSON.stringify(plan);
}
