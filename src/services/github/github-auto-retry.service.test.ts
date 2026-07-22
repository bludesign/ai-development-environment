// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from "vitest";

const database = vi.hoisted(() => ({
  execution: {
    id: "execution-1",
    ruleId: "rule-1",
    workflowRunId: "run-1",
    workflowId: "workflow-1",
    targetKey: "workflow",
    status: "RETRYING",
    observedAttempt: 1,
    automaticRetries: 1,
    pendingFromAttempt: 1 as number | null,
    lastStatus: "FAILURE" as string | null,
    lastError: null as string | null,
    finishedAt: null as Date | null,
    updatedAt: new Date(0),
  },
  executionUpdateManyData: null as Record<string, unknown> | null,
  ruleUpdateData: null as Record<string, unknown> | null,
}));

const baseRule = vi.hoisted(() => ({
  id: "rule-1",
  scope: "REPOSITORY",
  codebaseRepositoryId: "repository-1",
  repositoryGithubId: "github-repository-1",
  worktreeId: null,
  branch: null,
  pullRequestNumber: null,
  allWorkflows: true,
  mode: "FAILURE",
  retryLimit: 3,
  failureStrategy: "FAILED_JOBS",
  status: "ACTIVE",
  enabled: true,
  lastError: null,
  activatedAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  targets: [],
  executions: [],
}));

const prisma = vi.hoisted(() => ({
  gitHubSettings: {
    upsert: vi.fn(async () => ({
      actionsNotificationPollIntervalSeconds: 120,
    })),
  },
  gitHubAutoRetryExecution: {
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
      Object.assign(database.execution, data),
    ),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      database.executionUpdateManyData = data;
      Object.assign(database.execution, data);
      return { count: 1 };
    }),
    upsert: vi.fn(async () => database.execution),
  },
  gitHubAutoRetryRule: {
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      database.ruleUpdateData = data;
      return { ...baseRule, ...data };
    }),
  },
  $transaction: vi.fn(
    async (operation: (client: typeof prisma) => Promise<unknown>) =>
      operation(prisma),
  ),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => prisma,
}));

import {
  autoRetryDecision,
  GitHubAutoRetryService,
} from "./github-auto-retry.service";

beforeEach(() => {
  database.execution = {
    ...database.execution,
    status: "RETRYING",
    observedAttempt: 1,
    automaticRetries: 1,
    pendingFromAttempt: 1,
    lastStatus: "FAILURE",
    lastError: null,
    finishedAt: null,
    updatedAt: new Date(0),
  };
  database.executionUpdateManyData = null;
  database.ruleUpdateData = null;
  vi.clearAllMocks();
});

