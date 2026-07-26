import { describe, expect, test, vi } from "vitest";
import {
  parse,
  type GraphQLResolveInfo,
  type OperationDefinitionNode,
} from "graphql";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GitHubService } from "@/services/github";
import type { WorktreesService } from "@/services/worktrees";

import { createGitHubResolvers } from "./github";

function context(agentId: string | null): GraphQLContext {
  return { agentId, ipAddress: "127.0.0.1" } as GraphQLContext;
}

function worktreesService() {
  return {
    attachPullRequestForBranch: vi.fn().mockResolvedValue(0),
  } as unknown as WorktreesService;
}

function resolveInfo(source: string): GraphQLResolveInfo {
  const document = parse(source);
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === "OperationDefinition",
  );
  if (!operation) throw new Error("Query operation is required");
  const fieldNode = operation.selectionSet.selections.find(
    (selection) => selection.kind === "Field",
  );
  if (!fieldNode || fieldNode.kind !== "Field") {
    throw new Error("Query field is required");
  }
  return {
    fieldNodes: [fieldNode],
    fragments: Object.fromEntries(
      document.definitions
        .filter((definition) => definition.kind === "FragmentDefinition")
        .map((fragment) => [fragment.name.value, fragment]),
    ),
  } as unknown as GraphQLResolveInfo;
}

