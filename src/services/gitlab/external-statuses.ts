import type {
  GitLabJobView,
  GitLabPipelineView,
  GitLabUserView,
} from "./types";
import { activeStates, externalRetryStates } from "./external-pipeline-actions";
export type GitLabCommitStatus = {
  id: number;
  pipeline_id?: number;
  name: string;
  status: string;
  ref?: string;
  target_url?: string | null;
  author?: {
    id: number;
    username: string;
    name: string;
    avatar_url?: string | null;
    web_url?: string;
  };
  created_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  allow_failure?: boolean;
};
export function combineExternalStatuses(
  pipeline: GitLabPipelineView,
  native: GitLabJobView[],
  bridges: GitLabJobView[],
  statuses: GitLabCommitStatus[],
  capabilities: { retry: boolean; cancel: boolean },
  currentIds?: Set<string>,
): GitLabJobView[] {
  const included = new Map([...native, ...bridges].map((job) => [job.id, job]));
  const external = [
    ...new Map(
      statuses
        .filter(
          (status) =>
            String(status.pipeline_id) === pipeline.id &&
            !included.has(String(status.id)),
        )
        .map((status) => [String(status.id), status]),
    ).values(),
  ];
  const latest = new Map<string, GitLabCommitStatus>();
  const identity = (status: GitLabCommitStatus) =>
    JSON.stringify([
      status.name,
      status.author?.id ?? null,
      status.ref ?? pipeline.ref,
    ]);
  for (const status of external) {
    const current = latest.get(identity(status));
    if (!current || Number(status.id) > Number(current.id))
      latest.set(identity(status), status);
  }
  for (const status of external) {
    const state = status.status.toUpperCase() as GitLabJobView["status"];
    const known = new Set([
      "CREATED",
      "WAITING_FOR_RESOURCE",
      "PREPARING",
      "PENDING",
      "RUNNING",
      "SUCCESS",
      "FAILED",
      "CANCELED",
      "CANCELING",
      "WAITING_FOR_CALLBACK",
      "SKIPPED",
      "MANUAL",
      "SCHEDULED",
    ]);
    const author: GitLabUserView | null = status.author
      ? {
          id: String(status.author.id),
          username: status.author.username,
          name: status.author.name,
          avatarUrl: status.author.avatar_url ?? null,
          webUrl: status.author.web_url ?? "",
        }
      : null;
    const retried = currentIds
      ? !currentIds.has(String(status.id))
      : latest.get(identity(status))?.id !== status.id;
    included.set(String(status.id), {
      id: String(status.id),
      pipelineId: pipeline.id,
      name: status.name,
      stage: "external",
      status: known.has(state) ? state : "UNKNOWN",
      ref: status.ref ?? pipeline.ref,
      webUrl: status.target_url || pipeline.webUrl,
      targetUrl: status.target_url || null,
      author,
      kind: "EXTERNAL",
      allowFailure: status.allow_failure ?? false,
      createdAt: status.created_at ?? null,
      startedAt: status.started_at ?? null,
      finishedAt: status.finished_at ?? null,
      duration: null,
      queuedDuration: null,
      retried,
      canRetry:
        !retried && capabilities.retry && externalRetryStates.has(state),
      canCancel: !retried && capabilities.cancel && activeStates.has(state),
    });
  }
  return [...included.values()];
}
