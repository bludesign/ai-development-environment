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

export function relativeBuildAge(
  value: string,
  locale: string,
  now: number | null = Date.now(),
) {
  if (now === null) return "—";
  const seconds = Math.round((Date.parse(value) - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
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