describe("GitHub Auto Retry decisions", () => {
  test("uses the GitHub Actions notification cadence for reconciliation", async () => {
    const polling = {
      register: vi.fn(),
      configure: vi.fn(),
      schedule: vi.fn(),
      run: vi.fn(
        async (
          _id: string,
          operation: () => Promise<number>,
          _details: (activeRules: number) => Record<string, unknown>,
        ) => operation(),
      ),
    };
    const service = new GitHubAutoRetryService(
      {} as never,
      polling as never,
      false,
    );

    await (
      service as unknown as { pollReconcile(): Promise<void> }
    ).pollReconcile();

    expect(polling.register).toHaveBeenCalledWith(
      expect.objectContaining({ cadenceSeconds: 60 }),
    );
    expect(polling.configure).toHaveBeenCalledWith("server:github-auto-retry", {
      cadenceSeconds: 120,
    });
    expect(polling.schedule).toHaveBeenCalledWith(
      "server:github-auto-retry",
      expect.any(Date),
    );
  });

  test("count mode repeats successful runs until the configured limit", () => {
    expect(
      autoRetryDecision({
        mode: "COUNT",
        retryLimit: 3,
        automaticRetries: 2,
        state: "SUCCESS",
      }),
    ).toBe("RETRY");
    expect(
      autoRetryDecision({
        mode: "COUNT",
        retryLimit: 3,
        automaticRetries: 3,
        state: "SUCCESS",
      }),
    ).toBe("COMPLETE");
    expect(
      autoRetryDecision({
        mode: "COUNT",
        retryLimit: 3,
        automaticRetries: 0,
        state: "FAILURE",
      }),
    ).toBe("STOP");
  });

  test("pauses a rule when GitHub never confirms the requested rerun", async () => {
    const service = Object.create(
      GitHubAutoRetryService.prototype,
    ) as GitHubAutoRetryService;
    const testService = service as unknown as {
      reconcileExecution: (
        rule: Record<string, unknown>,
        run: Record<string, unknown>,
        targetKey: string,
        job: null,
      ) => Promise<boolean>;
    };

    await expect(
      testService.reconcileExecution(
        {
          id: "rule-1",
          codebaseRepositoryId: "repository-1",
          mode: "FAILURE",
          retryLimit: 3,
          failureStrategy: "FAILED_JOBS",
        },
        {
          id: "run-1",
          workflowId: "workflow-1",
          runAttempt: 1,
          status: "FAILURE",
        },
        "workflow",
        null,
      ),
    ).resolves.toBe(false);

    expect(database.ruleUpdateData).toMatchObject({
      enabled: false,
      status: "PAUSED",
    });
    expect(database.execution.status).toBe("ERROR");
  });

  test("clears ambiguous pending attempts when a paused rule is resumed", async () => {
    const service = Object.create(
      GitHubAutoRetryService.prototype,
    ) as GitHubAutoRetryService;

    await service.setEnabled("rule-1", true);

    expect(database.executionUpdateManyData).toMatchObject({
      pendingFromAttempt: null,
      observedAttempt: 0,
      status: "WATCHING",
      lastError: null,
    });
    expect(database.ruleUpdateData).toMatchObject({
      enabled: true,
      status: "ACTIVE",
      lastError: null,
    });
  });

  test("refreshes tracked runs that have fallen out of repository discovery", async () => {
    prisma.gitHubAutoRetryRule.findMany.mockResolvedValueOnce([
      { ...baseRule, targets: [] },
    ] as never);
    prisma.gitHubAutoRetryExecution.findMany.mockResolvedValueOnce([
      { ruleId: "rule-1", workflowRunId: "run-old" },
    ] as never);
    const github = {
      autoRetryRuns: vi.fn(async () => []),
      autoRetryRun: vi.fn(async () => ({
        id: "run-old",
        workflowId: "workflow-1",
        runAttempt: 1,
        status: "IN_PROGRESS",
        createdAt: "2026-07-21T12:00:00.000Z",
        headBranch: "main",
        pullRequests: [],
        jobs: [],
      })),
    };
    const service = Object.create(
      GitHubAutoRetryService.prototype,
    ) as GitHubAutoRetryService;
    Reflect.set(service, "github", github);

    await service.reconcile();

    expect(github.autoRetryRun).toHaveBeenCalledWith(
      "repository-1",
      "run-old",
      false,
    );
  });

  test("does not reload jobs for an attempt that was already observed", async () => {
    prisma.gitHubAutoRetryRule.findMany.mockResolvedValueOnce([
      {
        ...baseRule,
        allWorkflows: false,
        targets: [
          {
            workflowId: "workflow-1",
            workflowRunId: null,
            jobName: "test",
          },
        ],
      },
    ] as never);
    const github = {
      autoRetryRuns: vi.fn(async () => [
        {
          id: "run-1",
          workflowId: "workflow-1",
          runAttempt: 1,
          status: "FAILURE",
          createdAt: "2026-07-21T12:00:00.000Z",
          headBranch: "main",
          pullRequests: [],
          jobs: [],
        },
      ]),
      autoRetryRun: vi.fn(),
    };
    const service = Object.create(
      GitHubAutoRetryService.prototype,
    ) as GitHubAutoRetryService;
    Reflect.set(service, "github", github);

    await service.reconcile();

    expect(github.autoRetryRun).not.toHaveBeenCalled();
  });

  test.each(["FAILURE", "ERROR", "STARTUP_FAILURE", "TIMED_OUT"] as const)(
    "failure mode retries %s",
    (state) => {
      expect(
        autoRetryDecision({
          mode: "FAILURE",
          retryLimit: null,
          automaticRetries: 100,
          state,
        }),
      ).toBe("RETRY");
    },
  );

  test("failure mode completes, exhausts, or stops without retrying other conclusions", () => {
    expect(
      autoRetryDecision({
        mode: "FAILURE",
        retryLimit: 3,
        automaticRetries: 0,
        state: "SUCCESS",
      }),
    ).toBe("COMPLETE");
    expect(
      autoRetryDecision({
        mode: "FAILURE",
        retryLimit: 3,
        automaticRetries: 3,
        state: "FAILURE",
      }),
    ).toBe("EXHAUSTED");
    expect(
      autoRetryDecision({
        mode: "FAILURE",
        retryLimit: 3,
        automaticRetries: 0,
        state: "CANCELLED",
      }),
    ).toBe("STOP");
  });
});