describe("GitHub resolvers", () => {
  test("rejects agent credentials from GitHub configuration and data", () => {
    const service = {
      getSettings: vi.fn(),
      cacheMetrics: vi.fn(),
      clearCache: vi.fn(),
      clearApiCalls: vi.fn(),
      actionsWorkflowRuns: vi.fn(),
      pullRequests: vi.fn(),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service, worktreesService());

    expect(() =>
      resolvers.Query.githubSettings({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.githubActionsWorkflowRuns(
        {},
        { first: 25, source: "ACTIONS_PAGE" },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.githubPullRequests(
        {},
        { scope: "MINE", source: "PULL_REQUESTS_PAGE" },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.githubReviewThreads({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.githubCacheMetrics({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Mutation.clearGitHubCache({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Mutation.clearGitHubApiCalls({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.actionsWorkflowRuns).not.toHaveBeenCalled();
    expect(service.pullRequests).not.toHaveBeenCalled();
    expect(service.cacheMetrics).not.toHaveBeenCalled();
    expect(service.clearCache).not.toHaveBeenCalled();
    expect(service.clearApiCalls).not.toHaveBeenCalled();
  });

  test("passes write-only credentials and repository scope to the service", async () => {
    const safeSettings = {
      tokenConfigured: true,
      updatedAt: new Date(0).toISOString(),
    };
    const service = {
      saveSettings: vi.fn().mockResolvedValue(safeSettings),
      saveAppSettings: vi.fn().mockResolvedValue({ configured: true }),
      actionsWorkflowRuns: vi
        .fn()
        .mockResolvedValue({ items: [], hasNextPage: false }),
      actionsWorkflowJobs: vi.fn().mockResolvedValue([]),
      pullRequests: vi.fn().mockResolvedValue({ items: [], truncated: false }),
      pullRequest: vi.fn().mockResolvedValue({ id: "pull-request-1" }),
      pullRequestMergeOptions: vi.fn().mockResolvedValue({ canMerge: true }),
      mergePullRequest: vi.fn().mockResolvedValue({ state: "MERGED" }),
      createPullRequest: vi.fn().mockResolvedValue({
        id: "pull-request-created",
        headRefName: "feature/APP-43",
      }),
      retryPipeline: vi.fn().mockResolvedValue({ id: "check-suite-1" }),
      retryWorkflowJob: vi.fn().mockResolvedValue(true),
      cancelActionsWorkflowRun: vi.fn().mockResolvedValue(true),
      reviewThreads: vi.fn().mockResolvedValue({ threads: [] }),
      replyToReviewThread: vi.fn().mockResolvedValue({ id: "comment-1" }),
      setReviewThreadResolved: vi
        .fn()
        .mockResolvedValue({ id: "thread-1", isResolved: true }),
    } as unknown as GitHubService;
    const worktrees = worktreesService();
    const resolvers = createGitHubResolvers(service, worktrees);
    const input = { apiToken: "secret-token" };
    const appInput = {
      appId: "123",
      installationId: "456",
      privateKey: "private-key",
      webhookUrl: "https://hooks.example/github",
    };

    await expect(
      resolvers.Mutation.saveGitHubSettings({}, { input }, context(null)),
    ).resolves.toEqual(safeSettings);
    await expect(
      resolvers.Query.githubPullRequests(
        {},
        {
          source: "PULL_REQUESTS_PAGE",
          scope: "REPOSITORY",
          repositoryId: "repository-1",
          state: "ALL",
          first: 10,
          after: "pull-request-cursor-1",
        },
        context(null),
      ),
    ).resolves.toEqual({ items: [], truncated: false });
    expect(service.saveSettings).toHaveBeenCalledWith(input);
    await resolvers.Query.githubActionsWorkflowRuns(
      {},
      {
        source: "ACTIONS_PAGE",
        codebaseRepositoryId: "codebase-repository-1",
        branch: "feature/APP-42",
        workflowId: "workflow-1",
        first: 10,
        after: "cursor-1",
      },
      context(null),
    );
    await resolvers.Query.githubActionsWorkflowJobs(
      {},
      {
        source: "ACTIONS_PAGE",
        codebaseRepositoryId: "codebase-repository-1",
        workflowRunId: "44",
      },
      context(null),
    );
    await resolvers.Mutation.saveGitHubAppSettings(
      {},
      { input: appInput },
      context(null),
    );
    expect(service.saveAppSettings).toHaveBeenCalledWith(
      appInput,
      {
        actor: "control-plane",
        ipAddress: "127.0.0.1",
      },
      undefined,
    );
    expect(service.pullRequests).toHaveBeenCalledWith(
      "REPOSITORY",
      "repository-1",
      {
        includePipelineJobs: false,
        state: "ALL",
        first: 10,
        after: "pull-request-cursor-1",
        requestSource: "PULL_REQUESTS_PAGE",
      },
    );
    await resolvers.Query.githubPullRequest(
      {},
      { owner: "acme", name: "widgets", number: 17 },
      context(null),
    );
    await resolvers.Query.githubPullRequestMergeOptions(
      {},
      {
        source: "PULL_REQUEST_DETAILS",
        owner: "acme",
        name: "widgets",
        number: 17,
      },
      context(null),
    );
    const mergeInput = {
      owner: "acme",
      name: "widgets",
      number: 17,
      method: "SQUASH" as const,
      commitHeadline: "Ship widgets",
      commitBody: "Release notes",
      authorEmail: "octocat@example.com",
    };
    await resolvers.Mutation.mergeGitHubPullRequest(
      {},
      { input: mergeInput, source: "PULL_REQUEST_DETAILS" },
      context(null),
    );
    const createInput = {
      owner: "acme",
      name: "widgets",
      baseRefName: "main",
      headRefName: "feature/APP-43",
      title: "Create and attach a pull request",
      body: null,
      draft: false,
    };
    await resolvers.Mutation.createGitHubPullRequest(
      {},
      { input: createInput },
      context(null),
    );
    await resolvers.Mutation.retryGitHubPipeline(
      {},
      {
        repositoryId: "repository-1",
        checkSuiteId: "check-suite-1",
        source: "PULL_REQUEST_DETAILS",
      },
      context(null),
    );
    await resolvers.Mutation.retryGitHubWorkflowJob(
      {},
      {
        repositoryId: "repository-1",
        checkSuiteId: "check-suite-1",
        jobId: "job-11",
        source: "ACTIONS_PAGE",
      },
      context(null),
    );
    await resolvers.Mutation.cancelGitHubActionsWorkflowRun(
      {},
      {
        codebaseRepositoryId: "codebase-repository-1",
        workflowRunId: "44",
        force: true,
        source: "WORKTREE_PIPELINES",
      },
      context(null),
    );
    await resolvers.Query.githubReviewThreads({}, {}, context(null));
    await resolvers.Mutation.replyToGitHubReviewThread(
      {},
      { threadId: "thread-1", body: "Reply" },
      context(null),
    );
    await resolvers.Mutation.setGitHubReviewThreadResolved(
      {},
      { threadId: "thread-1", resolved: true },
      context(null),
    );
    expect(service.pullRequest).toHaveBeenCalledWith("acme", "widgets", 17);
    expect(service.actionsWorkflowRuns).toHaveBeenCalledWith(
      "codebase-repository-1",
      10,
      "cursor-1",
      "feature/APP-42",
      "workflow-1",
      "ACTIONS_PAGE",
    );
    expect(service.actionsWorkflowJobs).toHaveBeenCalledWith(
      "codebase-repository-1",
      "44",
      "ACTIONS_PAGE",
    );
    expect(service.pullRequestMergeOptions).toHaveBeenCalledWith(
      "acme",
      "widgets",
      17,
      "PULL_REQUEST_DETAILS",
    );
    expect(service.mergePullRequest).toHaveBeenCalledWith(
      mergeInput,
      "PULL_REQUEST_DETAILS",
    );
    expect(worktrees.attachPullRequestForBranch).toHaveBeenCalledWith(
      "github.com/acme/widgets",
      "feature/APP-43",
      expect.objectContaining({ id: "pull-request-created" }),
    );
    expect(service.retryPipeline).toHaveBeenCalledWith(
      "repository-1",
      "check-suite-1",
      "PULL_REQUEST_DETAILS",
      { actor: "control-plane", ipAddress: "127.0.0.1" },
    );
    expect(service.retryWorkflowJob).toHaveBeenCalledWith(
      "repository-1",
      "check-suite-1",
      "job-11",
      "ACTIONS_PAGE",
      { actor: "control-plane", ipAddress: "127.0.0.1" },
    );
    expect(service.cancelActionsWorkflowRun).toHaveBeenCalledWith(
      "codebase-repository-1",
      "44",
      true,
      "WORKTREE_PIPELINES",
      { actor: "control-plane", ipAddress: "127.0.0.1" },
    );
    expect(service.reviewThreads).toHaveBeenCalledOnce();
    expect(service.replyToReviewThread).toHaveBeenCalledWith(
      "thread-1",
      "Reply",
    );
    expect(service.setReviewThreadResolved).toHaveBeenCalledWith(
      "thread-1",
      true,
    );
    expect(safeSettings).not.toHaveProperty("apiToken");
  });

  test("hydrates pipeline jobs when the list query selects them", async () => {
    const service = {
      pullRequests: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service, worktreesService());
    const info = resolveInfo(`
      query PullRequests($scope: GitHubPullRequestScope!) {
        githubPullRequests(scope: $scope) {
          items {
            ...PipelineJobs
          }
        }
      }
      fragment PipelineJobs on GitHubPullRequest {
        pipelines {
          jobs { name status }
        }
      }
    `);

    await resolvers.Query.githubPullRequests(
      {},
      { scope: "MINE", source: "PULL_REQUESTS_PAGE" },
      context(null),
      info,
    );

    expect(service.pullRequests).toHaveBeenCalledWith("MINE", undefined, {
      includePipelineJobs: true,
      state: "OPEN",
      first: 25,
      after: undefined,
      requestSource: "PULL_REQUESTS_PAGE",
    });
  });

  test("only hydrates attempt jobs when the query selects them", async () => {
    const service = {
      actionsWorkflowRunAttempt: vi.fn().mockResolvedValue({ jobs: [] }),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service, worktreesService());
    const args = {
      source: "ACTIONS_PAGE" as const,
      repositoryId: "repository-1",
      workflowRunId: "77",
      attempt: 2,
    };

    await resolvers.Query.githubActionsWorkflowRunAttempt(
      {},
      args,
      context(null),
      resolveInfo(`
        query Attempt {
          githubActionsWorkflowRunAttempt(
            repositoryId: "repository-1"
            workflowRunId: "77"
            attempt: 2
          ) { status startedAt }
        }
      `),
    );
    await resolvers.Query.githubActionsWorkflowRunAttempt(
      {},
      args,
      context(null),
      resolveInfo(`
        query Attempt {
          githubActionsWorkflowRunAttempt(
            repositoryId: "repository-1"
            workflowRunId: "77"
            attempt: 2
          ) { status jobs { name } }
        }
      `),
    );

    expect(service.actionsWorkflowRunAttempt).toHaveBeenNthCalledWith(
      1,
      "repository-1",
      "77",
      2,
      false,
      "ACTIONS_PAGE",
    );
    expect(service.actionsWorkflowRunAttempt).toHaveBeenNthCalledWith(
      2,
      "repository-1",
      "77",
      2,
      true,
      "ACTIONS_PAGE",
    );
  });
});
