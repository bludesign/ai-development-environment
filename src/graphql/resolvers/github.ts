import type { GraphQLResolveInfo, SelectionSetNode } from "graphql";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  GitHubAuditContext,
  GitHubMergeMethod,
  GitHubPullRequestScope,
  GitHubPullRequestStateFilter,
  GitHubService,
} from "@/services/github";
import { normalizeGitHubRepositoryName } from "@/services/github";
import type { WorktreesService } from "@/services/worktrees";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

function auditContext(context: GraphQLContext): GitHubAuditContext {
  return { actor: "control-plane", ipAddress: context.ipAddress };
}

function selectionIncludesField(
  selectionSet: SelectionSetNode,
  fieldName: string,
  info: GraphQLResolveInfo,
  visitedFragments = new Set<string>(),
): boolean {
  for (const selection of selectionSet.selections) {
    if (selection.kind === "Field") {
      if (selection.name.value === fieldName) return true;
      if (
        selection.selectionSet &&
        selectionIncludesField(
          selection.selectionSet,
          fieldName,
          info,
          visitedFragments,
        )
      ) {
        return true;
      }
    } else if (selection.kind === "InlineFragment") {
      if (
        selectionIncludesField(
          selection.selectionSet,
          fieldName,
          info,
          visitedFragments,
        )
      ) {
        return true;
      }
    } else if (!visitedFragments.has(selection.name.value)) {
      visitedFragments.add(selection.name.value);
      const fragment = info.fragments[selection.name.value];
      if (
        fragment &&
        selectionIncludesField(
          fragment.selectionSet,
          fieldName,
          info,
          visitedFragments,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function requestsPipelineJobs(info?: GraphQLResolveInfo): boolean {
  return Boolean(
    info?.fieldNodes.some((fieldNode) =>
      fieldNode.selectionSet
        ? selectionIncludesField(fieldNode.selectionSet, "jobs", info)
        : false,
    ),
  );
}

export const createGitHubResolvers = (
  gitHubService: GitHubService,
  worktreesService: WorktreesService,
) => ({
  Query: {
    githubSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.getSettings();
    },
    githubAppSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.getAppSettings();
    },
    githubRepositories: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.listRepositories();
    },
    githubAvailableRepositories: (
      _root: unknown,
      { after }: { after?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.availableRepositories(after);
    },
    githubActionsWorkflowRuns: (
      _root: unknown,
      {
        codebaseRepositoryId,
        first,
        after,
      }: {
        codebaseRepositoryId?: string | null;
        first?: number | null;
        after?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.actionsWorkflowRuns(
        codebaseRepositoryId,
        first ?? 25,
        after,
      );
    },
    githubActionsWorkflowJobs: (
      _root: unknown,
      {
        codebaseRepositoryId,
        workflowRunId,
      }: { codebaseRepositoryId: string; workflowRunId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.actionsWorkflowJobs(
        codebaseRepositoryId,
        workflowRunId,
      );
    },
    githubPullRequests: (
      _root: unknown,
      {
        scope,
        repositoryId,
        state,
        first,
        after,
      }: {
        scope: GitHubPullRequestScope;
        repositoryId?: string | null;
        state?: GitHubPullRequestStateFilter | null;
        first?: number | null;
        after?: string | null;
      },
      context: GraphQLContext,
      info?: GraphQLResolveInfo,
    ) => {
      requireControlPlane(context);
      return gitHubService.pullRequests(scope, repositoryId, {
        includePipelineJobs: requestsPipelineJobs(info),
        state: state ?? "OPEN",
        first: first ?? 25,
        after,
      });
    },
    githubPullRequest: (
      _root: unknown,
      { owner, name, number }: { owner: string; name: string; number: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pullRequest(owner, name, number);
    },
    githubPullRequestMergeOptions: (
      _root: unknown,
      { owner, name, number }: { owner: string; name: string; number: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pullRequestMergeOptions(owner, name, number);
    },
    githubReviewThreads: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.reviewThreads();
    },
  },
  Mutation: {
    saveGitHubSettings: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          apiToken?: string | null;
          defaultJiraKeyRegex?: string | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveSettings(input);
    },
    saveGitHubAppSettings: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          appId: string;
          installationId: string;
          privateKey?: string | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveAppSettings(input, auditContext(context));
    },
    testGitHubConnection: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.testConnection();
    },
    testGitHubAppConnection: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.testAppConnection(auditContext(context));
    },
    clearGitHubCredentials: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.clearCredentials();
    },
    clearGitHubAppCredentials: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.clearAppCredentials(auditContext(context));
    },
    addGitHubRepository: (
      _root: unknown,
      {
        input,
      }: {
        input: { nameWithOwner: string; jiraKeyRegex?: string | null };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.addRepository(input);
    },
    updateGitHubRepository: (
      _root: unknown,
      { input }: { input: { id: string; jiraKeyRegex?: string | null } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.updateRepository(input);
    },
    removeGitHubRepository: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.removeRepository(id);
    },
    mergeGitHubPullRequest: async (
      _root: unknown,
      {
        input,
      }: {
        input: {
          owner: string;
          name: string;
          number: number;
          method: GitHubMergeMethod;
          commitHeadline: string;
          commitBody: string;
          authorEmail?: string | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      const result = await gitHubService.mergePullRequest(input);
      const { owner, name } = normalizeGitHubRepositoryName(
        `${input.owner}/${input.name}`,
      );
      worktreesService.invalidatePullRequestsForOrigin(
        `github.com/${owner}/${name}`,
      );
      return result;
    },
    retryGitHubPipeline: (
      _root: unknown,
      {
        repositoryId,
        checkSuiteId,
      }: { repositoryId: string; checkSuiteId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.retryPipeline(
        repositoryId,
        checkSuiteId,
        auditContext(context),
      );
    },
    retryGitHubWorkflowJob: (
      _root: unknown,
      {
        repositoryId,
        checkSuiteId,
        jobId,
      }: { repositoryId: string; checkSuiteId: string; jobId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.retryWorkflowJob(
        repositoryId,
        checkSuiteId,
        jobId,
        auditContext(context),
      );
    },
    replyToGitHubReviewThread: (
      _root: unknown,
      { threadId, body }: { threadId: string; body: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.replyToReviewThread(threadId, body);
    },
    setGitHubReviewThreadResolved: (
      _root: unknown,
      { threadId, resolved }: { threadId: string; resolved: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.setReviewThreadResolved(threadId, resolved);
    },
  },
});
