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
    rerunGitHubActionsJob: appClient.rerunJob,
    rerunGitHubActionsWorkflow: appClient.rerun,
    verifyGitHubAppConfiguration: appClient.verify,
  };
});

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    gitHubSettings: {
      findUnique: async () =>
        state.apiToken ? { id: "default", apiToken: state.apiToken } : null,
    },
    gitHubRepository: {
      findMany: async () => state.repositories,
      findUnique: async ({ where }: { where: { githubId?: string } }) =>
        state.repositories.find(
          (repository) => repository.githubId === where.githubId,
        ) ?? null,
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
  appClient.clearTokenCache.mockReset();
  appClient.graphql.mockReset();
  appClient.graphql.mockResolvedValue({
    data: { repository: { id: "repository-1" } },
    githubRequestId: "GRAPHQL-1",
  });
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
        githubRequestId: "REST-JOB-1",
        outcome: "SUCCESS",
      }),
    );
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
