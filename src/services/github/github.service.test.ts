import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  apiToken: "secret-token" as string | null,
  appSettings: {
    id: "default",
    appId: "123",
    installationId: "456",
    privateKey: "stored-private-key",
    apiBaseUrl: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    keyFingerprint: "SHA256:fingerprint",
    appSlug: "workflow-rerunner",
    accountLogin: "acme",
    repositorySelection: "selected",
    actionsPermission: "write",
    verifiedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as {
    id: string;
    appId: string;
    installationId: string;
    privateKey: string;
    apiBaseUrl: string;
    graphqlUrl: string;
    keyFingerprint: string;
    appSlug: string;
    accountLogin: string;
    repositorySelection: string;
    actionsPermission: string;
    verifiedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  } | null,
  auditEvents: [] as Array<Record<string, unknown>>,
  linkedCodebaseRepository: null as {
    id: string;
    canonicalOrigin: string;
  } | null,
  linkedWorktree: null as { id: string; branch: string } | null,
  codebaseRepositoryOrigins: [] as string[],
  codebaseRepositories: [
    {
      id: "codebase-repository-1",
      canonicalOrigin: "github.com/acme/widgets",
      name: "widgets",
      jiraBranchRegex: String.raw`\b([A-Z]+-\d+)\b`,
    },
  ] as Array<{
    id: string;
    canonicalOrigin: string;
    name: string;
    jiraBranchRegex: string | null;
  }>,
  worktrees: [] as Array<{
    id: string;
    branch: string | null;
    updatedAt: Date;
    codebase: { repositoryId: string };
  }>,
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

const appClient = vi.hoisted(() => ({
  clearTokenCache: vi.fn(),
  graphql: vi.fn(),
  listJobs: vi.fn(),
  rerun: vi.fn(),
  rerunJob: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/server/github/github-app", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/server/github/github-app")>();
  return {
    ...original,
    clearGitHubAppTokenCache: appClient.clearTokenCache,
    githubAppGraphql: appClient.graphql,
    listGitHubActionsWorkflowJobs: appClient.listJobs,
    rerunGitHubActionsJob: appClient.rerunJob,
    rerunGitHubActionsWorkflow: appClient.rerun,
    verifyGitHubAppConfiguration: appClient.verify,
  };
});

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    gitHubSettings: {
      findUnique: async () =>
        state.apiToken
          ? {
              id: "default",
              apiToken: state.apiToken,
              defaultJiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b`,
            }
          : null,
    },
    gitHubRepository: {
      findMany: async () => state.repositories,
      findUnique: async ({ where }: { where: { githubId?: string } }) =>
        state.repositories.find(
          (repository) => repository.githubId === where.githubId,
        ) ?? null,
    },
    codebaseRepository: {
      findMany: async () => state.codebaseRepositories,
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.codebaseRepositories.find(
          (repository) => repository.id === where.id,
        ) ?? null,
      findFirst: async ({ where }: { where: { canonicalOrigin: string } }) => {
        state.codebaseRepositoryOrigins.push(where.canonicalOrigin);
        return state.linkedCodebaseRepository?.canonicalOrigin ===
          where.canonicalOrigin
          ? { id: state.linkedCodebaseRepository.id }
          : null;
      },
    },
    worktree: {
      findMany: async ({ where }: { where: { codebase?: unknown } }) =>
        where.codebase
          ? [...state.worktrees].sort(
              (left, right) =>
                right.updatedAt.getTime() - left.updatedAt.getTime(),
            )
          : [],
      findFirst: async ({ where }: { where: { branch: string } }) =>
        state.linkedWorktree?.branch === where.branch
          ? { id: state.linkedWorktree.id }
          : null,
    },
    codebaseSettings: {
      findUnique: async () => ({
        id: "default",
        defaultJiraBranchRegex: String.raw`\b([A-Z]+-\d+)\b`,
      }),
    },
    gitHubAppSettings: {
      findUnique: async () => state.appSettings,
      upsert: async ({
        create,
        update,
      }: {
        create: object;
        update: object;
      }) => {
        const now = new Date();
        state.appSettings = state.appSettings
          ? { ...state.appSettings, ...update, updatedAt: now }
          : ({ ...create, createdAt: now, updatedAt: now } as NonNullable<
              typeof state.appSettings
            >);
        return state.appSettings;
      },
      update: async ({ data }: { data: object }) => {
        if (!state.appSettings) throw new Error("Missing settings");
        state.appSettings = {
          ...state.appSettings,
          ...data,
          updatedAt: new Date(),
        };
        return state.appSettings;
      },
      deleteMany: async () => {
        state.appSettings = null;
        return { count: 1 };
      },
    },
    gitHubAuditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.auditEvents.push(data);
        return data;
      },
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
    headRefName: "feature/app-42",
    headRepository: { nameWithOwner: "acme/widgets" },
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
                  app: { name: "GitHub Actions", slug: "github-actions" },
                  workflowRun: {
                    databaseId: "1",
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

function rawActionsWorkflowRun(
  id: number,
  repository: string,
  createdAt: string,
  options: {
    branch?: string | null;
    conclusion?: string | null;
    displayTitle?: string;
    pullRequests?: number[];
    status?: string;
  } = {},
) {
  const [, name] = repository.split("/");
  return {
    id,
    name: "CI",
    display_title: options.displayTitle ?? `Run ${id}`,
    run_number: id,
    run_attempt: 1,
    event: "pull_request",
    status: options.status ?? "completed",
    conclusion: options.conclusion ?? "success",
    html_url: `https://github.com/${repository}/actions/runs/${id}`,
    head_branch: options.branch ?? "feature/APP-42",
    head_sha: `sha-${id}`,
    check_suite_node_id: `check-suite-${id}`,
    repository: {
      node_id: `repository-${name}`,
      full_name: repository,
      html_url: `https://github.com/${repository}`,
    },
    pull_requests: (options.pullRequests ?? []).map((number) => ({ number })),
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function rawReviewThread(
  id: string,
  options: {
    resolved?: boolean;
    author?: string;
    createdAt?: string;
    hasMoreComments?: boolean;
    pullRequestId?: string;
    pullRequestNumber?: number;
  } = {},
) {
  const pullRequestId = options.pullRequestId ?? "review-pull-request-1";
  const pullRequestNumber = options.pullRequestNumber ?? 21;
  return {
    id,
    isResolved: options.resolved ?? false,
    isOutdated: false,
    subjectType: "LINE",
    path: "src/index.ts",
    line: 12,
    startLine: 10,
    originalLine: 11,
    originalStartLine: 9,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    resolvedBy: null,
    pullRequest: {
      id: pullRequestId,
      number: pullRequestNumber,
      title: `Review pull request ${pullRequestNumber}`,
      url: `https://github.com/acme/widgets/pull/${pullRequestNumber}`,
      repository: { nameWithOwner: "acme/widgets" },
    },
    comments: {
      nodes: [
        {
          id: `${id}-root`,
          body: `Root ${id}`,
          bodyText: `Root ${id}`,
          bodyHTML: `<p>Root ${id}</p>`,
          url: `https://github.com/acme/widgets/pull/${pullRequestNumber}#discussion_r1`,
          author: {
            login: options.author ?? "reviewer",
            avatarUrl: "https://avatars.example/reviewer",
            url: "https://github.com/reviewer",
          },
          createdAt: options.createdAt ?? "2026-07-15T00:00:00.000Z",
          updatedAt: options.createdAt ?? "2026-07-15T00:00:00.000Z",
          replyTo: null,
        },
      ],
      pageInfo: {
        hasNextPage: options.hasMoreComments ?? false,
        endCursor: options.hasMoreComments ? "comment-cursor" : null,
      },
    },
  };
}

beforeEach(() => {
  state.apiToken = "secret-token";
  state.repositories = [
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
  ];
  state.appSettings = {
    id: "default",
    appId: "123",
    installationId: "456",
    privateKey: "stored-private-key",
    apiBaseUrl: "https://api.github.com",
    graphqlUrl: "https://api.github.com/graphql",
    keyFingerprint: "SHA256:fingerprint",
    appSlug: "workflow-rerunner",
    accountLogin: "acme",
    repositorySelection: "selected",
    actionsPermission: "write",
    verifiedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  state.auditEvents = [];
  state.linkedCodebaseRepository = null;
  state.linkedWorktree = null;
  state.codebaseRepositoryOrigins = [];
  state.codebaseRepositories = [
    {
      id: "codebase-repository-1",
      canonicalOrigin: "github.com/acme/widgets",
      name: "widgets",
      jiraBranchRegex: String.raw`\b([A-Z]+-\d+)\b`,
    },
  ];
  state.worktrees = [];
  appClient.clearTokenCache.mockReset();
  appClient.graphql.mockReset();
  appClient.graphql.mockResolvedValue({
    data: { repository: { id: "repository-1" } },
    githubRequestId: "GRAPHQL-1",
  });
  appClient.listJobs.mockReset();
  appClient.listJobs.mockResolvedValue([
    {
      id: 11,
      name: "test",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/acme/widgets/actions/runs/1/job/11",
      steps: [
        {
          number: 1,
          name: "Set up job",
          status: "completed",
          conclusion: "success",
        },
        {
          number: 2,
          name: "Run tests",
          status: "completed",
          conclusion: "failure",
        },
      ],
    },
  ]);
  appClient.rerun.mockReset();
  appClient.rerun.mockResolvedValue({ githubRequestId: "REST-1" });
  appClient.rerunJob.mockReset();
  appClient.rerunJob.mockResolvedValue({ githubRequestId: "REST-JOB-1" });
  appClient.verify.mockReset();
  appClient.verify.mockImplementation(async (credentials) => ({
    appId: credentials.appId.trim(),
    installationId: credentials.installationId.trim(),
    keyFingerprint: "SHA256:new-fingerprint",
    appSlug: "workflow-rerunner",
    accountLogin: "acme",
    repositorySelection: "selected",
    actionsPermission: "write",
    viewerLogin: "workflow-rerunner[bot]",
    verifiedAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
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

  test("merges and paginates workflow runs across unique GitHub codebases", async () => {
    state.codebaseRepositories = [
      ...state.codebaseRepositories,
      {
        id: "codebase-repository-2",
        canonicalOrigin: "github.com/acme/platform",
        name: "platform",
        jiraBranchRegex: String.raw`\b([A-Z]+-\d+)\b`,
      },
      {
        id: "codebase-repository-3",
        canonicalOrigin: "gitlab.com/acme/ignored",
        name: "ignored",
        jiraBranchRegex: null,
      },
    ];
    state.worktrees = [
      {
        id: "worktree-old",
        branch: "feature/APP-42",
        updatedAt: new Date("2026-07-14T00:00:00.000Z"),
        codebase: { repositoryId: "codebase-repository-1" },
      },
      {
        id: "worktree-new",
        branch: "feature/APP-42",
        updatedAt: new Date("2026-07-16T00:00:00.000Z"),
        codebase: { repositoryId: "codebase-repository-1" },
      },
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/repos/acme/widgets/actions/runs")) {
        return response({
          total_count: 2,
          workflow_runs: [
            rawActionsWorkflowRun(
              1,
              "acme/widgets",
              "2026-07-16T12:00:00.000Z",
              { displayTitle: "Build branch", pullRequests: [17] },
            ),
            rawActionsWorkflowRun(
              3,
              "acme/widgets",
              "2026-07-14T12:00:00.000Z",
            ),
          ],
        });
      }
      if (url.includes("/repos/acme/platform/actions/runs")) {
        return response({
          total_count: 1,
          workflow_runs: [
            rawActionsWorkflowRun(
              2,
              "acme/platform",
              "2026-07-17T12:00:00.000Z",
              { displayTitle: "APP-99 Ship platform", branch: "main" },
            ),
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new GitHubService();
    const firstPage = await service.actionsWorkflowRuns(null, 2);

    expect(firstPage.repositories.map((item) => item.nameWithOwner)).toEqual([
      "acme/platform",
      "acme/widgets",
    ]);
    expect(firstPage.items.map((item) => item.id)).toEqual(["2", "1"]);
    expect(firstPage.items[0]).toMatchObject({
      jiraKey: "APP-99",
      repositoryNameWithOwner: "acme/platform",
      canRetry: true,
    });
    expect(firstPage.items[1]).toMatchObject({
      jiraKey: "APP-42",
      worktreeId: "worktree-new",
      pullRequests: [
        {
          number: 17,
          url: "https://github.com/acme/widgets/pull/17",
        },
      ],
    });
    expect(firstPage.hasNextPage).toBe(true);
    expect(firstPage.endCursor).toBeTruthy();

    const secondPage = await service.actionsWorkflowRuns(
      null,
      2,
      firstPage.endCursor,
    );
    expect(secondPage.items.map((item) => item.id)).toEqual(["3"]);
    expect(secondPage.hasNextPage).toBe(false);
  });

  test("isolates inaccessible workflow repositories and validates filter cursors", async () => {
    state.codebaseRepositories = [
      ...state.codebaseRepositories,
      {
        id: "codebase-repository-2",
        canonicalOrigin: "github.com/acme/private",
        name: "private",
        jiraBranchRegex: null,
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/repos/acme/private/")
          ? response({ message: "Resource not accessible by token" }, 403)
          : response({ total_count: 0, workflow_runs: [] }),
      ),
    );

    const page = await new GitHubService().actionsWorkflowRuns(null, 25);
    expect(page.items).toEqual([]);
    expect(page.repositoryErrors).toEqual([
      expect.objectContaining({
        codebaseRepositoryId: "codebase-repository-2",
        nameWithOwner: "acme/private",
        message: "Resource not accessible by token",
      }),
    ]);
    await expect(
      new GitHubService().actionsWorkflowRuns(
        "codebase-repository-1",
        25,
        Buffer.from(
          JSON.stringify({
            version: 1,
            codebaseRepositoryId: null,
            consumed: {},
          }),
        ).toString("base64url"),
      ),
    ).rejects.toThrow("cursor");
  });

  test("loads workflow jobs through the PAT and reserves retries for the App", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/actions/runs/44/jobs");
      return response({
        total_count: 1,
        jobs: [
          {
            id: 441,
            name: "test",
            status: "completed",
            conclusion: "failure",
            html_url: "https://github.com/acme/widgets/actions/runs/44/job/441",
            steps: [
              {
                number: 1,
                name: "Run tests",
                status: "completed",
                conclusion: "failure",
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = new GitHubService();
    await expect(
      service.actionsWorkflowJobs("codebase-repository-1", "44"),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "441",
        status: "FAILURE",
        canRetry: true,
        steps: [{ number: 1, name: "Run tests", status: "FAILURE" }],
      }),
    ]);
    expect(appClient.listJobs).not.toHaveBeenCalled();

    state.appSettings = null;
    const jobs = await service.actionsWorkflowJobs(
      "codebase-repository-1",
      "44",
    );
    expect(jobs[0]).toMatchObject({
      canRetry: false,
      retryUnavailableReason: "GITHUB_APP_NOT_CONFIGURED",
    });
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

  test("loads every linked PR scope, deduplicates, paginates, and normalizes review threads", async () => {
    const firstThread = rawReviewThread("thread-1", { author: "octocat" });
    const secondThread = rawReviewThread("thread-2", {
      createdAt: "2026-07-16T00:00:00.000Z",
      hasMoreComments: true,
    });
    const reviewPullRequest = {
      id: "review-pull-request-1",
      number: 21,
      title: "Review pull request 21",
      url: "https://github.com/acme/widgets/pull/21",
      updatedAt: "2026-07-16T00:00:00.000Z",
      repository: { nameWithOwner: "acme/widgets" },
      reviewThreads: {
        nodes: [firstThread],
        pageInfo: { hasNextPage: true, endCursor: "thread-cursor" },
      },
    };
    const emptyPullRequest = {
      id: "review-pull-request-2",
      number: 22,
      title: "Review pull request 22",
      url: "https://github.com/acme/widgets/pull/22",
      updatedAt: "2026-07-15T00:00:00.000Z",
      repository: { nameWithOwner: "acme/widgets" },
      reviewThreads: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
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
      if (body.query.includes("GitHubReviewThreadPullRequestSearch")) {
        const authored = String(body.variables.query).includes("author:");
        return response({
          data: {
            search: {
              nodes: authored
                ? [reviewPullRequest]
                : [reviewPullRequest, emptyPullRequest],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (body.query.includes("GitHubPullRequestReviewThreadDetails")) {
        return response({
          data: {
            node: {
              reviewThreads: {
                nodes: [secondThread],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      if (body.query.includes("GitHubReviewThreadComments")) {
        return response({
          data: {
            node: {
              comments: {
                nodes: [
                  {
                    id: "thread-2-reply",
                    body: "Reply",
                    bodyText: "Reply",
                    bodyHTML: "<p>Reply</p>",
                    url: "https://github.com/acme/widgets/pull/21#discussion_r2",
                    author: null,
                    createdAt: "2026-07-16T01:00:00.000Z",
                    updatedAt: "2026-07-16T01:00:00.000Z",
                    replyTo: { id: "thread-2-root" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubService().reviewThreads();

    expect(result).toMatchObject({
      viewerLogin: "octocat",
      truncated: false,
      pullRequests: [
        { id: "review-pull-request-1", number: 21 },
        { id: "review-pull-request-2", number: 22 },
      ],
    });
    expect(result.threads.map((thread) => thread.id)).toEqual([
      "thread-2",
      "thread-1",
    ]);
    expect(result.threads[0]).toMatchObject({
      path: "src/index.ts",
      line: 12,
      startLine: 10,
      rootComment: { bodyHtml: "<p>Root thread-2</p>" },
      replies: [{ id: "thread-2-reply", author: null }],
      pullRequest: {
        repositoryNameWithOwner: "acme/widgets",
        number: 21,
      },
    });
    const searchQueries = fetchMock.mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      return body.query.includes("GitHubReviewThreadPullRequestSearch")
        ? [String(body.variables.query)]
        : [];
    });
    expect(searchQueries).toHaveLength(4);
    expect(searchQueries).toEqual(
      expect.arrayContaining([
        "is:pr is:open author:octocat sort:updated-desc",
        "is:pr is:open assignee:octocat sort:updated-desc",
        "is:pr is:open review-requested:octocat sort:updated-desc",
        "is:pr is:open repo:acme/widgets sort:updated-desc",
      ]),
    );
  });

  test("replies with exact Markdown and resolves or reopens review threads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("ReplyToGitHubReviewThread")) {
        return response({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                ...rawReviewThread("thread-1").comments.nodes[0],
                id: "reply-1",
                body: String(body.variables.body),
                bodyText: "Indented reply",
                bodyHTML: "<p>Indented reply</p>",
                replyTo: { id: "thread-1-root" },
              },
            },
          },
        });
      }
      const resolved = body.query.includes("ResolveGitHubReviewThread");
      if (resolved || body.query.includes("ReopenGitHubReviewThread")) {
        const field = resolved
          ? "resolveReviewThread"
          : "unresolveReviewThread";
        return response({
          data: {
            [field]: {
              thread: {
                id: "thread-1",
                isResolved: resolved,
                viewerCanResolve: !resolved,
                viewerCanUnresolve: resolved,
                resolvedBy: resolved
                  ? {
                      login: "octocat",
                      avatarUrl: "https://avatars.example/octocat",
                      url: "https://github.com/octocat",
                    }
                  : null,
              },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new GitHubService();

    await expect(
      service.replyToReviewThread("thread-1", "  Indented reply  "),
    ).resolves.toMatchObject({ id: "reply-1", body: "  Indented reply  " });
    await expect(
      service.replyToReviewThread("thread-1", "   "),
    ).rejects.toThrow("reply");
    await expect(
      service.setReviewThreadResolved("thread-1", true),
    ).resolves.toMatchObject({ id: "thread-1", isResolved: true });
    await expect(
      service.setReviewThreadResolved("thread-1", false),
    ).resolves.toMatchObject({ id: "thread-1", isResolved: false });
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        String(init?.body).includes('"body":"  Indented reply  "'),
      ),
    ).toBe(true);
  });

  test("hydrates workflow jobs for pull request list queries that request them", async () => {
    state.appSettings = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/actions/runs/1/jobs")) {
        return response({
          total_count: 1,
          jobs: [
            {
              id: 11,
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/widgets/actions/runs/1/job/11",
              steps: [
                {
                  number: 1,
                  name: "Set up job",
                  status: "completed",
                  conclusion: "success",
                },
                {
                  number: 2,
                  name: "Run tests",
                  status: "completed",
                  conclusion: "failure",
                },
              ],
            },
          ],
        });
      }
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("query GitHubRepositoryPullRequests")) {
        return response({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  rawPullRequest("pull-request-1", "APP-42 Add API", {
                    pipeline: "FAILURE",
                  }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GitHubService().pullRequests(
      "REPOSITORY",
      "local-repository-1",
      { includePipelineJobs: true },
    );

    expect(result.items[0]?.pipelines[0]?.jobs).toEqual([
      expect.objectContaining({
        id: "11",
        name: "test",
        status: "FAILURE",
        canRetry: false,
        steps: [
          expect.objectContaining({ name: "Set up job", status: "SUCCESS" }),
          expect.objectContaining({ name: "Run tests", status: "FAILURE" }),
        ],
      }),
    ]);
    expect(appClient.listJobs).not.toHaveBeenCalled();
    expect(
      (
        fetchMock.mock.calls.find(([url]) =>
          url.includes("/actions/runs/1/jobs"),
        )?.[1]?.headers as Record<string, string>
      ).authorization,
    ).toBe("Bearer secret-token");
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

  test("reruns an installed GitHub Actions workflow without a managed repository", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/actions/runs/1/jobs")) {
        return response({
          total_count: 1,
          jobs: [
            {
              id: 11,
              name: "test",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/acme/widgets/actions/runs/1/job/11",
              steps: [
                {
                  number: 1,
                  name: "Set up job",
                  status: "completed",
                  conclusion: "success",
                },
                {
                  number: 2,
                  name: "Run tests",
                  status: "completed",
                  conclusion: "failure",
                },
              ],
            },
          ],
        });
      }
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
                bodyHTML: "<p>Detailed description</p>",
                author: {
                  login: "octocat",
                  avatarUrl: "https://avatars.example/octocat",
                  url: "https://github.com/octocat",
                },
                assignees: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviewThreadsFull: {
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
      if (
        body.query.includes("query GitHubRetryPipelineCheckSuite") ||
        body.query.includes("query GitHubRetryWorkflowJobCheckSuite")
      ) {
        return response({
          data: {
            node: {
              id: "check-suite-1",
              status: "COMPLETED",
              conclusion: "FAILURE",
              url: "https://github.com/acme/widgets/checks",
              app: { name: "GitHub Actions", slug: "github-actions" },
              repository: {
                id: "repository-1",
                name: "widgets",
                owner: { login: "acme" },
              },
              workflowRun: {
                databaseId: "987",
                url: "https://github.com/acme/widgets/actions/runs/987",
                runNumber: 1,
                workflow: { name: "CI" },
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
      bodyHtml: "<p>Detailed description</p>",
      reviewThreads: [],
      author: { login: "octocat" },
      baseRefName: "main",
      headRefName: "feature/app-42",
      changedFiles: 3,
      commitCount: 2,
      pipelines: [
        {
          name: "CI",
          status: "SUCCESS",
          jobs: [
            {
              id: "11",
              name: "test",
              status: "FAILURE",
              canRetry: true,
              steps: [
                { number: 1, name: "Set up job", status: "SUCCESS" },
                { number: 2, name: "Run tests", status: "FAILURE" },
              ],
            },
          ],
        },
      ],
    });
    expect(appClient.listJobs).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "123", installationId: "456" }),
      { owner: "acme", repository: "widgets", workflowRunId: "1" },
    );
    state.repositories = [];
    await expect(
      new GitHubService().retryPipeline("repository-1", "check-suite-1", {
        actor: "control-plane",
        ipAddress: "127.0.0.1",
      }),
    ).resolves.toMatchObject({
      id: "check-suite-1",
      name: "CI",
      status: "QUEUED",
      canRetry: false,
    });
    expect(appClient.graphql).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: "456" }),
      expect.stringContaining("VerifyGitHubAppRepository"),
      { owner: "acme", name: "widgets" },
    );
    expect(appClient.rerun).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "123" }),
      { owner: "acme", repository: "widgets", workflowRunId: "987" },
    );
    expect(state.auditEvents).toContainEqual(
      expect.objectContaining({
        operation: "GITHUB_ACTIONS_WORKFLOW_RERUN",
        githubRequestId: "REST-1",
        outcome: "SUCCESS",
      }),
    );
    await expect(
      new GitHubService().retryWorkflowJob(
        "repository-1",
        "check-suite-1",
        "11",
        {
          actor: "control-plane",
          ipAddress: "127.0.0.1",
        },
      ),
    ).resolves.toBe(true);
    expect(appClient.rerunJob).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "123" }),
      {
        owner: "acme",
        repository: "widgets",
        workflowRunId: "987",
        jobId: "11",
      },
    );
    expect(state.auditEvents).toContainEqual(
      expect.objectContaining({
        operation: "GITHUB_ACTIONS_JOB_RERUN",
        jobId: "11",
        githubRequestId: "REST-JOB-1",
        outcome: "SUCCESS",
      }),
    );
    appClient.rerunJob.mockRejectedValueOnce(new Error("rerun failed"));
    await expect(
      new GitHubService().retryWorkflowJob(
        "repository-1",
        "check-suite-1",
        "12",
        {
          actor: "control-plane",
          ipAddress: "127.0.0.1",
        },
      ),
    ).rejects.toThrow("rerun failed");
    expect(state.auditEvents).toContainEqual(
      expect.objectContaining({
        operation: "GITHUB_ACTIONS_JOB_RERUN",
        jobId: "12",
        outcome: "FAILURE",
      }),
    );
  });

  test("links pull requests to worktrees in the normalized head repository", async () => {
    let headRepository: { nameWithOwner: string } | null = {
      nameWithOwner: "ForkOwner/MixedRepo",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (!body.query.includes("query GitHubPullRequestDetail")) {
          throw new Error(`Unexpected query: ${body.query}`);
        }
        return response({
          data: {
            repository: {
              pullRequest: {
                ...rawPullRequest("pull-request-1", "APP-42 Add API"),
                headRepository,
                body: "",
                bodyHTML: "",
                author: null,
                assignees: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                reviewThreadsFull: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
                baseRefName: "main",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                additions: 1,
                deletions: 0,
                changedFiles: 1,
                commits: { totalCount: 1 },
                mergedAt: null,
              },
            },
          },
        });
      }),
    );
    state.linkedCodebaseRepository = {
      id: "fork-repository",
      canonicalOrigin: "github.com/forkowner/mixedrepo",
    };
    state.linkedWorktree = {
      id: "fork-worktree",
      branch: "feature/app-42",
    };
    const service = new GitHubService();

    await expect(
      service.pullRequest("acme", "widgets", 17),
    ).resolves.toMatchObject({ worktreeId: "fork-worktree" });
    expect(state.codebaseRepositoryOrigins).toEqual([
      "github.com/forkowner/mixedrepo",
    ]);

    state.codebaseRepositoryOrigins = [];
    headRepository = null;
    await expect(
      service.pullRequest("acme", "widgets", 17),
    ).resolves.toMatchObject({ worktreeId: null });
    expect(state.codebaseRepositoryOrigins).toEqual([]);
  });

  test("keeps the App private key write-only and verifies before replacing settings", async () => {
    const service = new GitHubService();
    await expect(
      service.saveAppSettings(
        { appId: "123", installationId: "789", privateKey: null },
        { actor: "control-plane", ipAddress: null },
      ),
    ).resolves.toMatchObject({
      configured: true,
      appId: "123",
      installationId: "789",
      privateKeyConfigured: true,
      keyFingerprint: "SHA256:new-fingerprint",
    });
    expect(appClient.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        privateKey: "stored-private-key",
        installationId: "789",
      }),
    );
    expect(await service.getAppSettings()).not.toHaveProperty("privateKey");

    await expect(
      service.saveAppSettings(
        { appId: "999", installationId: "789", privateKey: null },
        { actor: "control-plane", ipAddress: null },
      ),
    ).rejects.toThrow("replacement private key");
    expect(state.appSettings?.appId).toBe("123");
  });

  test("rejects suites outside the managed repository before using App credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: {
            node: {
              id: "check-suite-1",
              status: "COMPLETED",
              conclusion: "FAILURE",
              url: "https://github.com/checks/1",
              app: { name: "GitHub Actions", slug: "github-actions" },
              repository: {
                id: "different-repository",
                name: "widgets",
                owner: { login: "acme" },
              },
              workflowRun: {
                databaseId: "987",
                url: "https://github.com/actions/runs/987",
                runNumber: 1,
                workflow: { name: "CI" },
              },
            },
          },
        }),
      ),
    );

    await expect(
      new GitHubService().retryPipeline("repository-1", "check-suite-1", {
        actor: "control-plane",
        ipAddress: null,
      }),
    ).rejects.toThrow("does not belong");
    expect(appClient.rerun).not.toHaveBeenCalled();
    expect(state.auditEvents).toContainEqual(
      expect.objectContaining({
        errorCode: "CHECK_SUITE_REPOSITORY_MISMATCH",
        outcome: "FAILURE",
      }),
    );
  });

  test.each([
    ["NOT_GITHUB_ACTIONS", { app: { name: "CircleCI", slug: "circleci" } }],
    ["WORKFLOW_NOT_COMPLETED", { status: "IN_PROGRESS" }],
    ["WORKFLOW_RUN_UNAVAILABLE", { workflowRun: null }],
  ])("rejects an unsafe workflow with %s", async (errorCode, override) => {
    const checkSuite = {
      id: "check-suite-1",
      status: "COMPLETED",
      conclusion: "FAILURE",
      url: "https://github.com/acme/widgets/checks/1",
      app: { name: "GitHub Actions", slug: "github-actions" },
      repository: {
        id: "repository-1",
        name: "widgets",
        owner: { login: "acme" },
      },
      workflowRun: {
        databaseId: "987",
        url: "https://github.com/acme/widgets/actions/runs/987",
        runNumber: 1,
        workflow: { name: "CI" },
      },
      ...override,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ data: { node: checkSuite } })),
    );

    await expect(
      new GitHubService().retryPipeline("repository-1", "check-suite-1", {
        actor: "control-plane",
        ipAddress: null,
      }),
    ).rejects.toMatchObject({ code: errorCode });
    expect(appClient.rerun).not.toHaveBeenCalled();
    expect(state.auditEvents).toContainEqual(
      expect.objectContaining({ errorCode, outcome: "FAILURE" }),
    );
  });

  test("rejects repositories that are not installed for the configured App", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: {
            node: {
              id: "check-suite-1",
              status: "COMPLETED",
              conclusion: "FAILURE",
              url: "https://github.com/acme/widgets/checks/1",
              app: { name: "GitHub Actions", slug: "github-actions" },
              repository: {
                id: "repository-1",
                name: "widgets",
                owner: { login: "acme" },
              },
              workflowRun: {
                databaseId: "987",
                url: "https://github.com/acme/widgets/actions/runs/987",
                runNumber: 1,
                workflow: { name: "CI" },
              },
            },
          },
        }),
      ),
    );
    appClient.graphql.mockResolvedValue({
      data: { repository: null },
      githubRequestId: "GRAPHQL-404",
    });

    await expect(
      new GitHubService().retryPipeline("repository-1", "check-suite-1", {
        actor: "control-plane",
        ipAddress: null,
      }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_INSTALLED" });
    expect(appClient.rerun).not.toHaveBeenCalled();
  });

  test("requires a verified GitHub App before rerunning", async () => {
    state.appSettings = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: {
            node: {
              id: "check-suite-1",
              status: "COMPLETED",
              conclusion: "FAILURE",
              url: "https://github.com/acme/widgets/checks/1",
              app: { name: "GitHub Actions", slug: "github-actions" },
              repository: {
                id: "repository-1",
                name: "widgets",
                owner: { login: "acme" },
              },
              workflowRun: {
                databaseId: "987",
                url: "https://github.com/acme/widgets/actions/runs/987",
                runNumber: 1,
                workflow: { name: "CI" },
              },
            },
          },
        }),
      ),
    );

    await expect(
      new GitHubService().retryPipeline("repository-1", "check-suite-1", {
        actor: "control-plane",
        ipAddress: null,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_APP_NOT_CONFIGURED" });
    expect(appClient.rerun).not.toHaveBeenCalled();
  });

  test("loads enabled merge methods and merges with verified commit details", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/user/emails")) {
        return response([
          { email: "octocat@example.com", verified: true, primary: true },
          {
            email: "unverified@example.com",
            verified: false,
            primary: false,
          },
        ]);
      }
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("query GitHubPullRequestMergeOptions")) {
        return response({
          data: {
            viewer: { email: "octocat@example.com" },
            repository: {
              mergeCommitAllowed: true,
              rebaseMergeAllowed: false,
              squashMergeAllowed: true,
              viewerPermission: "WRITE",
              pullRequest: {
                id: "pull-request-1",
                title: "APP-42 Add API",
                body: "Detailed description",
                url: "https://github.com/acme/widgets/pull/17",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                headRefOid: "head-oid-1",
              },
            },
          },
        });
      }
      if (body.query.includes("mutation MergeGitHubPullRequest")) {
        expect(body.variables).toEqual({
          pullRequestId: "pull-request-1",
          method: "SQUASH",
          commitHeadline: "APP-42 Ship API",
          commitBody: "Release notes",
          authorEmail: "octocat@example.com",
          expectedHeadOid: "head-oid-1",
        });
        return response({
          data: {
            mergePullRequest: {
              pullRequest: {
                id: "pull-request-1",
                state: "MERGED",
                url: "https://github.com/acme/widgets/pull/17",
                mergedAt: "2026-07-17T00:00:00.000Z",
              },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new GitHubService();

    await expect(
      service.pullRequestMergeOptions("acme", "widgets", 17),
    ).resolves.toEqual({
      availableMethods: ["SQUASH", "MERGE"],
      commitEmails: ["octocat@example.com"],
      defaultCommitEmail: "octocat@example.com",
      defaultCommitHeadline: "APP-42 Add API",
      defaultCommitBody: "Detailed description",
      canMerge: true,
      blockedReason: null,
    });
    await expect(
      service.mergePullRequest({
        owner: "acme",
        name: "widgets",
        number: 17,
        method: "SQUASH",
        commitHeadline: "APP-42 Ship API",
        commitBody: "Release notes",
        authorEmail: "octocat@example.com",
      }),
    ).resolves.toMatchObject({ state: "MERGED" });
  });

  test("reports unmet GitHub merge requirements before mutation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/user/emails")) return response([]);
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("query GitHubPullRequestMergeOptions")) {
          return response({
            data: {
              viewer: { email: "" },
              repository: {
                mergeCommitAllowed: true,
                rebaseMergeAllowed: true,
                squashMergeAllowed: true,
                viewerPermission: "WRITE",
                pullRequest: {
                  id: "pull-request-1",
                  title: "APP-42 Add API",
                  body: "",
                  url: "https://github.com/acme/widgets/pull/17",
                  state: "OPEN",
                  isDraft: false,
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "BLOCKED",
                  headRefOid: "head-oid-1",
                },
              },
            },
          });
        }
        throw new Error(`Unexpected query: ${body.query}`);
      }),
    );
    const service = new GitHubService();

    await expect(
      service.pullRequestMergeOptions("acme", "widgets", 17),
    ).resolves.toMatchObject({
      canMerge: false,
      blockedReason: expect.stringContaining("Required reviews"),
    });
    await expect(
      service.mergePullRequest({
        owner: "acme",
        name: "widgets",
        number: 17,
        method: "SQUASH",
        commitHeadline: "APP-42 Add API",
        commitBody: "",
      }),
    ).rejects.toThrow("Required reviews");
  });

  test("blocks merge options and mutations for viewers without write access", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/user/emails")) return response([]);
      const body = JSON.parse(String(init?.body)) as { query: string };
      if (body.query.includes("query GitHubPullRequestMergeOptions")) {
        return response({
          data: {
            viewer: { email: "" },
            repository: {
              mergeCommitAllowed: true,
              rebaseMergeAllowed: true,
              squashMergeAllowed: true,
              viewerPermission: "READ",
              pullRequest: {
                id: "pull-request-1",
                title: "APP-42 Add API",
                body: "",
                url: "https://github.com/acme/widgets/pull/17",
                state: "OPEN",
                isDraft: false,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                headRefOid: "head-oid-1",
              },
            },
          },
        });
      }
      throw new Error(`Unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new GitHubService();

    await expect(
      service.pullRequestMergeOptions("acme", "widgets", 17),
    ).resolves.toMatchObject({
      canMerge: false,
      blockedReason: expect.stringContaining("permission"),
    });
    await expect(
      service.mergePullRequest({
        owner: "acme",
        name: "widgets",
        number: 17,
        method: "SQUASH",
        commitHeadline: "APP-42 Add API",
        commitBody: "",
      }),
    ).rejects.toThrow("permission");
    expect(
      fetchMock.mock.calls.some(([, init]) =>
        String(init?.body).includes("mutation MergeGitHubPullRequest"),
      ),
    ).toBe(false);
  });

  test("selects the verified primary email instead of the first sorted email", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/user/emails")) {
          return response([
            { email: "z-primary@example.com", verified: true, primary: true },
            {
              email: "a-secondary@example.com",
              verified: true,
              primary: false,
            },
          ]);
        }
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("query GitHubPullRequestMergeOptions")) {
          return response({
            data: {
              viewer: { email: "" },
              repository: {
                mergeCommitAllowed: false,
                rebaseMergeAllowed: false,
                squashMergeAllowed: true,
                viewerPermission: "WRITE",
                pullRequest: {
                  id: "pull-request-1",
                  title: "APP-42 Add API",
                  body: "",
                  url: "https://github.com/acme/widgets/pull/17",
                  state: "OPEN",
                  isDraft: false,
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  headRefOid: "head-oid-1",
                },
              },
            },
          });
        }
        throw new Error(`Unexpected query: ${body.query}`);
      }),
    );

    await expect(
      new GitHubService().pullRequestMergeOptions("acme", "widgets", 17),
    ).resolves.toMatchObject({
      commitEmails: ["a-secondary@example.com", "z-primary@example.com"],
      defaultCommitEmail: "z-primary@example.com",
    });
  });

  test("preserves verified settings when replacement verification fails", async () => {
    const previous = state.appSettings;
    appClient.verify.mockRejectedValue(new Error("GitHub unavailable"));

    await expect(
      new GitHubService().saveAppSettings(
        {
          appId: "123",
          installationId: "999",
          privateKey: "replacement-private-key",
        },
        { actor: "control-plane", ipAddress: null },
      ),
    ).rejects.toThrow("GitHub unavailable");
    expect(state.appSettings).toEqual(previous);
    expect(state.auditEvents).toContainEqual(
      expect.objectContaining({
        operation: "GITHUB_APP_SETTINGS_SAVE",
        outcome: "FAILURE",
      }),
    );
  });
});
