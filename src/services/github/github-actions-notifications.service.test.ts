import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));

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
    repository: { full_name: "acme/widgets" },
    workflow_run: {
      id: 101,
      workflow_id: 202,
      run_attempt: 1,
      name: "CI",
      display_title: "Test widgets",
      status: "completed",
      conclusion,
      head_branch: "feature/APP-42",
      html_url: "https://github.com/acme/widgets/actions/runs/101",
      updated_at: "2026-07-22T12:00:00.000Z",
      ...overrides,
    },
  };
}

function githubResponse(runs: Array<Record<string, unknown>>): Response {
  return Response.json({ workflow_runs: runs });
}

function setup() {
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
        },
      ]),
    },
    gitHubAppSettings: {
      findUnique: vi.fn(async () => ({ installationId: "456" })),
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
      async (operation: (client: typeof transaction) => unknown) =>
        operation(transaction),
    ),
  };
  mocks.getPrismaClient.mockResolvedValue(prisma);
  const service = new GitHubActionsNotificationsService(
    credentials as never,
    notifications as never,
    polling as never,
    false,
  );
  return {
    service,
    prisma,
    notifications,
    polling,
    observations,
    pollingStates,
    deliveries,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GitHub Actions webhook notifications", () => {
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

  test("records and deduplicates signed deliveries with invalid JSON", async () => {
    const { service, deliveries } = setup();
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
    await expect(service.handleWebhook(input)).resolves.toEqual({
      outcome: "DUPLICATE",
      notificationCreated: false,
    });
  });

  test("filters installations and repositories and deduplicates deliveries", async () => {
    const { service, prisma, notifications } = setup();
    const installation = workflowPayload("success");
    installation.installation = { id: 999 };
    await expect(
      service.handleWebhook(webhookInput(installation, "wrong-installation")),
    ).resolves.toEqual({ outcome: "IGNORED", notificationCreated: false });

    const repository = workflowPayload("success");
    repository.repository = { full_name: "other/project" };
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
