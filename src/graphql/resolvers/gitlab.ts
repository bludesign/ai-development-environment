import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GitHubService } from "@/services/github";
import type {
  GitLabMergeRequestScope,
  GitLabMergeRequestState,
  GitLabReviewOutcome,
  GitLabService,
} from "@/services/gitlab";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

function checked<T>(context: GraphQLContext, action: () => T): T {
  requireControlPlane(context);
  return action();
}

export const createGitLabResolvers = (
  gitLabService: GitLabService,
  gitHubService: GitHubService,
) => ({
  SourceControlRequest: {
    __resolveType: (value: { provider?: string; iid?: number }) =>
      value.provider === "GITLAB" || typeof value.iid === "number"
        ? "GitLabMergeRequest"
        : "GitHubPullRequest",
  },
  GitHubPullRequest: {
    provider: () => "GITHUB",
  },
  GitLabMergeRequest: {
    provider: () => "GITLAB",
    number: (value: { iid: number }) => value.iid,
    url: (value: { webUrl: string }) => value.webUrl,
    isDraft: (value: { draft: boolean }) => value.draft,
    headRefName: (value: { sourceBranch: string }) => value.sourceBranch,
    headRefOid: (value: { sha: string }) => value.sha,
  },
  Query: {
    sourceControlIntegrationState: async (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) =>
      checked(context, async () => {
        const [github, githubWebhooks, gitlab, gitlabWebhooks] =
          await Promise.all([
            gitHubService.getSettings(),
            gitHubService.webhooksEnabled(),
            gitLabService.getSettings(),
            gitLabService.webhooksEnabled(),
          ]);
        return {
          github: {
            provider: "GITHUB",
            configured: github.tokenConfigured,
            webhooksEnabled: githubWebhooks,
            baseUrl: "https://github.com",
          },
          gitlab: {
            provider: "GITLAB",
            configured: gitlab.configured,
            webhooksEnabled: gitlabWebhooks,
            baseUrl: gitlab.baseUrl,
          },
        };
      }),
    gitlabSettings: (_root: unknown, _args: unknown, context: GraphQLContext) =>
      checked(context, () => gitLabService.getSettings()),
    gitlabWebhooksEnabled: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.webhooksEnabled()),
    gitlabProjects: (_root: unknown, _args: unknown, context: GraphQLContext) =>
      checked(context, () => gitLabService.projects()),
    gitlabAvailableProjects: (
      _root: unknown,
      args: { search?: string | null; page?: number; perPage?: number },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.availableProjects(args.search, args.page, args.perPage),
      ),
    gitlabMergeRequests: (
      _root: unknown,
      args: {
        scope: GitLabMergeRequestScope;
        projectId?: string | null;
        state?: GitLabMergeRequestState | null;
        page?: number;
        perPage?: number;
      },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.mergeRequests(args)),
    gitlabMergeRequest: (
      _root: unknown,
      args: { projectId: string; iid: number },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.mergeRequest(args.projectId, args.iid),
      ),
    gitlabPipelines: (
      _root: unknown,
      args: { projectId: string; page?: number; perPage?: number },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.pipelines(args.projectId, args.page, args.perPage),
      ),
    gitlabPipeline: (
      _root: unknown,
      args: { projectId: string; pipelineId: string },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.pipeline(args.projectId, args.pipelineId),
      ),
    gitlabPipelineJobs: (
      _root: unknown,
      args: { projectId: string; pipelineId: string },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.pipelineJobs(args.projectId, args.pipelineId),
      ),
    gitlabCachedEntries: (
      _root: unknown,
      args: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.cachedEntries(args.limit, args.offset),
      ),
    gitlabCachedEntry: (
      _root: unknown,
      args: { id: string },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.cachedEntry(args.id)),
    gitlabApiCalls: (
      _root: unknown,
      args: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) =>
      checked(context, () => gitLabService.apiCalls(args.limit, args.offset)),
    gitlabWebhookDeliveries: (
      _root: unknown,
      args: { limit?: number; offset?: number },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.webhookDeliveries(args.limit, args.offset),
      ),
    gitlabCacheTtlOverrides: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.cacheTtlOverrides()),
    gitlabRateLimitSnapshots: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.rateLimitSnapshots()),
    gitlabAutoRetryRules: (
      _root: unknown,
      { projectId }: { projectId?: string | null },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.autoRetryRules(projectId)),
  },
  Mutation: {
    saveGitLabSettings: (
      _root: unknown,
      { input }: { input: Parameters<GitLabService["saveSettings"]>[0] },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.saveSettings(input)),
    testGitLabConnection: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.testConnection()),
    clearGitLabCredentials: (
      _root: unknown,
      { force }: { force?: boolean },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.clearCredentials(force)),
    addGitLabProject: (
      _root: unknown,
      { projectId }: { projectId: string },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.addProject(projectId)),
    removeGitLabProject: (
      _root: unknown,
      { projectId, force }: { projectId: string; force?: boolean },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.removeProject(projectId, force)),
    configureGitLabProjectWebhook: (
      _root: unknown,
      {
        projectId,
        callbackUrl,
      }: { projectId: string; callbackUrl?: string | null },
      context: GraphQLContext,
    ) =>
      checked(context, () => {
        const url =
          callbackUrl?.trim() ||
          (context.requestOrigin
            ? `${context.requestOrigin.replace(/\/$/, "")}/api/public/gitlab/webhook`
            : null);
        if (!url) throw new Error("A public GitLab webhook URL is required");
        return gitLabService.configureProjectWebhook(projectId, url);
      }),
    removeGitLabProjectWebhook: (
      _root: unknown,
      { projectId }: { projectId: string },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.removeProjectWebhook(projectId)),
    createGitLabMergeRequest: (
      _root: unknown,
      { input }: { input: Parameters<GitLabService["createMergeRequest"]>[0] },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.createMergeRequest(input)),
    updateGitLabMergeRequest: (
      _root: unknown,
      { input }: { input: Parameters<GitLabService["updateMergeRequest"]>[0] },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.updateMergeRequest(input)),
    submitGitLabReview: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          projectId: string;
          iid: number;
          outcome: GitLabReviewOutcome;
          body?: string | null;
        };
      },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.submitReview(input)),
    replyToGitLabDiscussion: (
      _root: unknown,
      {
        input,
        body,
      }: {
        input: { projectId: string; iid: number; discussionId: string };
        body: string;
      },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.replyToDiscussion({ ...input, body }),
      ),
    setGitLabDiscussionResolved: (
      _root: unknown,
      {
        input,
        resolved,
      }: {
        input: { projectId: string; iid: number; discussionId: string };
        resolved: boolean;
      },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.setDiscussionResolved({ ...input, resolved }),
      ),
    mergeGitLabMergeRequest: (
      _root: unknown,
      { input }: { input: Parameters<GitLabService["mergeMergeRequest"]>[0] },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.mergeMergeRequest(input)),
    createGitLabPipeline: (
      _root: unknown,
      {
        projectId,
        ref,
        variables,
      }: {
        projectId: string;
        ref: string;
        variables?: Array<{ key: string; value: string }>;
      },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.createPipeline(projectId, ref, variables),
      ),
    retryGitLabPipeline: (
      _root: unknown,
      { projectId, pipelineId }: { projectId: string; pipelineId: string },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.retryPipeline(projectId, pipelineId),
      ),
    cancelGitLabPipeline: (
      _root: unknown,
      { projectId, pipelineId }: { projectId: string; pipelineId: string },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.cancelPipeline(projectId, pipelineId),
      ),
    retryGitLabJob: (
      _root: unknown,
      { projectId, jobId }: { projectId: string; jobId: string },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.retryJob(projectId, jobId)),
    updateGitLabCacheTtl: (
      _root: unknown,
      { ttlMinutes }: { ttlMinutes: number },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.updateCacheTtl(ttlMinutes)),
    clearGitLabCache: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.clearCache()),
    deleteGitLabCachedEntry: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.deleteCachedEntry(id)),
    saveGitLabCacheTtlOverride: (
      _root: unknown,
      { operation, ttlSeconds }: { operation: string; ttlSeconds: number },
      context: GraphQLContext,
    ) =>
      checked(context, () =>
        gitLabService.saveCacheTtlOverride(operation, ttlSeconds),
      ),
    deleteGitLabCacheTtlOverride: (
      _root: unknown,
      { operation }: { operation: string },
      context: GraphQLContext,
    ) =>
      checked(context, () => gitLabService.deleteCacheTtlOverride(operation)),
    saveGitLabAutoRetryRule: (
      _root: unknown,
      { input }: { input: Parameters<GitLabService["saveAutoRetryRule"]>[0] },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.saveAutoRetryRule(input)),
    deleteGitLabAutoRetryRule: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => checked(context, () => gitLabService.deleteAutoRetryRule(id)),
  },
  Subscription: {
    gitlabPipelineStatusChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return gitLabService.subscribePipelineStatuses();
      },
    },
  },
});
