import { aggregatePipelineStatus } from "@/services/github/pipeline-status";
import type {
  GitHubPipelineStatusSnapshotView,
  GitHubPipelineView,
  GitHubPipelineStatus,
} from "@/services/github/types";
import type { GitLabPipelineView } from "@/services/gitlab/types";

export function isFailingGitHubStatus(status: GitHubPipelineStatus) {
  return status === "FAILURE" || status === "ERROR";
}

export function failingGitHubPipelines(
  snapshot:
    | (Pick<
        GitHubPipelineStatusSnapshotView,
        "pipelineStatus" | "headSha" | "repositoryGithubId"
      > & {
        pipelines: Array<
          Pick<GitHubPipelineView, "id" | "status" | "url" | "workflowRunId">
        >;
      })
    | null,
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

type GitLabWorktreeTarget = {
  branch?: string | null;
  headSha?: string | null;
  sourceControlRequest?: {
    provider: string;
    projectId?: string | null;
    number: number;
    headRefName?: string | null;
  } | null;
};

function gitLabPipelineRefForWorktree(
  { ref, projectId, mergeRequests }: GitLabPipelineView,
  { branch, sourceControlRequest }: GitLabWorktreeTarget,
): string | null {
  const branchRef = ref.replace(/^refs\/heads\//, "");
  if (!branch) return branchRef;
  if (ref.startsWith("refs/tags/")) return null;

  const mergeRequestRef = ref.match(
    /^refs\/merge-requests\/(\d+)\/(?:head|merge)$/,
  );
  if (!mergeRequestRef) return branchRef === branch ? branchRef : null;

  const iid = Number(mergeRequestRef[1]);
  // Saved pipelines carry only the raw ref. The linked request identifies it
  // until pipeline enrichment provides its own merge request associations.
  const linkedRequestMatches =
    sourceControlRequest?.provider === "GITLAB" &&
    sourceControlRequest.projectId === projectId &&
    sourceControlRequest.number === iid &&
    sourceControlRequest.headRefName === branch;
  const associatedRequestMatches = mergeRequests.some(
    (request) =>
      request.projectId === projectId &&
      request.iid === iid &&
      request.sourceBranch === branch,
  );
  return linkedRequestMatches || associatedRequestMatches ? ref : null;
}

export function latestGitLabPipelines(
  pipelines: GitLabPipelineView[],
  worktree: GitLabWorktreeTarget,
) {
  const latest = new Map<string, GitLabPipelineView>();
  for (const pipeline of pipelines) {
    if (pipeline.sha !== worktree.headSha) continue;
    const ref = gitLabPipelineRefForWorktree(pipeline, worktree);
    if (ref === null) continue;
    const key = `${pipeline.projectId}\0${pipeline.source}\0${ref}`;
    const prior = latest.get(key);
    if (!prior || BigInt(pipeline.id) > BigInt(prior.id))
      latest.set(key, pipeline);
  }
  return [...latest.values()];
}

export function failingGitLabPipelines(
  pipelines: GitLabPipelineView[],
  worktree: GitLabWorktreeTarget,
) {
  return latestGitLabPipelines(pipelines, worktree)
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
