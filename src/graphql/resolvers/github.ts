import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GitHubPullRequestScope, GitHubService } from "@/services/github";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createGitHubResolvers = (gitHubService: GitHubService) => ({
  Query: {
    githubSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.getSettings();
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
    githubPullRequests: (
      _root: unknown,
      {
        scope,
        repositoryId,
      }: { scope: GitHubPullRequestScope; repositoryId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pullRequests(scope, repositoryId);
    },
    githubPullRequest: (
      _root: unknown,
      { owner, name, number }: { owner: string; name: string; number: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.pullRequest(owner, name, number);
    },
  },
  Mutation: {
    saveGitHubSettings: (
      _root: unknown,
      { input }: { input: { apiToken?: string | null } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.saveSettings(input);
    },
    testGitHubConnection: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.testConnection();
    },
    clearGitHubCredentials: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.clearCredentials();
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
    retryGitHubPipeline: (
      _root: unknown,
      {
        repositoryId,
        checkSuiteId,
      }: { repositoryId: string; checkSuiteId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return gitHubService.retryPipeline(repositoryId, checkSuiteId);
    },
  },
});
