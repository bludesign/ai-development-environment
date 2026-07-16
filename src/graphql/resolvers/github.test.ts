import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { GitHubService } from "@/services/github";

import { createGitHubResolvers } from "./github";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
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
      pullRequests: vi.fn().mockResolvedValue({ items: [], truncated: false }),
    } as unknown as GitHubService;
    const resolvers = createGitHubResolvers(service);
    const input = { apiToken: "secret-token" };

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
    expect(service.pullRequests).toHaveBeenCalledWith(
      "REPOSITORY",
      "repository-1",
    );
    expect(safeSettings).not.toHaveProperty("apiToken");
  });
});
