type CheckpointChanges = {
  kind: string;
  diffPatch: string | null;
  diffSummary: string | null;
};

const WORKTREE_SECTION = "Worktree changes that will be undone:\n\n";
const INDEX_SECTION = "Index changes that will be undone:\n\n";

/**
 * Older FINAL checkpoints stored a rollback preview containing both worktree
 * and index diffs. Only the worktree section describes net file content changes.
 * Their summaries compared against HEAD, so they cannot describe this baseline.
 */
export function normalizeCheckpointChanges(
  checkpoint: CheckpointChanges,
): Pick<CheckpointChanges, "diffPatch" | "diffSummary"> {
  const { diffPatch, diffSummary } = checkpoint;
  if (checkpoint.kind !== "FINAL") {
    return { diffPatch, diffSummary };
  }
  if (!diffPatch) {
    const legacySummary =
      diffSummary?.startsWith("Staged:\n") ||
      diffSummary?.startsWith("Working tree:\n");
    return { diffPatch, diffSummary: legacySummary ? null : diffSummary };
  }
  if (diffPatch.startsWith(INDEX_SECTION)) {
    return { diffPatch: null, diffSummary: null };
  }
  if (!diffPatch.startsWith(WORKTREE_SECTION)) {
    return { diffPatch, diffSummary };
  }
  const worktree = diffPatch.slice(WORKTREE_SECTION.length);
  const indexStart = worktree.indexOf(`\n\n${INDEX_SECTION}`);
  const patch = (
    indexStart === -1 ? worktree : worktree.slice(0, indexStart)
  ).trim();
  return { diffPatch: patch || null, diffSummary: null };
}

/** Checkpoints arrive in ascending creation order; an empty FINAL is authoritative. */
export function latestFinalCheckpoint<T extends { kind: string }>(
  checkpoints: readonly T[],
): T | null {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index]!;
    if (checkpoint.kind === "FINAL") return checkpoint;
  }
  return null;
}
