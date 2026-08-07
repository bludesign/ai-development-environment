import { describe, expect, test, vi } from "vitest";

import type { GitHubService } from "@/services/github";
import type { GitLabService } from "@/services/gitlab";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createGitLabResolvers } from "./gitlab";

const context = (agentId: string | null): GraphQLContext =>
  ({ agentId, ipAddress: "127.0.0.1" }) as GraphQLContext;

describe("GitLab resolvers", () => {
  test.each([
    { name: "GitHub only", github: true, gitlab: false },
    { name: "GitLab only", github: false, gitlab: true },
    { name: "both providers", github: true, gitlab: true },
    { name: "neither provider", github: false, gitlab: false },
  ])("returns integration state for $name", async ({ github, gitlab }) => {
    const gitHubService = {
      getSettings: vi.fn().mockResolvedValue({ tokenConfigured: github }),
      webhooksEnabled: vi.fn().mockResolvedValue(github),
    } as unknown as GitHubService;
    const gitLabService = {
      getSettings: vi.fn().mockResolvedValue({
        configured: gitlab,
        baseUrl: gitlab ? "https://gitlab.example.com/gitlab" : null,
      }),
      webhooksEnabled: vi.fn().mockResolvedValue(gitlab),
    } as unknown as GitLabService;
    const resolvers = createGitLabResolvers(gitLabService, gitHubService);

    await expect(
      resolvers.Query.sourceControlIntegrationState({}, {}, context(null)),
    ).resolves.toEqual({
      github: {
        provider: "GITHUB",
        configured: github,
        webhooksEnabled: github,
        baseUrl: "https://github.com",
      },
      gitlab: {
        provider: "GITLAB",
        configured: gitlab,
        webhooksEnabled: gitlab,
        baseUrl: gitlab ? "https://gitlab.example.com/gitlab" : null,
      },
    });
  });

  test("rejects integration-state access from agent credentials", async () => {
    const gitLabService = {
      getSettings: vi.fn(),
      webhooksEnabled: vi.fn(),
    } as unknown as GitLabService;
    const gitHubService = {
      getSettings: vi.fn(),
      webhooksEnabled: vi.fn(),
    } as unknown as GitHubService;
    const resolvers = createGitLabResolvers(gitLabService, gitHubService);

    await expect(
      resolvers.Query.sourceControlIntegrationState({}, {}, context("agent-1")),
    ).rejects.toThrow("control-plane");
    expect(gitLabService.getSettings).not.toHaveBeenCalled();
    expect(gitHubService.getSettings).not.toHaveBeenCalled();
  });
});
