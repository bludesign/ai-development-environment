import type { GitLabPipelineStatus } from "./types";

export const ACTIVE_GITLAB_PIPELINE_STATUSES = [
  "CREATED",
  "WAITING_FOR_RESOURCE",
  "WAITING_FOR_CALLBACK",
  "PREPARING",
  "PENDING",
  "RUNNING",
  "CANCELING",
] as const satisfies readonly GitLabPipelineStatus[];

const activeStatuses = new Set<GitLabPipelineStatus>(
  ACTIVE_GITLAB_PIPELINE_STATUSES,
);

export function isActiveGitLabPipeline(status: GitLabPipelineStatus) {
  return activeStatuses.has(status);
}
