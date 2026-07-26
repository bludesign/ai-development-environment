import type { GraphQLResolveInfo, SelectionSetNode } from "graphql";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  GitHubAuditContext,
  GitHubApiCallFilters,
  GitHubMergeMethod,
  GitHubPullRequestScope,
  GitHubPullRequestStateFilter,
  GitHubRequestSource,
  GitHubPipelineRecordKeyInput,
  GitHubPipelineStatusKeyInput,
  SaveGitHubAutoRetryRuleInput,
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
    githubRateLimitSnapshots: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.rateLimitSnapshots();
    },
    githubCacheMetrics: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.cacheMetrics();
    },
    githubApiCalls: (
      _root: unknown,
      {
        limit,
        offset,
        apiType,
        requestSource,
        source,
      }: { limit?: number; offset?: number } & GitHubApiCallFilters,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.apiCalls(limit, offset, {
        apiType,
        requestSource,
        source,
      });
    },
    githubCachedEntries: (
      _root: unknown,
      { limit, offset }: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.cachedEntries(limit, offset);
    },
    githubCachedEntry: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.cachedEntry(id);
    },
    githubCacheTtlOverrides: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.cacheTtlOverrides();
    },
    githubCacheableGraphqlOperations: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.cacheableGraphqlOperations();
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
        source,
        codebaseRepositoryId,
        branch,
        workflowId,
        first,
        after,
      }: {
        source: GitHubRequestSource;
        codebaseRepositoryId?: string | null;
        branch?: string | null;
        workflowId?: string | null;
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
        branch,
        workflowId,
        source,
      );
    },
    githubActionsWorkflowJobs: (
      _root: unknown,
      {
        source,
        codebaseRepositoryId,
        workflowRunId,
      }: {
        source: GitHubRequestSource;
        codebaseRepositoryId: string;
        workflowRunId: string;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.actionsWorkflowJobs(
        codebaseRepositoryId,
        workflowRunId,
        source,
      );
    },
    githubActionsWorkflowRunAttempt: (
      _root: unknown,
      {
        source,
        repositoryId,
        workflowRunId,
        attempt,
      }: {
        source: GitHubRequestSource;
        repositoryId: string;
        workflowRunId: string;
        attempt: number;
      },
      context: GraphQLContext,
      info?: GraphQLResolveInfo,
    ) => {
      requireControlPlane(context);
      return gitHubService.actionsWorkflowRunAttempt(
        repositoryId,
        workflowRunId,
        attempt,
        requestsPipelineJobs(info),
        source,
      );
    },
    githubWorktreeWorkflowRuns: (
      _root: unknown,
      { worktreeId }: { worktreeId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.worktreeWorkflowRuns(worktreeId);
    },
    githubRepositoryWorkflows: (
      _root: unknown,
      {
        source,
        codebaseRepositoryId,
      }: { source: GitHubRequestSource; codebaseRepositoryId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.repositoryWorkflows(codebaseRepositoryId, source);
    },
    githubAutoRetryRules: (
      _root: unknown,
      {
        codebaseRepositoryId,
        workflowRunId,
      }: {
        codebaseRepositoryId?: string | null;
        workflowRunId?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.autoRetryRules({
        codebaseRepositoryId,
        workflowRunId,
      });
    },
    githubPullRequests: (
      _root: unknown,
      {
        source,
        scope,
        repositoryId,
        state,
        first,
        after,
      }: {
        source: GitHubRequestSource;
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
        requestSource: source,
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
      {
        source,
        owner,
        name,
        number,
      }: {
        source: GitHubRequestSource;
        owner: string;
        name: string;
        number: number;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pullRequestMergeOptions(owner, name, number, source);
    },
    githubReviewThreads: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.reviewThreads();
    },
    githubPipelineStatuses: (
      _root: unknown,
      { keys }: { keys: GitHubPipelineStatusKeyInput[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pipelineStatus.snapshots(keys);
    },
    githubPipelineRecords: (
      _root: unknown,
      { keys }: { keys: GitHubPipelineRecordKeyInput[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pipelineStatus.records(keys);
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
          actionsNotificationPollIntervalSeconds?: number | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveSettings(input);
    },
    updateGitHubCacheTtl: (
      _root: unknown,
      { ttlMinutes }: { ttlMinutes: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.updateCacheTtl(ttlMinutes);
    },
    saveGitHubCacheTtlOverride: (
      _root: unknown,
      { input }: { input: { operation: string; ttlSeconds: number } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveCacheTtlOverride(
        input.operation,
        input.ttlSeconds,
      );
    },
    deleteGitHubCacheTtlOverride: (
      _root: unknown,
      { operation }: { operation: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.deleteCacheTtlOverride(operation);
    },
    clearGitHubCache: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.clearCache();
    },
    clearGitHubApiCalls: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.clearApiCalls();
    },
    refreshGitHubCachedEntry: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.refreshCachedEntry(id);
    },
    deleteGitHubCachedEntry: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.deleteCachedEntry(id);
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
          webhookUrl?: string | null;
          enhancedPipelineWebhooksEnabled?: boolean | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveAppSettings(
        input,
        auditContext(context),
        context.requestOrigin,
      );
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
        source,
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
        source: GitHubRequestSource;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      const result = await gitHubService.mergePullRequest(input, source);
      return result;
    },
    createGitHubPullRequest: async (
      _root: unknown,
      { input }: { input: Parameters<GitHubService["createPullRequest"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      const pullRequest = await gitHubService.createPullRequest(input);
      const { owner, name } = normalizeGitHubRepositoryName(
        `${input.owner}/${input.name}`,
      );
      await worktreesService.attachPullRequestForBranch(
        `github.com/${owner}/${name}`,
        pullRequest.headRefName,
        pullRequest,
      );
      return pullRequest;
    },
    setGitHubPullRequestLabels: (
      _root: unknown,
      {
        input,
      }: { input: Parameters<GitHubService["setPullRequestLabels"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.setPullRequestLabels(input);
    },
    retryGitHubPipeline: (
      _root: unknown,
      {
        repositoryId,
        checkSuiteId,
        source,
      }: {
        repositoryId: string;
        checkSuiteId: string;
        source: GitHubRequestSource;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.retryPipeline(
        repositoryId,
        checkSuiteId,
        source,
        auditContext(context),
      );
    },
    retryGitHubWorkflowJob: (
      _root: unknown,
      {
        repositoryId,
        checkSuiteId,
        jobId,
        source,
      }: {
        repositoryId: string;
        checkSuiteId: string;
        jobId: string;
        source: GitHubRequestSource;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.retryWorkflowJob(
        repositoryId,
        checkSuiteId,
        jobId,
        source,
        auditContext(context),
      );
    },
    cancelGitHubActionsWorkflowRun: (
      _root: unknown,
      {
        codebaseRepositoryId,
        workflowRunId,
        force,
        source,
      }: {
        codebaseRepositoryId: string;
        workflowRunId: string;
        force: boolean;
        source: GitHubRequestSource;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.cancelActionsWorkflowRun(
        codebaseRepositoryId,
        workflowRunId,
        force,
        source,
        auditContext(context),
      );
    },
    saveGitHubAutoRetryRule: (
      _root: unknown,
      { input }: { input: SaveGitHubAutoRetryRuleInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveAutoRetryRule(input);
    },
    setGitHubAutoRetryRuleEnabled: (
      _root: unknown,
      { id, enabled }: { id: string; enabled: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.setAutoRetryRuleEnabled(id, enabled);
    },
    deleteGitHubAutoRetryRule: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.deleteAutoRetryRule(id);
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
  Subscription: {
    githubPipelineStatusChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return gitHubService.pipelineStatus.subscribe();
      },
    },
  },
});
