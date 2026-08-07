import type { GitLabPipelineStatus } from "@/services/gitlab";

export function gitLabPipelineStatusClass(status: GitLabPipelineStatus) {
  if (status === "SUCCESS") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (status === "FAILED" || status === "CANCELED") {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (
    status === "CREATED" ||
    status === "WAITING_FOR_RESOURCE" ||
    status === "PREPARING" ||
    status === "PENDING" ||
    status === "RUNNING" ||
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
  if (statuses.some((status) => status === "RUNNING")) return "RUNNING";
  if (statuses.some((status) => status === "PENDING")) return "PENDING";
  return statuses[0] ?? "UNKNOWN";
}
