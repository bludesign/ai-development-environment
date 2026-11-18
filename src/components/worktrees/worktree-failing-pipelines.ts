import { aggregatePipelineStatus } from "@/services/github/pipeline-status";
import type {
  GitHubPipelineStatusSnapshotView,
  GitHubPipelineStatus,
} from "@/services/github/types";
import type { GitLabPipelineView } from "@/services/gitlab/types";

export function isFailingGitHubStatus(status: GitHubPipelineStatus) {
  return status === "FAILURE" || status === "ERROR";
}

export function failingGitHubPipelines(
  snapshot: GitHubPipelineStatusSnapshotView | null,
) {
  if (!snapshot || !isFailingGitHubStatus(snapshot.pipelineStatus)) return [];
  return snapshot.pipelines
    .filter(({ status }) =>
      isFailingGitHubStatus(aggregatePipelineStatus([status])),
    )
    .map(({ id, status, url, workflowRunId }) => ({
      provider: "GITHUB" as const,
      id,
      status,
      url,
      headSha: snapshot.headSha,
      repositoryGithubId: snapshot.repositoryGithubId,
      ...(workflowRunId ? { workflowRunId } : {}),
    }));
}

export function failingGitLabPipelines(
  pipelines: GitLabPipelineView[],
  headSha: string | null,
) {
  const latest = new Map<string, GitLabPipelineView>();
  for (const pipeline of pipelines) {
    if (pipeline.sha !== headSha) continue;
    const key = `${pipeline.projectId}:${pipeline.source}`;
    const prior = latest.get(key);
    if (!prior || BigInt(pipeline.id) > BigInt(prior.id))
      latest.set(key, pipeline);
  }
  return [...latest.values()]
    .filter(({ status }) => status === "FAILED")
    .map(({ id, status, webUrl, sha, projectId }) => ({
      provider: "GITLAB" as const,
      id,
      status,
      url: webUrl || null,
      headSha: sha,
      projectId,
    }));
}
