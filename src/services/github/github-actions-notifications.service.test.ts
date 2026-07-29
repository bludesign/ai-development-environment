import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { GITHUB_REST_OPERATIONS } from "./github-rest-operations";

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  recordRestCall: vi.fn(async () => undefined),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { GitHubActionsNotificationsService } from "./github-actions-notifications.service";

const SECRET = "webhook-secret";

type Observation = {
  status: string;
  conclusion: string | null;
  notifiedAt: Date | null;
  [key: string]: unknown;
};

function workflowPayload(
  conclusion: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    action: "completed",
    installation: { id: 456 },
    repository: {
      node_id: "repository-node-1",
      full_name: "acme/widgets",
      html_url: "https://github.com/acme/widgets",
    },
    workflow_run: {
      id: 101,
      workflow_id: 202,
      run_attempt: 1,
      name: "CI",
      display_title: "Test widgets",
      status: "completed",
      conclusion,
      head_branch: "feature/APP-42",
      head_sha: "abc123",
      pull_requests: [
        {
          number: 42,
          html_url: "https://github.com/acme/widgets/pull/42",
        },
      ],
      html_url: "https://github.com/acme/widgets/actions/runs/101",
      updated_at: "2026-07-22T12:00:00.000Z",
      ...overrides,
    },
  };
}

function githubResponse(runs: Array<Record<string, unknown>>): Response {
  return Response.json({ workflow_runs: runs });
}

