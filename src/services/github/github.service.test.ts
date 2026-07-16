import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiToken: "secret-token" as string | null,
  repositories: [
    {
      id: "local-repository-1",
      githubId: "repository-1",
      owner: "acme",
      name: "widgets",
      nameWithOwner: "acme/widgets",
      url: "https://github.com/acme/widgets",
      jiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b`,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ],
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    gitHubSettings: {
      findUnique: async () =>
        state.apiToken ? { id: "default", apiToken: state.apiToken } : null,
    },
    gitHubRepository: {
      findMany: async () => state.repositories,
    },
  }),
}));

import {
  GitHubService,
  normalizeGitHubRepositoryName,
  normalizeJiraKeyRegex,
  parseJiraKey,
} from "./github.service";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawPullRequest(
  id: string,
  title: string,
  options: {
    hasMoreThreads?: boolean;
    pipeline?: string | null;
    reviewDecision?: string | null;
  } = {},
) {
  return {
    id,
    number: id === "pull-request-1" ? 17 : 18,
    title,
    url: `https://github.com/acme/widgets/pull/${id}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt:
      id === "pull-request-1"
        ? "2026-07-15T00:00:00.000Z"
        : "2026-07-14T00:00:00.000Z",
    repository: {
      id: "repository-1",
      nameWithOwner: "acme/widgets",
      url: "https://github.com/acme/widgets",
    },
    labels: {
      nodes: [{ name: "backend" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    statusCheckRollup: options.pipeline
      ? {
          state: options.pipeline,
          contexts: {
            nodes: [
              {
                __typename: "CheckRun",
                id: "check-run-1",
                name: "test",
                status: "COMPLETED",
                conclusion: options.pipeline,
                detailsUrl: "https://github.com/acme/widgets/actions/runs/1",
                checkSuite: {
                  id: "check-suite-1",
                  status: "COMPLETED",
                  conclusion: options.pipeline,
                  url: "https://github.com/acme/widgets/checks",
                  app: { name: "GitHub Actions" },
                  workflowRun: {
                    url: "https://github.com/acme/widgets/actions/runs/1",
                    runNumber: 1,
                    workflow: { name: "CI" },
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }
      : null,
    reviewDecision: options.reviewDecision ?? null,
    reviewThreads: {
      nodes: [{ isResolved: false }, { isResolved: true }],
      pageInfo: {
        hasNextPage: Boolean(options.hasMoreThreads),
        endCursor: options.hasMoreThreads ? "thread-cursor" : null,
      },
    },
  };
}

beforeEach(() => {
  state.apiToken = "secret-token";
  vi.unstubAllGlobals();
});

describe("GitHub service", () => {
  test("validates repository names and Jira regex extraction", () => {
    expect(normalizeGitHubRepositoryName(" acme/widgets ")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(() => normalizeGitHubRepositoryName("widgets")).toThrow(
      "owner/name",
    );
    expect(normalizeJiraKeyRegex("")).toBeNull();
    expect(() => normalizeJiraKeyRegex("[")).toThrow("invalid");
    expect(parseJiraKey("ship app-42 now", String.raw`\b([A-Z]+-\d+)\b`)).toBe(
      "APP-42",
    );
    expect(parseJiraKey("ship APP-42", null)).toBeNull();
  });

  test("deduplicates Mine results, normalizes badges, parses Jira, and paginates unresolved threads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("query GitHubViewer")) {
        return response({
          data: {
            viewer: {
              login: "octocat",
              name: "Octo Cat",
              avatarUrl: "https://avatars.example/octocat",
              url: "https://github.com/octocat",
            },
          },
        });
      }
      if (body.query.includes("GitHubPullRequestReviewThreads")) {
        return response({
          data: {
            node: {
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (body.query.includes("GitHubPullRequestSearch")) {
        const authored = String(body.variables.query).includes("author:");
        return response({
          data: {
            search: {
              nodes: authored
                ? [
                    rawPullRequest("pull-request-1", "APP-42 Add API", {
                      hasMoreThreads: true,
                      pipeline: "SUCCESS",
                      reviewDecision: "APPROVED",
                    }),
                  ]
                : [
                    rawPullRequest("pull-request-1", "APP-42 Add API", {
                      hasMoreThreads: true,
                      pipeline: "SUCCESS",
                      reviewDecision: "APPROVED",
                    }),
                    rawPullRequest("pull-request-2", "Maintenance"),
                  ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubService().pullRequests("MINE");

    expect(result.truncated).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      id: "pull-request-1",
      jiraKey: "APP-42",
      labels: ["backend"],
      pipelineStatus: "SUCCESS",
      pipelines: [
        {
          id: "check-suite-1",
          name: "CI",
          status: "SUCCESS",
          url: "https://github.com/acme/widgets/actions/runs/1",
          checkSuiteId: "check-suite-1",
          canRetry: true,
        },
      ],
      reviewDecision: "APPROVED",
      unresolvedReviewThreadCount: 2,
    });
    expect(result.items[1]).toMatchObject({
      jiraKey: null,
      pipelineStatus: "NONE",
      reviewDecision: "NONE",
    });
    const authorizationHeaders = fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).authorization,
    );
    expect(
      authorizationHeaders.every((value) => value === "Bearer secret-token"),
    ).toBe(true);
  });

  test("requires credentials and redacts a token echoed by GitHub", async () => {
    state.apiToken = null;
    await expect(new GitHubService().testConnection()).rejects.toThrow(
      "not configured",
    );

    state.apiToken = "secret-token";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ errors: [{ message: "bad secret-token" }] }),
        ),
    );
    await expect(new GitHubService().testConnection()).rejects.toThrow(
      "bad [REDACTED]",
    );
  });

  test("loads pull request details and rerequests a check suite", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("query GitHubPullRequestDetail")) {
        return response({
          data: {
            repository: {
              pullRequest: {
                ...rawPullRequest("pull-request-1", "APP-42 Add API", {
                  pipeline: "SUCCESS",
                  reviewDecision: "APPROVED",
                }),
                body: "Detailed description",
                author: {
                  login: "octocat",
                  avatarUrl: "https://avatars.example/octocat",
                  url: "https://github.com/octocat",
                },
                assignees: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                baseRefName: "main",
                headRefName: "feature/app-42",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                additions: 20,
                deletions: 5,
                changedFiles: 3,
                commits: { totalCount: 2 },
                mergedAt: null,
              },
            },
          },
        });
      }
      if (body.query.includes("mutation GitHubRetryPipeline")) {
        return response({
          data: {
            rerequestCheckSuite: {
              checkSuite: {
                id: "check-suite-1",
                status: "QUEUED",
                conclusion: null,
                url: "https://github.com/acme/widgets/checks",
                app: { name: "GitHub Actions" },
                workflowRun: {
                  url: "https://github.com/acme/widgets/actions/runs/1",
                  runNumber: 1,
                  workflow: { name: "CI" },
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GitHubService().pullRequest("acme", "widgets", 17),
    ).resolves.toMatchObject({
      body: "Detailed description",
      author: { login: "octocat" },
      baseRefName: "main",
      headRefName: "feature/app-42",
      changedFiles: 3,
      commitCount: 2,
      pipelines: [{ name: "CI", status: "SUCCESS" }],
    });
    await expect(
      new GitHubService().retryPipeline("repository-1", "check-suite-1"),
    ).resolves.toMatchObject({
      id: "check-suite-1",
      name: "CI",
      status: "QUEUED",
      canRetry: false,
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.github.com/graphql",
      expect.objectContaining({
        body: expect.stringContaining('"checkSuiteId":"check-suite-1"'),
      }),
    );
  });
});
