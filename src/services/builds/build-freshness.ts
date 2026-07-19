const ACTIVE_BUILD_STATUSES = new Set(["QUEUED", "PREPARING", "RUNNING"]);

type FreshnessBuild = {
  status: string;
  snapshotJson: string;
  finishedAt?: Date | null;
  worktree?: {
    headSha: string | null;
    codeStateHash: string | null;
    hasStagedChanges: boolean;
    hasUnstagedChanges: boolean;
    lastCheckedAt?: Date | null;
    _count?: { builds: number };
  } | null;
};

export function buildOutOfDate(build: FreshnessBuild): boolean {
  if (
    ACTIVE_BUILD_STATUSES.has(build.status) ||
    !build.worktree ||
    (build.worktree._count?.builds ?? 0) > 0
  ) {
    return false;
  }
  if (
    build.finishedAt &&
    (!build.worktree.lastCheckedAt ||
      build.worktree.lastCheckedAt < build.finishedAt)
  ) {
    return false;
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(build.snapshotJson);
  } catch {
    return false;
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return false;
  }
  const worktreeSnapshot = (snapshot as Record<string, unknown>).worktree;
  if (
    !worktreeSnapshot ||
    typeof worktreeSnapshot !== "object" ||
    Array.isArray(worktreeSnapshot)
  ) {
    return false;
  }
  const captured = worktreeSnapshot as Record<string, unknown>;
  if (
    typeof captured.codeStateHash === "string" &&
    build.worktree.codeStateHash
  ) {
    return captured.codeStateHash !== build.worktree.codeStateHash;
  }
  if (
    typeof captured.headSha === "string" &&
    build.worktree.headSha !== captured.headSha
  ) {
    return true;
  }
  if (typeof captured.hasStagedChanges === "boolean") {
    if (captured.hasStagedChanges !== build.worktree.hasStagedChanges) {
      return true;
    }
  } else if (build.worktree.hasStagedChanges) {
    return true;
  }
  if (typeof captured.hasUnstagedChanges === "boolean") {
    return captured.hasUnstagedChanges !== build.worktree.hasUnstagedChanges;
  }
  return build.worktree.hasUnstagedChanges;
}
