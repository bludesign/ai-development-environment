import { describe, expect, test, vi } from "vitest";
import {
  parse,
  type GraphQLResolveInfo,
  type OperationDefinitionNode,
} from "graphql";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GitHubService } from "@/services/github";

import { createGitHubResolvers } from "./github";

function context(agentId: string | null): GraphQLContext {
  return { agentId, ipAddress: "127.0.0.1" } as GraphQLContext;
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
      pullRequests: vi.fn(),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service);

    expect(() =>
      resolvers.Query.githubSettings({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.githubPullRequests(
        {},
        { scope: "MINE" },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.pullRequests).not.toHaveBeenCalled();
  });

  test("passes write-only credentials and repository scope to the service", async () => {
    const safeSettings = {
      tokenConfigured: true,
      updatedAt: new Date(0).toISOString(),
    };
    const service = {
      saveSettings: vi.fn().mockResolvedValue(safeSettings),
      saveAppSettings: vi.fn().mockResolvedValue({ configured: true }),
      pullRequests: vi.fn().mockResolvedValue({ items: [], truncated: false }),
      pullRequest: vi.fn().mockResolvedValue({ id: "pull-request-1" }),
      retryPipeline: vi.fn().mockResolvedValue({ id: "check-suite-1" }),
      retryWorkflowJob: vi.fn().mockResolvedValue(true),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service);
    const input = { apiToken: "secret-token" };
    const appInput = {
      appId: "123",
      installationId: "456",
      privateKey: "private-key",
    };

    await expect(
      resolvers.Mutation.saveGitHubSettings({}, { input }, context(null)),
    ).resolves.toEqual(safeSettings);
    await expect(
      resolvers.Query.githubPullRequests(
        {},
        { scope: "REPOSITORY", repositoryId: "repository-1" },
        context(null),
      ),
    ).resolves.toEqual({ items: [], truncated: false });
    expect(service.saveSettings).toHaveBeenCalledWith(input);
    await resolvers.Mutation.saveGitHubAppSettings(
      {},
      { input: appInput },
      context(null),
    );
    expect(service.saveAppSettings).toHaveBeenCalledWith(appInput, {
      actor: "control-plane",
      ipAddress: "127.0.0.1",
    });
    expect(service.pullRequests).toHaveBeenCalledWith(
      "REPOSITORY",
      "repository-1",
    );
    await resolvers.Query.githubPullRequest(
      {},
      { owner: "acme", name: "widgets", number: 17 },
      context(null),
    );
    await resolvers.Mutation.retryGitHubPipeline(
      {},
      { repositoryId: "repository-1", checkSuiteId: "check-suite-1" },
      context(null),
    );
    await resolvers.Mutation.retryGitHubWorkflowJob(
      {},
      {
        repositoryId: "repository-1",
        checkSuiteId: "check-suite-1",
        jobId: "job-11",
      },
      context(null),
    );
    expect(service.pullRequest).toHaveBeenCalledWith("acme", "widgets", 17);
    expect(service.retryPipeline).toHaveBeenCalledWith(
      "repository-1",
      "check-suite-1",
      { actor: "control-plane", ipAddress: "127.0.0.1" },
    );
    expect(service.retryWorkflowJob).toHaveBeenCalledWith(
      "repository-1",
      "check-suite-1",
      "job-11",
      { actor: "control-plane", ipAddress: "127.0.0.1" },
    );
    expect(safeSettings).not.toHaveProperty("apiToken");
  });

  test("hydrates pipeline jobs when the list query selects them", async () => {
    const service = {
      pullRequests: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service);
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
      { scope: "MINE" },
      context(null),
      info,
    );

    expect(service.pullRequests).toHaveBeenCalledWith("MINE", undefined, {
      includePipelineJobs: true,
    });
  });
});
