import {
  githubJobResourceId,
  githubPipelineResourceId,
} from "@/lib/workflows/resources";
import type { GitHubPipelineState } from "@/services/github/types";
import type { WorkflowMenuResource } from "@/components/workflows/workflow-resource-actions";

type PullRequestContext = {
  id?: string | null;
  number: number;
  title?: string | null;
  url: string;
  jiraKey?: string | null;
};

type WorktreeContext = {
  id: string;
  path?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  headSha?: string | null;
};

export type GitHubPipelineResourceInput = {
  id: string;
  workflowRunId?: string | null;
  workflowId?: string | null;
  codebaseRepositoryId: string | null;
  repositoryGithubId: string;
  repositoryNameWithOwner?: string | null;
  repositoryUrl?: string | null;
  name: string;
  displayTitle?: string | null;
  status: GitHubPipelineState;
  url: string | null;
  checkSuiteId?: string | null;
  runNumber?: number | null;
  runAttempt?: number | null;
  headBranch?: string | null;
  headSha?: string | null;
  pullRequests?: Array<{ number: number; url: string }>;
  jiraKey?: string | null;
  worktreeId?: string | null;
};

export function githubPipelineWorkflowResource(
  pipeline: GitHubPipelineResourceInput,
  context: {
    pullRequest?: PullRequestContext | null;
    worktree?: WorktreeContext | null;
    ticketKey?: string | null;
  } = {},
): WorkflowMenuResource {
  const repositoryKey =
    pipeline.codebaseRepositoryId ?? `github-${pipeline.repositoryGithubId}`;
  const pullRequests = pipeline.pullRequests ?? [];
  const worktree =
    context.worktree ??
    (pipeline.worktreeId ? { id: pipeline.worktreeId } : null);
  const primaryPullRequest =
    context.pullRequest ??
    (!worktree && pullRequests[0]
      ? {
          number: pullRequests[0].number,
          url: pullRequests[0].url,
        }
      : null);
  const ticketKey =
    context.ticketKey ??
    primaryPullRequest?.jiraKey ??
    pipeline.jiraKey ??
    null;
  return {
    kind: "GITHUB_PIPELINE",
    id: githubPipelineResourceId(
      repositoryKey,
      pipeline.workflowRunId,
      pipeline.id,
    ),
    repositoryId: pipeline.codebaseRepositoryId,
    sessionData: {
      repo: {
        id: pipeline.codebaseRepositoryId,
        githubId: pipeline.repositoryGithubId,
        displayOrigin: pipeline.repositoryNameWithOwner,
        url: pipeline.repositoryUrl,
      },
      pipeline: {
        id: pipeline.id,
        runId: pipeline.workflowRunId ?? pipeline.id,
        workflowId: pipeline.workflowId,
        name: pipeline.name,
        displayTitle: pipeline.displayTitle,
        status: pipeline.status,
        url: pipeline.url,
        checkSuiteId: pipeline.checkSuiteId,
        runNumber: pipeline.runNumber,
        runAttempt: pipeline.runAttempt,
        headBranch: pipeline.headBranch,
        headSha: pipeline.headSha,
        pullRequests,
        jiraKey: pipeline.jiraKey,
      },
      ...(primaryPullRequest ? { pr: primaryPullRequest } : {}),
      ...(worktree ? { worktree } : {}),
      ...(ticketKey ? { ticket: { key: ticketKey } } : {}),
    },
  };
}

export function githubJobWorkflowResource(
  pipelineResource: WorkflowMenuResource,
  job: {
    id: string;
    name: string;
    status: GitHubPipelineState;
    url: string | null;
    runAttempt?: number | null;
  },
  codebaseRepositoryId: string | null,
  repositoryGithubId: string,
): WorkflowMenuResource {
  const repositoryKey = codebaseRepositoryId ?? `github-${repositoryGithubId}`;
  return {
    kind: "GITHUB_JOB",
    id: githubJobResourceId(repositoryKey, job.id),
    repositoryId: codebaseRepositoryId,
    sessionData: {
      ...pipelineResource.sessionData,
      job: {
        id: job.id,
        name: job.name,
        status: job.status,
        url: job.url,
        runAttempt: job.runAttempt,
      },
    },
  };
}