function setup(
  workflowEvents?: { record: ReturnType<typeof vi.fn> },
  jiraBranchRegex: string | null = "([A-Z]+-\\d+)",
  enhancedPipelineWebhooksEnabled = false,
  appConfigured = true,
) {
  const deliveries = new Map<string, Record<string, unknown>>();
  const observations = new Map<string, Observation>();
  const pollingStates = new Map<string, Record<string, unknown>>();
  const notification = {
    id: "notification-1",
    typeKey: "GITHUB_ACTIONS_SUCCEEDED",
  };
  const notifications = {
    recordInTransaction: vi.fn(async () => notification),
    created: vi.fn(),
  };
  const polling = {
    register: vi.fn(),
    configure: vi.fn(),
    schedule: vi.fn(),
    run: vi.fn(),
  };
  const credentials = {
    getText: vi.fn(async (descriptor: { id: string }) =>
      descriptor.id.endsWith("webhook-secret") ? SECRET : "personal-token",
    ),
    isConfigured: vi.fn(async (descriptor: { id: string }) =>
      descriptor.id.endsWith("private-key") ? appConfigured : true,
    ),
    getJson: vi.fn(async (descriptor: { id: string }) =>
      descriptor.id.endsWith("/settings") && appConfigured
        ? {
            appId: "123",
            installationId: "456",
            webhookUrl: "https://control.example/api/public/github/webhook",
          }
        : null,
    ),
  };
  const pipelineStatus = {
    observeSnapshot: vi.fn(async () => ({
      snapshot: {},
      changedPipeline: null,
    })),
    observeJobs: vi.fn(async () => null),
  };
  const observationKey = (where: {
    codebaseRepositoryId_workflowRunId_runAttempt: {
      codebaseRepositoryId: string;
      workflowRunId: string;
      runAttempt: number;
    };
  }) => {
    const key = where.codebaseRepositoryId_workflowRunId_runAttempt;
    return `${key.codebaseRepositoryId}:${key.workflowRunId}:${key.runAttempt}`;
  };
  const transaction = {
    gitHubWorkflowRunObservation: {
      findUnique: vi.fn(
        async ({ where }) => observations.get(observationKey(where)) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = observationKey(where);
        const current = observations.get(key);
        const next = current
          ? { ...current, ...update }
          : { ...create, notifiedAt: null };
        observations.set(key, next as Observation);
        return next;
      }),
      update: vi.fn(async ({ where, data }) => {
        const key = observationKey(where);
        const next = { ...observations.get(key)!, ...data };
        observations.set(key, next);
        return next;
      }),
    },
    gitHubActionsPollingState: {
      update: vi.fn(async ({ where, data }) => {
        const next = {
          ...pollingStates.get(where.codebaseRepositoryId),
          ...data,
        };
        pollingStates.set(where.codebaseRepositoryId, next);
        return next;
      }),
    },
    worktree: {
      findFirst: vi.fn(async () => ({
        id: "worktree-1",
        highlightColor: "blue",
        folder: "/repo-feature",
        branch: "feature/APP-42",
        baseBranchOverride: null,
        headSha: "abc123",
        codebase: {
          id: "codebase-1",
          folder: "/repo",
          agentId: "agent-1",
          defaultBranch: "main",
          agent: {
            id: "agent-1",
            name: "Studio Mac",
            hostname: "studio.local",
          },
        },
      })),
    },
  };
  const prisma = {
    codebaseRepository: {
      findMany: vi.fn(async () => [
        {
          id: "repository-1",
          name: "Widgets",
          canonicalOrigin: "github.com/acme/widgets",
          displayOrigin: "github.com/acme/widgets",
          jiraBranchRegex,
        },
      ]),
    },
    worktree: transaction.worktree,
    codebaseSettings: {
      findUnique: vi.fn(async () => ({
        defaultJiraBranchRegex: "([A-Z]+-\\d+)",
      })),
    },
    gitHubAppSettings: {
      findUnique: vi.fn(async () =>
        appConfigured
          ? {
              id: "default",
              installationId: "456",
              enhancedPipelineWebhooksEnabled,
            }
          : null,
      ),
    },
    gitHubWebhookDelivery: {
      create: vi.fn(async ({ data }) => {
        if (deliveries.has(data.deliveryId)) {
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        }
        deliveries.set(data.deliveryId, { ...data });
        return data;
      }),
      update: vi.fn(async ({ where, data }) => {
        const next = { ...deliveries.get(where.deliveryId), ...data };
        deliveries.set(where.deliveryId, next);
        return next;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const current = deliveries.get(where.deliveryId);
        if (
          !current ||
          (where.outcome.notIn as string[]).includes(current.outcome as string)
        ) {
          return { count: 0 };
        }
        deliveries.set(where.deliveryId, { ...current, ...data });
        return { count: 1 };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    gitHubWorkflowRunObservation: {
      ...transaction.gitHubWorkflowRunObservation,
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    gitHubActionsPollingState: {
      findUnique: vi.fn(
        async ({ where }) =>
          pollingStates.get(where.codebaseRepositoryId) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }) => {
        const current = pollingStates.get(where.codebaseRepositoryId);
        const next = current ? { ...current, ...update } : { ...create };
        pollingStates.set(where.codebaseRepositoryId, next);
        return next;
      }),
      update: transaction.gitHubActionsPollingState.update,
    },
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => unknown) => {
        const observationSnapshot = new Map(
          [...observations].map(([key, value]) => [key, { ...value }]),
        );
        try {
          return await operation(transaction);
        } catch (error) {
          observations.clear();
          observationSnapshot.forEach((value, key) =>
            observations.set(key, value),
          );
          throw error;
        }
      },
    ),
  };
  mocks.getPrismaClient.mockResolvedValue(prisma);
  const service = new GitHubActionsNotificationsService(
    credentials as never,
    notifications as never,
    polling as never,
    false,
    workflowEvents as never,
    { recordRestCall: mocks.recordRestCall } as never,
    pipelineStatus as never,
  );
  return {
    service,
    prisma,
    notifications,
    polling,
    observations,
    pollingStates,
    deliveries,
    pipelineStatus,
  };
}

function webhookInput(
  payload: Record<string, unknown>,
  deliveryId = "delivery-1",
) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return {
    body,
    signature: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    event: "workflow_run",
    deliveryId,
  };
}

