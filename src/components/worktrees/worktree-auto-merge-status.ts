import type { Worktree, WorktreeAutoMerge } from "./types";

export type WorktreeAutoMergeStatus =
  "inactive" | "active" | "paused" | "completed";

const ACTIVE_MANAGED_STATES = new Set([
  "SYNCING",
  "RESOLVING",
  "WAITING_CI",
  "WAITING_REQUIREMENTS",
  "MERGING",
  "POST_MERGE",
]);

export function currentWorktreeAutoMerge(
  worktree: Worktree,
): WorktreeAutoMerge | null {
  const rule = worktree.autoMerge;
  const pullRequest = worktree.pullRequest;
  return rule &&
    rule.worktreeId === worktree.id &&
    rule.branch === worktree.branch &&
    (!pullRequest ||
      (pullRequest.headRefName === worktree.branch &&
        rule.pullRequestNumber === pullRequest.number &&
        rule.repositoryNameWithOwner.toLowerCase() ===
          pullRequest.repositoryNameWithOwner.toLowerCase()))
    ? rule
    : null;
}

export function nativeWorktreeAutoMergeEnabled(worktree: Worktree): boolean {
  const request = worktree.sourceControlRequest;
  if (request?.provider === "GITLAB") {
    return Boolean(
      request.headRefName === worktree.branch &&
      request.state === "OPENED" &&
      request.mergeWhenPipelineSucceeds,
    );
  }
  const pullRequest = worktree.pullRequest;
  return Boolean(
    pullRequest?.headRefName === worktree.branch &&
    pullRequest?.state === "OPEN" &&
    pullRequest.autoMergeEnabled,
  );
}

/** A provider's enabled automation takes precedence over its merge readiness. */
export function worktreeAutoMergeStatus(
  worktree: Worktree,
): WorktreeAutoMergeStatus {
  const request = worktree.sourceControlRequest;
  if (request?.provider === "GITLAB") {
    const operation = request.mergeOperation;
    const currentOperation =
      request.headRefName === worktree.branch &&
      operation?.worktreeId === worktree.id &&
      operation.autoMerge
        ? operation
        : null;
    if (currentOperation?.state === "ACTION_REQUIRED") return "paused";
    if (currentOperation?.state === "COMPLETED" && request.state === "MERGED")
      return "completed";
    if (
      nativeWorktreeAutoMergeEnabled(worktree) ||
      (currentOperation &&
        (currentOperation.state === "PREPARING" ||
          currentOperation.state === "WAITING" ||
          ACTIVE_MANAGED_STATES.has(currentOperation.state)))
    )
      return "active";
    return "inactive";
  }

  const rule = currentWorktreeAutoMerge(worktree);
  if (rule?.state === "ACTION_REQUIRED") return "paused";
  if (
    rule?.state === "COMPLETED" &&
    (!worktree.pullRequest || worktree.pullRequest.state === "MERGED")
  )
    return "completed";
  if (
    nativeWorktreeAutoMergeEnabled(worktree) ||
    (rule && (rule.state === "ACTIVE" || ACTIVE_MANAGED_STATES.has(rule.state)))
  )
    return "active";
  return "inactive";
}
