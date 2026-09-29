import type { GitLabPipelineStatus } from "@/services/gitlab";

// Provider filter values; UNKNOWN is only a local presentation fallback.
export const gitLabPipelineStatuses = [
  "CREATED",
  "WAITING_FOR_RESOURCE",
  "WAITING_FOR_CALLBACK",
  "PREPARING",
  "PENDING",
  "RUNNING",
  "CANCELING",
  "SUCCESS",
  "FAILED",
  "CANCELED",
  "SKIPPED",
  "MANUAL",
  "SCHEDULED",
] as const;

export const gitLabPipelineSources = [
  "push",
  "web",
  "trigger",
  "schedule",
  "api",
  "external",
  "pipeline",
  "chat",
  "webide",
  "merge_request_event",
  "external_pull_request_event",
  "parent_pipeline",
  "ondemand_dast_scan",
  "ondemand_dast_validation",
  "security_orchestration_policy",
] as const;

export function isActiveGitLabPipeline(status: GitLabPipelineStatus) {
  return [
    "CREATED",
    "WAITING_FOR_RESOURCE",
    "WAITING_FOR_CALLBACK",
    "PREPARING",
    "PENDING",
    "RUNNING",
    "CANCELING",
  ].includes(status);
}

export function canRetryGitLabPipeline(status: GitLabPipelineStatus) {
  return status === "FAILED" || status === "CANCELED";
}

export function canCancelGitLabPipeline(status: GitLabPipelineStatus) {
  return isActiveGitLabPipeline(status) && status !== "CANCELING";
}

type GitLabTimedItem = {
  duration: number | null;
  startedAt: string | null;
  status: GitLabPipelineStatus;
};

export function canRetryGitLabJob(status: GitLabPipelineStatus) {
  return status === "SUCCESS" || status === "FAILED" || status === "CANCELED";
}

export function gitLabDuration(item: GitLabTimedItem, now = Date.now()) {
  let totalSeconds = item.duration;
  if (isActiveGitLabPipeline(item.status) && item.startedAt) {
    const startedAt = Date.parse(item.startedAt);
    if (Number.isFinite(startedAt)) {
      totalSeconds = Math.max(
        totalSeconds ?? 0,
        Math.floor((now - startedAt) / 1000),
      );
    }
  }
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return "—";
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  if (minutes > 0) return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ""}`;
  return `${remainder}s`;
}

export function gitLabPipelineStatusClass(status: GitLabPipelineStatus) {
  if (status === "SUCCESS") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "FAILED" || status === "CANCELED") {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (
    isActiveGitLabPipeline(status) ||
    status === "MANUAL" ||
    status === "SCHEDULED"
  ) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
}

export function aggregateGitLabPipelineStatus(
  statuses: GitLabPipelineStatus[],
): GitLabPipelineStatus {
  if (statuses.some((status) => status === "FAILED")) return "FAILED";
  if (statuses.some((status) => status === "CANCELED")) return "CANCELED";
  const active = statuses.find(isActiveGitLabPipeline);
  if (active) return active;
  if (statuses.includes("MANUAL")) return "MANUAL";
  if (statuses.includes("SCHEDULED")) return "SCHEDULED";
  if (statuses.includes("UNKNOWN")) return "UNKNOWN";
  if (statuses.includes("SUCCESS")) return "SUCCESS";
  return statuses[0] ?? "UNKNOWN";
}