beforeEach(() => {
  mocks.getPrismaClient.mockReset();
  mocks.recordRestCall.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub Actions webhook notifications", () => {
  test("always ingests signed completed workflow runs", async () => {
    const { service, pipelineStatus } = setup();

    await service.handleWebhook(webhookInput(workflowPayload("success")));

    expect(pipelineStatus.observeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryGithubId: "repository-node-1",
        headSha: "abc123",
        pipelines: [
          expect.objectContaining({
            workflowRunId: "101",
            status: "SUCCESS",
            source: "WEBHOOK",
          }),
        ],
      }),
    );
  });

  test("gates enhanced status webhooks and performs no outbound request", async () => {
    const disabled = setup();
    const payload = {
      installation: { id: 456 },
      repository: {
        node_id: "repository-node-1",
        full_name: "acme/widgets",
        html_url: "https://github.com/acme/widgets",
      },
      sha: "abc123",
      context: "deploy/production",
      state: "success",
      target_url: "https://ci.example/deploy/1",
      updated_at: "2026-07-22T12:00:00.000Z",
    };
    const disabledInput = webhookInput(payload, "status-disabled");
    await expect(
      disabled.service.handleWebhook({ ...disabledInput, event: "status" }),
    ).resolves.toMatchObject({ outcome: "IGNORED" });
    expect(disabled.pipelineStatus.observeSnapshot).not.toHaveBeenCalled();

    const enabled = setup(undefined, undefined, true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const enabledInput = webhookInput(payload, "status-enabled");
    await expect(
      enabled.service.handleWebhook({ ...enabledInput, event: "status" }),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect(enabled.pipelineStatus.observeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryGithubId: "repository-node-1",
        headSha: "abc123",
        pipelines: [
          expect.objectContaining({
            statusContext: "deploy/production",
            status: "SUCCESS",
            source: "WEBHOOK",
          }),
        ],
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("persists enhanced workflow job steps on their run", async () => {
    const { service, pipelineStatus } = setup(undefined, undefined, true);
    const input = webhookInput(
      {
        action: "completed",
        installation: { id: 456 },
        repository: {
          node_id: "repository-node-1",
          full_name: "acme/widgets",
          html_url: "https://github.com/acme/widgets",
        },
        workflow_job: {
          id: 501,
          run_id: 101,
          run_attempt: 2,
          workflow_name: "CI",
          name: "test",
          head_sha: "abc123",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/acme/widgets/actions/runs/101/job/501",
          completed_at: "2026-07-22T12:00:00.000Z",
          steps: [
            {
              number: 1,
              name: "Run tests",
              status: "completed",
              conclusion: "failure",
            },
          ],
        },
      },
      "workflow-job-completed",
    );

    await expect(
      service.handleWebhook({ ...input, event: "workflow_job" }),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
    expect(pipelineStatus.observeJobs).toHaveBeenCalledWith(
      "repository-node-1",
      "101",
      [
        expect.objectContaining({
          id: "501",
          status: "FAILURE",
          runAttempt: 2,
          steps: [expect.objectContaining({ name: "Run tests" })],
        }),
      ],
      "WEBHOOK",
      new Date("2026-07-22T12:00:00.000Z"),
    );
  });

  test("correlates pull-request webhook triggers to the worktree and agent", async () => {
    const workflowEvents = { record: vi.fn(async () => ({})) };
    const { service } = setup(workflowEvents);
    const input = webhookInput(
      {
        action: "opened",
        installation: { id: 456 },
        repository: {
          full_name: "acme/widgets",
          html_url: "https://github.com/acme/widgets",
          default_branch: "main",
        },
        pull_request: {
          number: 42,
          title: "Ship widgets",
          html_url: "https://github.com/acme/widgets/pull/42",
          state: "open",
          draft: false,
          labels: [],
          head: { ref: "feature/APP-42", sha: "abc123" },
          base: { ref: "main" },
        },
      },
      "pull-request-opened",
    );

    await service.handleWebhook({ ...input, event: "pull_request" });

    expect(workflowEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "GITHUB_PR_STATE",
        payload: expect.objectContaining({
          sessionData: expect.objectContaining({
            worktree: expect.objectContaining({ id: "worktree-1" }),
            codebase: expect.objectContaining({ id: "codebase-1" }),
            agent: expect.objectContaining({ id: "agent-1" }),
            repo: expect.objectContaining({ id: "repository-1" }),
            pr: expect.objectContaining({
              number: 42,
              headBranch: "feature/APP-42",
            }),
            ticket: expect.objectContaining({ key: "APP-42" }),
          }),
        }),
      }),
    );
  });

  test("uses the global Jira branch regex for webhook triggers", async () => {
    const workflowEvents = { record: vi.fn(async () => ({})) };
    const { service } = setup(workflowEvents, null);
    const input = webhookInput(
      {
        action: "opened",
        installation: { id: 456 },
        repository: {
          full_name: "acme/widgets",
          html_url: "https://github.com/acme/widgets",
          default_branch: "main",
        },
        pull_request: {
          number: 42,
          title: "Ship widgets",
          html_url: "https://github.com/acme/widgets/pull/42",
          state: "open",
          draft: false,
          labels: [],
          head: { ref: "feature/APP-42", sha: "abc123" },
          base: { ref: "main" },
        },
      },
      "pull-request-global-jira-regex",
    );

    await service.handleWebhook({ ...input, event: "pull_request" });

    expect(workflowEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionData: expect.objectContaining({
            ticket: { key: "APP-42" },
          }),
        }),
      }),
    );
  });

  test("seeds workflow triggers with correlated repository resources", async () => {
    const workflowEvents = { record: vi.fn(async () => ({})) };
    const { service } = setup(workflowEvents);

    await service.handleWebhook(webhookInput(workflowPayload("success")));

    expect(workflowEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "GITHUB_ACTIONS_RESULT",
        payload: expect.objectContaining({
          sessionData: expect.objectContaining({
            repo: expect.objectContaining({
              id: "repository-1",
              name: "Widgets",
              canonicalOrigin: "github.com/acme/widgets",
            }),
            pipeline: expect.objectContaining({
              runId: "101",
              headSha: "abc123",
              pullRequests: [expect.objectContaining({ number: 42 })],
            }),
            worktree: expect.objectContaining({
              id: "worktree-1",
              path: "/repo-feature",
            }),
            codebase: expect.objectContaining({
              id: "codebase-1",
              agentId: "agent-1",
            }),
            agent: expect.objectContaining({
              id: "agent-1",
              name: "Studio Mac",
            }),
            pr: expect.objectContaining({ number: 42 }),
            ticket: expect.objectContaining({ key: "APP-42" }),
          }),
        }),
      }),
    );
  });

  test.each([
    ["success", "GITHUB_ACTIONS_SUCCEEDED"],
    ["failure", "GITHUB_ACTIONS_FAILED"],
    ["timed_out", "GITHUB_ACTIONS_FAILED"],
    ["startup_failure", "GITHUB_ACTIONS_FAILED"],
    ["action_required", "GITHUB_ACTIONS_FAILED"],
  ])("records a notification for %s", async (conclusion, typeKey) => {
    const { service, notifications } = setup();

    await expect(
      service.handleWebhook(webhookInput(workflowPayload(conclusion))),
    ).resolves.toEqual({ outcome: "PROCESSED", notificationCreated: true });

    expect(notifications.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        typeKey,
        href: "/actions?repository=repository-1&branch=feature%2FAPP-42&pipeline=202",
        worktreeId: "worktree-1",
        highlightColor: "blue",
      }),
    );
    expect(notifications.created).toHaveBeenCalledWith(
      expect.objectContaining({ id: "notification-1" }),
    );
  });

  test.each(["cancelled", "skipped", "neutral"])(
    "observes but does not notify %s runs",
    async (conclusion) => {
      const { service, notifications } = setup();

      await expect(
        service.handleWebhook(webhookInput(workflowPayload(conclusion))),
      ).resolves.toEqual({ outcome: "PROCESSED", notificationCreated: false });
      expect(notifications.recordInTransaction).not.toHaveBeenCalled();
    },
  );

  test("rejects invalid signatures before recording the delivery", async () => {
    const { service, prisma } = setup();
    const input = webhookInput(workflowPayload("success"));

    await expect(
      service.handleWebhook({ ...input, signature: "sha256=invalid" }),
    ).rejects.toThrow("signature is invalid");
    expect(prisma.gitHubWebhookDelivery.create).not.toHaveBeenCalled();
  });

  test("retries signed deliveries that previously failed", async () => {
    const { service, prisma, notifications, deliveries } = setup();
    notifications.recordInTransaction.mockRejectedValueOnce(
      new Error("Transient notification failure"),
    );
    const input = webhookInput(workflowPayload("success"), "retry-success");

    await expect(service.handleWebhook(input)).rejects.toThrow(
      "Transient notification failure",
    );
    expect(deliveries.get("retry-success")).toMatchObject({
      outcome: "ERROR",
      error: "Transient notification failure",
    });

    await expect(service.handleWebhook(input)).resolves.toEqual({
      outcome: "PROCESSED",
      notificationCreated: true,
    });
    expect(prisma.gitHubWebhookDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deliveryId: "retry-success",
          outcome: { notIn: ["PROCESSED", "IGNORED"] },
        },
      }),
    );
    expect(notifications.recordInTransaction).toHaveBeenCalledTimes(2);
    expect(deliveries.get("retry-success")).toMatchObject({
      outcome: "PROCESSED",
      error: null,
    });
  });

  test("records repeated failures for retried invalid JSON deliveries", async () => {
    const { service, prisma, deliveries } = setup();
    const body = new TextEncoder().encode("not-json");
    const input = {
      body,
      signature: `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      event: "workflow_run",
      deliveryId: "invalid-json",
    };

    await expect(service.handleWebhook(input)).rejects.toThrow("invalid JSON");
    expect(deliveries.get("invalid-json")).toMatchObject({
      outcome: "ERROR",
      error: "GitHub webhook payload is invalid JSON",
    });
    await expect(service.handleWebhook(input)).rejects.toThrow("invalid JSON");
    expect(prisma.gitHubWebhookDelivery.updateMany).toHaveBeenCalledTimes(1);
  });

  test("filters installations and repositories and deduplicates deliveries", async () => {
    const { service, prisma, notifications } = setup();
    const installation = workflowPayload("success");
    installation.installation = { id: 999 };
    await expect(
      service.handleWebhook(webhookInput(installation, "wrong-installation")),
    ).resolves.toEqual({ outcome: "IGNORED", notificationCreated: false });

    const repository = workflowPayload("success");
    repository.repository = {
      node_id: "other-repository",
      full_name: "other/project",
      html_url: "https://github.com/other/project",
    };
    await expect(
      service.handleWebhook(webhookInput(repository, "wrong-repository")),
    ).resolves.toEqual({ outcome: "IGNORED", notificationCreated: false });

    const valid = webhookInput(workflowPayload("success"), "duplicate");
    await service.handleWebhook(valid);
    await expect(service.handleWebhook(valid)).resolves.toEqual({
      outcome: "DUPLICATE",
      notificationCreated: false,
    });
    expect(prisma.gitHubWebhookDelivery.create).toHaveBeenCalledTimes(4);
    expect(notifications.recordInTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("GitHub Actions fallback polling", () => {
  test("keeps completed PAT-polled runs non-retryable without a GitHub App", async () => {
    const { service, pipelineStatus } = setup(
      undefined,
      undefined,
      false,
      false,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        githubResponse([
          {
            id: 101,
            workflow_id: 202,
            run_attempt: 1,
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_sha: "abc123",
            updated_at: "2026-07-22T13:00:00.000Z",
            check_suite_node_id: "suite-node-1",
            repository: {
              node_id: "repository-node-1",
              full_name: "acme/widgets",
              html_url: "https://github.com/acme/widgets",
            },
          },
        ]),
      ),
    );

    await (
      service as unknown as {
        pollRepositories(): Promise<Record<string, unknown>>;
      }
    ).pollRepositories();

    expect(pipelineStatus.observeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelines: [
          expect.objectContaining({
            canRetry: false,
            retryUnavailableReason: "GITHUB_APP_NOT_CONFIGURED",
          }),
        ],
      }),
    );
  });

  test("paginates until it reaches runs older than the previous successful poll", async () => {
    const { service, notifications, pollingStates } = setup();
    const previousPoll = new Date("2026-07-22T12:00:00.000Z");
    pollingStates.set("repository-1", {
      initializedAt: previousPoll,
      lastPollSucceededAt: previousPoll,
    });
    const newerRuns = Array.from({ length: 100 }, (_, index) => ({
      id: 1_000 + index,
      workflow_id: 202,
      run_attempt: 1,
      name: "CI",
      status: "in_progress",
      conclusion: null,
      updated_at: "2026-07-22T13:00:00.000Z",
    }));
    const boundaryPage = [
      {
        id: 2_000,
        workflow_id: 202,
        run_attempt: 1,
        name: "CI",
        status: "completed",
        conclusion: "success",
        updated_at: "2026-07-22T13:00:00.000Z",
      },
      ...Array.from({ length: 99 }, (_, index) => ({
        id: 2_001 + index,
        workflow_id: 202,
        run_attempt: 1,
        name: "CI",
        status: "in_progress",
        conclusion: null,
        updated_at: "2026-07-22T11:00:00.000Z",
      })),
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("page=1")) return githubResponse(newerRuns);
      if (url.endsWith("page=2")) return githubResponse(boundaryPage);
      throw new Error(`Unexpected polling page: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      (
        service as unknown as {
          pollRepositories(): Promise<Record<string, unknown>>;
        }
      ).pollRepositories(),
    ).resolves.toMatchObject({ notificationsCreated: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mocks.recordRestCall).toHaveBeenCalledTimes(2);
    expect(mocks.recordRestCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        authentication: "PAT",
        method: "GET",
        endpoint: expect.stringContaining("page=2"),
        operation: GITHUB_REST_OPERATIONS.actions.listWorkflowRunsForRepo,
        requestSource: "ACTIONS_NOTIFICATIONS",
        statusCode: 200,
      }),
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining("page=1"),
      expect.stringContaining("page=2"),
    ]);
    expect(notifications.recordInTransaction).toHaveBeenCalledTimes(1);
  });

  test("seeds history, then notifies a terminal transition once", async () => {
    const { service, notifications, observations } = setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        githubResponse([
          {
            id: 101,
            workflow_id: 202,
            run_attempt: 1,
            name: "CI",
            status: "in_progress",
            conclusion: null,
            head_branch: "feature/APP-42",
            updated_at: "2026-07-22T12:00:00.000Z",
          },
        ]),
      )
      .mockImplementation(async () =>
        githubResponse([
          {
            id: 101,
            workflow_id: 202,
            run_attempt: 1,
            name: "CI",
            status: "completed",
            conclusion: "success",
            head_branch: "feature/APP-42",
            // A transition must not be missed merely because GitHub's timestamp
            // precedes the previous poll's local completion timestamp.
            updated_at: "2026-07-22T12:00:00.000Z",
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const poll = () =>
      (
        service as unknown as {
          pollRepositories(): Promise<Record<string, unknown>>;
        }
      ).pollRepositories();

    await expect(poll()).resolves.toMatchObject({ notificationsCreated: 0 });
    expect(notifications.recordInTransaction).not.toHaveBeenCalled();

    await expect(poll()).resolves.toMatchObject({ notificationsCreated: 1 });
    await expect(poll()).resolves.toMatchObject({ notificationsCreated: 0 });
    expect(notifications.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(observations.get("repository-1:101:1")?.notifiedAt).toBeInstanceOf(
      Date,
    );
  });
});
