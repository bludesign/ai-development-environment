import type { BuildRecord } from "./types";

export function buildStatusVariant(status: BuildRecord["status"]) {
  return status === "FAILED"
    ? ("destructive" as const)
    : status === "SUCCEEDED"
      ? ("success" as const)
      : ("secondary" as const);
}

export function buildSnapshotName(build: BuildRecord): {
  repository: string;
  worktree: string;
} {
  const repository = build.snapshot.repository as { name?: string } | undefined;
  const worktree = build.snapshot.worktree as
    { branch?: string | null; folder?: string } | undefined;
  return {
    repository: repository?.name ?? "—",
    worktree: worktree?.branch ?? worktree?.folder ?? "—",
  };
}

export function buildDuration(
  build: BuildRecord,
  now: number | null = Date.now(),
): string {
  const durationMs =
    build.durationMs ??
    (build.startedAt &&
    now !== null &&
    ["QUEUED", "PREPARING", "RUNNING"].includes(build.status)
      ? now - Date.parse(build.startedAt)
      : null);
  if (durationMs === null || !Number.isFinite(durationMs)) return "—";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  return `${seconds}s`;
}
