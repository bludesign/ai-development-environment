import { describe, expect, test, vi } from "vitest";

import type { GitHubService } from "@/services/github";
import {
  GitLabService,
  type GitLabMergeOptions,
  type GitLabMergeResult,
  type SubmitGitLabMergeRequestMergeInput,
} from "@/services/gitlab";
import type { GitLabMergeService } from "@/services/gitlab/gitlab-merge.service";
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

const mergeResult: GitLabMergeResult = {
  mergeRequest: {
    id: "101",
    projectId: "7",
    iid: 3,
    title: "[AIDE-145] Improve GitLab",
    description: "",
    state: "MERGED",
    draft: false,
    webUrl: "https://gitlab.example/team/repo/-/merge_requests/3",
    sourceBranch: "feature/AIDE-145",
    targetBranch: "main",
    sha: "reviewed-sha",
    author: {
      id: "1",
      username: "user",
      name: "User",
      webUrl: "https://gitlab.example/user",
      avatarUrl: null,
    },
    reviewers: [],
    labels: [],
    detailedMergeStatus: "not_open",
    mergeWhenPipelineSucceeds: false,
    squashOnMerge: true,
    hasConflicts: false,
    blockingDiscussionsResolved: true,
    createdAt: "2026-09-28T00:00:00Z",
    updatedAt: "2026-09-28T01:00:00Z",
    mergedAt: "2026-09-28T01:00:00Z",
  },
  operation: {
    id: "operation-1",
    state: "ACTION_REQUIRED",
    autoMerge: false,
    worktreeId: "worktree-1",
    ticketKey: "AIDE-145",
    mergeConfirmedAt: "2026-09-28T01:00:00Z",
    ticketMovedAt: null,
    worktreeDeletedAt: null,
    updatedAt: "2026-09-28T01:00:00Z",
    lastError: "Jira unavailable",
  },
  postMergeError: "Jira unavailable",
};

const mergeOptions: GitLabMergeOptions = {
  projectId: "7",
  iid: 3,
  title: mergeResult.mergeRequest.title,
  state: "OPENED",
  sha: "reviewed-sha",
  sourceBranch: "feature/AIDE-145",
  targetBranch: "main",
  mergeMethod: "merge",
  squashPolicy: "default_off",
  squash: false,
  removeSourceBranch: true,
  canRemoveSourceBranch: true,
  canMerge: true,
  canAutoMerge: true,
  canCancelAutoMerge: false,
  autoMergeEnabled: false,
  mergeBlockedReason: null,
  autoMergeBlockedReason: null,
  mergeCommitMessage: null,
  squashCommitMessage: null,
  worktreeId: "worktree-1",
  worktreeFolder: "/workspaces/repo",
  canDeleteWorktree: true,
  ticketKey: "AIDE-145",
  ticketDoneStatusConfigured: true,
  defaultMoveTicketToDone: false,
  defaultDeleteWorktree: false,
  operation: null,
};

function mergeResolvers() {
  const coordinator = {
    options: vi.fn().mockResolvedValue(mergeOptions),
    submit: vi.fn().mockResolvedValue(mergeResult),
    cancel: vi.fn().mockResolvedValue(mergeResult),
    retryFollowUps: vi.fn().mockResolvedValue(mergeResult),
  };
  const service = new GitLabService();
  service.setMergeCoordinator(coordinator as unknown as GitLabMergeService);
  const state = vi
    .spyOn(service, "mergeRequestState")
    .mockResolvedValue({ ...mergeResult.mergeRequest, state: "OPENED" });
  const directMerge = vi.spyOn(service, "mergeMergeRequestDirect");
  return {
    coordinator,
    state,
    directMerge,
    resolvers: createGitLabResolvers(service, {} as GitHubService),
  };
}

describe("GitLab merge API contracts", () => {
  test.each([undefined, null, "worktree-1"])(
    "loads policy and follow-up options with worktree context %s",
    async (worktreeId) => {
      const { resolvers, coordinator } = mergeResolvers();
      await expect(
        resolvers.Query.gitlabMergeRequestMergeOptions(
          {},
          { projectId: "7", iid: 3, worktreeId },
          context(null),
        ),
      ).resolves.toBe(mergeOptions);
      expect(coordinator.options).toHaveBeenCalledExactlyOnceWith(
        "7",
        3,
        worktreeId,
      );
    },
  );

  test("preserves reviewed merge choices and a successful merge with failed follow-ups", async () => {
    const { resolvers, coordinator } = mergeResolvers();
    const input: SubmitGitLabMergeRequestMergeInput = {
      projectId: "7",
      iid: 3,
      sha: "reviewed-sha",
      autoMerge: false,
      squash: true,
      removeSourceBranch: false,
      mergeCommitMessage: "Merge reviewed changes",
      squashCommitMessage: "Improve GitLab",
      worktreeId: "worktree-1",
      deleteWorktree: true,
      moveTicketToDone: true,
    };
    await expect(
      resolvers.Mutation.submitGitLabMergeRequestMerge(
        {},
        { input },
        context(null),
      ),
    ).resolves.toBe(mergeResult);
    expect(coordinator.submit).toHaveBeenCalledExactlyOnceWith(input);
  });

  test.each([
    ["cancelGitLabAutoMerge", "cancel"],
    ["retryGitLabMergeFollowUps", "retryFollowUps"],
  ] as const)(
    "%s preserves confirmed merge and follow-up outcomes without resubmitting",
    async (mutation, method) => {
      const { resolvers, coordinator } = mergeResolvers();
      await expect(
        resolvers.Mutation[mutation](
          {},
          { projectId: "7", iid: 3 },
          context(null),
        ),
      ).resolves.toBe(mergeResult);
      expect(coordinator[method]).toHaveBeenCalledExactlyOnceWith("7", 3);
      expect(coordinator.submit).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, null, "reviewed-sha"])(
    "keeps the legacy mutation response as a merge request with SHA %s",
    async (sha) => {
      const { resolvers, coordinator, state, directMerge } = mergeResolvers();
      const input = {
        projectId: "7",
        iid: 3,
        sha,
        squash: true,
        removeSourceBranch: false,
        autoMerge: true,
      };
      await expect(
        resolvers.Mutation.mergeGitLabMergeRequest(
          {},
          { input },
          context(null),
        ),
      ).resolves.toBe(mergeResult.mergeRequest);
      expect(coordinator.submit).toHaveBeenCalledExactlyOnceWith({
        ...input,
        sha: "reviewed-sha",
      });
      if (sha) expect(state).not.toHaveBeenCalled();
      else expect(state).toHaveBeenCalledExactlyOnceWith("7", 3);
      expect(directMerge).not.toHaveBeenCalled();
    },
  );

  test("denies agent credentials before any new or legacy merge service operation", () => {
    const { resolvers, coordinator, state, directMerge } = mergeResolvers();
    const args = { projectId: "7", iid: 3 };
    const input = { ...args, sha: "reviewed-sha" };
    const agent = context("agent-1");
    for (const call of [
      () => resolvers.Query.gitlabMergeRequestMergeOptions({}, args, agent),
      () =>
        resolvers.Mutation.submitGitLabMergeRequestMerge({}, { input }, agent),
      () => resolvers.Mutation.cancelGitLabAutoMerge({}, args, agent),
      () => resolvers.Mutation.retryGitLabMergeFollowUps({}, args, agent),
      () => resolvers.Mutation.mergeGitLabMergeRequest({}, { input }, agent),
    ]) {
      expect(call).toThrow(
        "Agent credentials cannot perform control-plane operations",
      );
    }
    for (const method of Object.values(coordinator))
      expect(method).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(directMerge).not.toHaveBeenCalled();
  });
});

describe("GitLab discovery and comments contracts", () => {
  test("forwards project search and all comments continuation/selection arguments", async () => {
    const projects = { items: [], nextPage: 2 };
    const comments = {
      threads: [],
      hasNextPage: true,
      endCursor: "cursor",
      partial: true,
      warnings: ["Retry one source"],
    };
    const service = {
      accessibleProjects: vi.fn().mockResolvedValue(projects),
      comments: vi.fn().mockResolvedValue(comments),
    } as unknown as GitLabService;
    const resolvers = createGitLabResolvers(service, {} as GitHubService);
    await expect(
      resolvers.Query.gitlabAccessibleProjects(
        {},
        { search: "team", page: 2, perPage: 25 },
        context(null),
      ),
    ).resolves.toBe(projects);
    expect(service.accessibleProjects).toHaveBeenCalledWith("team", 2, 25);
    const args = {
      projectId: "99",
      iid: 2,
      discussionId: "thread",
      after: "cursor",
      first: 12,
      refresh: true,
    };
    await expect(
      resolvers.Query.gitlabComments({}, args, context(null)),
    ).resolves.toBe(comments);
    expect(service.comments).toHaveBeenCalledWith(args);
  });

  test("denies agent credentials before project or comment provider access", () => {
    const service = {
      accessibleProjects: vi.fn(),
      comments: vi.fn(),
    } as unknown as GitLabService;
    const resolvers = createGitLabResolvers(service, {} as GitHubService);
    expect(() =>
      resolvers.Query.gitlabAccessibleProjects({}, {}, context("agent")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.gitlabComments({}, {}, context("agent")),
    ).toThrow("control-plane");
    expect(service.accessibleProjects).not.toHaveBeenCalled();
    expect(service.comments).not.toHaveBeenCalled();
  });
});
