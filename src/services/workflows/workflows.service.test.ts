import { beforeEach, describe, expect, test, vi } from "vitest";

import { CodebaseBusyError } from "@/lib/codebase-busy";
import {
  emptyWorkflowDefinition,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import { WorkflowEventsService } from "./workflow-events.service";
import { WorkflowsService } from "./workflows.service";

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  workflow: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  codebaseRepository: { count: vi.fn() },
  worktree: { findUnique: vi.fn(), findFirst: vi.fn() },
  codebase: { findUnique: vi.fn() },
  build: { findUnique: vi.fn() },
  agentRun: { findUnique: vi.fn() },
  workflowQuickActionRepository: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  workflowVersion: { findMany: vi.fn() },
  workflowRun: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  workflowRunNumberSequence: { upsert: vi.fn() },
  workflowRunResourceLink: {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
  workflowStepAttempt: { update: vi.fn(), updateMany: vi.fn() },
  workflowWait: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  workflowTriggerState: { findUnique: vi.fn(), upsert: vi.fn() },
  workflowResourceLease: { deleteMany: vi.fn() },
  workflowRunEvent: { findFirst: vi.fn(), create: vi.fn() },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => prisma,
}));

function subworkflowDefinition(
  name: string,
  versionId: string,
): WorkflowDefinition {
  const definition = emptyWorkflowDefinition(name);
  return {
    ...definition,
    nodes: [
      {
        id: "subworkflow",
        kind: "CONTROL_SUBWORKFLOW",
        position: { x: 200, y: 100 },
        config: { versionId },
        requiredPaths: [],
        providedPaths: [],
        retry: {
          maxAttempts: 1,
          strategy: "EXPONENTIAL",
          delaySeconds: 5,
        },
        failurePolicy: "FAIL",
      },
    ],
    edges: [
      {
        id: "manual-to-subworkflow",
        source: "manual",
        target: "subworkflow",
        sourceHandle: "success",
        targetHandle: "input",
      },
    ],
  };
}

describe("workflow quick actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (
        operation: unknown[] | ((transaction: typeof prisma) => unknown),
      ) =>
        typeof operation === "function"
          ? operation(prisma)
          : Promise.all(operation),
    );
  });

  test("returns enabled worktree actions inherited from the repository", async () => {
    const accepted = emptyWorkflowDefinition("Accepted");
    accepted.triggers = [
      {
        id: "worktree",
        kind: "RESOURCE_MANUAL",
        position: { x: 0, y: 0 },
        config: { resourceKind: "WORKTREE" },
      },
    ];
    const ignored = emptyWorkflowDefinition("Ignored");
    prisma.workflow.findMany.mockResolvedValue([
      {
        id: "workflow-accepted",
        activeVersion: { definitionJson: JSON.stringify(accepted) },
      },
      {
        id: "workflow-ignored",
        activeVersion: { definitionJson: JSON.stringify(ignored) },
      },
    ]);

    const result = await new WorkflowsService(
      new WorkflowEventsService(),
    ).quickActions({
      kind: "STANDARD",
      resourceKind: "WORKTREE",
      repositoryId: "repository-1",
    });

    expect(result.map(({ id }) => id)).toEqual(["workflow-accepted"]);
    expect(prisma.workflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          enabled: true,
          archivedAt: null,
          activeVersionId: { not: null },
          quickActionKind: "STANDARD",
          OR: expect.arrayContaining([
            { quickActionRepositories: { none: {} } },
            {
              quickActionRepositories: {
                some: { repositoryId: "repository-1" },
              },
            },
          ]),
        }),
      }),
    );
  });

  test("replaces global and repository assignments atomically", async () => {
    prisma.workflow.findUnique.mockResolvedValue({ id: "workflow-1" });
    prisma.codebaseRepository.count.mockResolvedValue(2);
    prisma.workflow.update.mockResolvedValue({ id: "workflow-1" });
    prisma.workflowQuickActionRepository.deleteMany.mockResolvedValue({
      count: 0,
    });
    prisma.workflowQuickActionRepository.createMany.mockResolvedValue({
      count: 2,
    });

    await new WorkflowsService(new WorkflowEventsService()).setQuickAction({
      id: "workflow-1",
      kind: "GITHUB_ACTIONS",
      quickActionIconKey: "rocket",
      quickActionButtonVariant: "secondary",
      repositoryIds: ["repository-1", "repository-2", "repository-1"],
    });

    expect(prisma.workflow.update).toHaveBeenCalledWith({
      where: { id: "workflow-1" },
      data: {
        quickActionKind: "GITHUB_ACTIONS",
        quickActionIconKey: "rocket",
        quickActionButtonVariant: "secondary",
      },
    });
    expect(
      prisma.workflowQuickActionRepository.createMany,
    ).toHaveBeenCalledWith({
      data: [
        { workflowId: "workflow-1", repositoryId: "repository-1" },
        { workflowId: "workflow-1", repositoryId: "repository-2" },
      ],
    });
  });
});

describe("workflow resource session hydration", () => {
  test("adds authoritative worktree context without replacing caller data", async () => {
    const workflowSessionDataForWorktree = vi.fn().mockResolvedValue({
      worktree: { id: "worktree-1", path: "/tmp/feature" },
      repo: { id: "repository-derived", name: "widgets" },
      pr: { number: 12, jiraKey: "APP-12" },
      ticket: { key: "APP-12" },
    });
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketKeyForWorktree: vi.fn(),
        workflowSessionDataForWorktree,
      },
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    const result = await service.hydrateResourceSessionData(
      "GITHUB_JOB",
      "repository-1:job:44",
      {
        worktree: { id: "worktree-1", headSha: "caller-sha" },
        repo: { id: "repository-explicit" },
        pipeline: { id: "run-1" },
        job: { id: "44" },
        pr: { number: 99, jiraKey: "APP-99" },
      },
    );

    expect(workflowSessionDataForWorktree).toHaveBeenCalledWith("worktree-1");
    expect(result).toMatchObject({
      worktree: {
        id: "worktree-1",
        path: "/tmp/feature",
        headSha: "caller-sha",
      },
      repo: { id: "repository-explicit", name: "widgets" },
      pipeline: { id: "run-1" },
      job: { id: "44" },
      pr: { number: 99, jiraKey: "APP-99" },
      ticket: { key: "APP-12" },
    });
  });

  test("falls back to legacy ticket hydration for worktree resources", async () => {
    const ticketKeyForWorktree = vi.fn().mockResolvedValue("APP-42");
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { ticketKeyForWorktree },
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("WORKTREE", "worktree-1", {
        worktree: { id: "worktree-1" },
      }),
    ).resolves.toMatchObject({ ticket: { key: "APP-42" } });
  });

  test("uses the first run PR only when a linked worktree has none", async () => {
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketKeyForWorktree: vi.fn(),
        workflowSessionDataForWorktree: vi.fn().mockResolvedValue({
          worktree: { id: "worktree-1" },
          repo: { id: "repository-1" },
        }),
      },
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData(
        "GITHUB_PIPELINE",
        "repository-1:run:1",
        {
          worktree: { id: "worktree-1" },
          pipeline: {
            pullRequests: [
              {
                number: 12,
                url: "https://github.com/acme/widgets/pull/12",
              },
              {
                number: 13,
                url: "https://github.com/acme/widgets/pull/13",
              },
            ],
          },
        },
      ),
    ).resolves.toMatchObject({ pr: { number: 12 } });
  });

  test("hydrates a codebase launch with its repository and owning agent", async () => {
    prisma.codebase.findUnique.mockResolvedValue({
      id: "codebase-1",
      folder: "/repo",
      agentId: "agent-1",
      branch: "main",
      headSha: "abc123",
      defaultBranch: "main",
      agent: {
        id: "agent-1",
        name: "Studio Mac",
        hostname: "studio.local",
        lastSeenAt: new Date(),
        disconnectedAt: null,
        heartbeatIntervalSeconds: 10,
        diskFreeBytes: 1_000,
        memoryFreeBytes: 2_000,
      },
      repository: {
        id: "repository-1",
        name: "Widgets",
        canonicalOrigin: "github.com/acme/widgets",
        displayOrigin: "github.com/acme/widgets",
      },
    });
    const service = new WorkflowsService(
      new WorkflowEventsService(),
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("CODEBASE", "codebase-1", {
        codebase: { id: "codebase-1" },
      }),
    ).resolves.toMatchObject({
      codebase: {
        id: "codebase-1",
        folder: "/repo",
        branch: "main",
        headSha: "abc123",
      },
      agent: { id: "agent-1", name: "Studio Mac", connected: true },
      repo: { id: "repository-1", defaultBranch: "main" },
    });
  });

  test("marks stale codebase agents disconnected using the heartbeat window", async () => {
    prisma.codebase.findUnique.mockResolvedValue({
      id: "codebase-1",
      folder: "/repo",
      agentId: "agent-1",
      branch: "main",
      headSha: "abc123",
      defaultBranch: "main",
      agent: {
        id: "agent-1",
        name: "Studio Mac",
        hostname: "studio.local",
        lastSeenAt: new Date(Date.now() - 46_000),
        disconnectedAt: null,
        heartbeatIntervalSeconds: 10,
        diskFreeBytes: 1_000,
        memoryFreeBytes: 2_000,
      },
      repository: {
        id: "repository-1",
        name: "Widgets",
        canonicalOrigin: "github.com/acme/widgets",
        displayOrigin: "github.com/acme/widgets",
      },
    });
    const service = new WorkflowsService(
      new WorkflowEventsService(),
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("CODEBASE", "codebase-1", {}),
    ).resolves.toMatchObject({ agent: { connected: false } });
  });

  test("marks stale build agents disconnected using the heartbeat window", async () => {
    prisma.build.findUnique.mockResolvedValue({
      id: "build-1",
      status: "QUEUED",
      action: "BUILD",
      error: null,
      artifactDirectory: null,
      worktreeId: null,
      agent: {
        id: "agent-1",
        name: "Studio Mac",
        hostname: "studio.local",
        lastSeenAt: new Date(Date.now() - 46_000),
        disconnectedAt: null,
        heartbeatIntervalSeconds: 10,
        diskFreeBytes: 1_000,
        memoryFreeBytes: 2_000,
      },
      codebase: null,
      artifacts: [],
      reports: [],
    });
    const service = new WorkflowsService(
      new WorkflowEventsService(),
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("BUILD", "build-1", {}),
    ).resolves.toMatchObject({ agent: { connected: false } });
  });

  test("hydrates a build launch with reports and linked worktree context", async () => {
    prisma.build.findUnique.mockResolvedValue({
      id: "build-1",
      status: "SUCCEEDED",
      action: "TEST",
      error: null,
      artifactDirectory: "/tmp/build-1",
      worktreeId: "worktree-1",
      agent: null,
      codebase: null,
      artifacts: [
        {
          id: "artifact-1",
          kind: "RESULT_BUNDLE",
          relativePath: "Tests.xcresult",
          sizeBytes: 42,
          checksum: "sha256",
        },
      ],
      reports: [
        {
          kind: "TEST_RESULTS",
          summaryJson: JSON.stringify({ passed: 10, failed: 0 }),
        },
      ],
    });
    const workflowSessionDataForWorktree = vi.fn().mockResolvedValue({
      worktree: { id: "worktree-1", branch: "feature/APP-42" },
      codebase: { id: "codebase-1", agentId: "agent-1" },
      agent: { id: "agent-1", name: "Studio Mac" },
      repo: { id: "repository-1", name: "Widgets" },
      ticket: { key: "APP-42" },
    });
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketKeyForWorktree: vi.fn(),
        workflowSessionDataForWorktree,
      },
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("BUILD", "build-1", {
        build: { id: "build-1" },
      }),
    ).resolves.toMatchObject({
      build: {
        id: "build-1",
        status: "SUCCEEDED",
        testSummary: { passed: 10, failed: 0 },
        artifacts: [{ id: "artifact-1" }],
      },
      worktree: { id: "worktree-1", branch: "feature/APP-42" },
      agent: { id: "agent-1" },
      repo: { id: "repository-1" },
      ticket: { key: "APP-42" },
    });
    expect(workflowSessionDataForWorktree).toHaveBeenCalledWith("worktree-1");
  });

  test("hydrates a pull-request launch with PR, worktree, and ticket context", async () => {
    const workflowSessionDataForWorktree = vi.fn().mockResolvedValue({
      worktree: { id: "worktree-1", branch: "feature/APP-42" },
      codebase: { id: "codebase-1", agentId: "agent-1" },
      agent: { id: "agent-1" },
      repo: { id: "repository-1" },
      ticket: { key: "APP-42" },
    });
    const github = {
      pullRequest: vi.fn().mockResolvedValue({
        id: "pull-request-1",
        number: 42,
        title: "Ship widgets",
        url: "https://github.com/acme/widgets/pull/42",
        codebaseRepositoryId: "repository-1",
        repositoryGithubId: "github-repository-1",
        repositoryNameWithOwner: "acme/widgets",
        repositoryUrl: "https://github.com/acme/widgets",
        headRefName: "feature/APP-42",
        baseRefName: "main",
        worktreeId: "worktree-1",
        jiraKey: "APP-42",
        reviewThreads: [
          { id: "thread-1", isResolved: false },
          { id: "thread-2", isResolved: true },
        ],
      }),
    };
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ticketKeyForWorktree: vi.fn(),
        workflowSessionDataForWorktree,
      },
      undefined,
      github as never,
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("PULL_REQUEST", "acme/widgets#42", {
        pr: { number: 42 },
      }),
    ).resolves.toMatchObject({
      pr: {
        id: "pull-request-1",
        number: 42,
        headBranch: "feature/APP-42",
        baseBranch: "main",
        unresolvedThreads: [{ id: "thread-1" }],
      },
      worktree: { id: "worktree-1" },
      agent: { id: "agent-1" },
      repo: { id: "repository-1" },
      ticket: { key: "APP-42" },
    });
  });

  test("hydrates a Jira launch with ticket details and the latest comment", async () => {
    const jira = {
      ticket: vi.fn().mockResolvedValue({
        key: "APP-42",
        summary: "Ship widgets",
        issueType: "Task",
        status: "In Progress",
        jiraUrl: "https://jira.example/browse/APP-42",
        comments: [
          {
            id: "comment-1",
            content: { rawText: "Please ship it" },
            author: { displayName: "Chandler" },
          },
        ],
      }),
    };
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jira as never,
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("JIRA_TICKET", "APP-42", {
        ticket: { key: "APP-42" },
      }),
    ).resolves.toMatchObject({
      ticket: {
        key: "APP-42",
        title: "Ship widgets",
        type: "Task",
        status: "In Progress",
      },
      comment: {
        id: "comment-1",
        body: "Please ship it",
      },
    });
  });
});

describe("workflow agent-job session hydration", () => {
  test("refreshes rich context after creating a worktree", async () => {
    let completionObserver:
      | ((job: {
          id: string;
          kind: string;
          status: string;
          resultJson: string | null;
          error: string | null;
          codebaseId?: string | null;
          worktreeId?: string | null;
        }) => Promise<void>)
      | undefined;
    const agentControl = {
      registerCompletionHandler: vi.fn(),
      registerCompletionObserver: vi.fn((handler) => {
        completionObserver = handler;
      }),
    };
    const richContext = {
      worktree: {
        id: "worktree-1",
        path: "/repo/.worktrees/feature",
        branch: "feature/APP-42",
      },
      codebase: { id: "codebase-1", agentId: "agent-1" },
      agent: { id: "agent-1", name: "Studio Mac" },
      repo: { id: "repository-1", name: "Widgets" },
      ticket: { key: "APP-42" },
    };
    const workflowSessionDataForWorktree = vi
      .fn()
      .mockResolvedValue(richContext);
    prisma.worktree.findFirst.mockResolvedValue({
      id: "worktree-1",
      codebase: {
        id: "codebase-1",
        folder: "/repo",
        agentId: "agent-1",
        branch: "main",
        headSha: "base-sha",
        defaultBranch: "main",
        agent: {
          id: "agent-1",
          name: "Studio Mac",
          hostname: "studio.local",
        },
        repository: {
          id: "repository-1",
          name: "Widgets",
          displayOrigin: "github.com/acme/widgets",
          canonicalOrigin: "github.com/acme/widgets",
        },
      },
    });
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      agentControl as never,
      undefined,
      undefined,
      {
        ticketKeyForWorktree: vi.fn(),
        workflowSessionDataForWorktree,
      },
    );
    const resolveExternalWait = vi
      .spyOn(service, "resolveExternalWait")
      .mockResolvedValue(1);

    await completionObserver?.({
      id: "job-1",
      kind: "worktree.branch",
      status: "SUCCEEDED",
      resultJson: JSON.stringify({
        worktree: { gitDirectory: "/repo/.git/worktrees/feature" },
      }),
      error: null,
      codebaseId: "codebase-1",
      worktreeId: null,
    });

    expect(workflowSessionDataForWorktree).toHaveBeenCalledWith("worktree-1", {
      includeMissing: true,
    });
    expect(resolveExternalWait).toHaveBeenCalledWith(
      "AGENT_JOB",
      "job-1",
      expect.objectContaining({ sessionPatch: richContext }),
      null,
    );
  });
});

describe("workflow sub-workflow validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (
        operation: unknown[] | ((transaction: typeof prisma) => unknown),
      ) =>
        typeof operation === "function"
          ? operation(prisma)
          : Promise.all(operation),
    );
  });

  test("rejects indirect recursion through pinned versions", async () => {
    const draft = subworkflowDefinition("Workflow A", "version-b");
    prisma.workflow.findUnique.mockResolvedValue({
      id: "workflow-a",
      draftDefinitionJson: JSON.stringify(draft),
      activeVersion: null,
      versions: [],
      _count: { runs: 0 },
    });
    const versions = [
      {
        id: "version-b",
        workflowId: "workflow-b",
        definitionJson: JSON.stringify(
          subworkflowDefinition("Workflow B", "version-a"),
        ),
      },
      {
        id: "version-a",
        workflowId: "workflow-a",
        definitionJson: JSON.stringify(emptyWorkflowDefinition("Workflow A")),
      },
    ];
    prisma.workflowVersion.findMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] } } }) =>
        versions.filter(({ id }) => where.id.in.includes(id)),
    );

    const service = new WorkflowsService(new WorkflowEventsService());
    const result = await service.validateDraft("workflow-a");

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SUBWORKFLOW_RECURSION",
        nodeId: "subworkflow",
      }),
    );
  });
});

describe("workflow runtime lifecycle guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (
        operation: unknown[] | ((transaction: typeof prisma) => unknown),
      ) =>
        typeof operation === "function"
          ? operation(prisma)
          : Promise.all(operation),
    );
    prisma.workflowRunEvent.findFirst.mockResolvedValue(null);
    prisma.workflowRunEvent.create.mockResolvedValue({ id: "event-1" });
    prisma.workflowRun.update.mockResolvedValue({});
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.workflowStepAttempt.update.mockResolvedValue({});
    prisma.workflowStepAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.workflowWait.create.mockResolvedValue({});
    prisma.workflowResourceLease.deleteMany.mockResolvedValue({ count: 0 });
  });

  function internals(service: WorkflowsService) {
    return service as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
  }

  test("keeps a run open while a retry wait is pending", async () => {
    const definition = emptyWorkflowDefinition("Retry workflow");
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      workflowId: "workflow-1",
      displayNumber: 1,
      status: "WAITING",
      generation: 0,
      sessionDataJson: "{}",
      version: { definitionJson: JSON.stringify(definition) },
      trigger: null,
      attempts: [
        {
          id: "attempt-1",
          nodeId: "step-1",
          iterationKey: "",
          generation: 0,
          supersededAt: null,
          attempt: 0,
          status: "FAILED",
          error: "Try again",
        },
      ],
      waits: [{ status: "PENDING" }],
    });

    const service = new WorkflowsService(new WorkflowEventsService());
    await internals(service).progressRun("run-1");

    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowRunEvent.create).not.toHaveBeenCalled();
  });

  test("does not move a pausing run back to running when a step completes", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "PAUSING",
      sessionDataJson: "{}",
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).completeAttempt(
      { id: "attempt-1", runId: "run-1", iterationKey: "" },
      { id: "step-1", name: "Step one" },
      { output: { ok: true } },
    );

    const update = prisma.workflowRun.update.mock.calls[0]?.[0];
    expect(update.data).not.toHaveProperty("status");
    expect(update.data).not.toHaveProperty("phase");
  });

  test("does not create a wait after its run was cancelled", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({ status: "CANCELLED" });
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).parkAttempt(
      { id: "attempt-1", runId: "run-1" },
      { wait: { kind: "DELAY", resumeAfter: new Date() } },
    );

    expect(prisma.workflowStepAttempt.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowWait.create).not.toHaveBeenCalled();
    expect(prisma.workflowRunEvent.create).not.toHaveBeenCalled();
  });

  test("drops a stale completion after cancellation claims the attempt", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "RUNNING",
      sessionDataJson: "{}",
    });
    prisma.workflowStepAttempt.updateMany.mockResolvedValueOnce({ count: 0 });
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).completeAttempt(
      { id: "attempt-1", runId: "run-1", iterationKey: "" },
      { id: "step-1", name: "Step one" },
      { output: { ok: true } },
    );

    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
    expect(prisma.workflowRunEvent.create).not.toHaveBeenCalled();
  });

  test("schedules a retry without overriding a pausing lifecycle", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "PAUSING",
      sessionDataJson: "{}",
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).failAttempt(
      {
        id: "attempt-1",
        runId: "run-1",
        nodeId: "step-1",
        iterationKey: "",
        attempt: 0,
      },
      {
        id: "step-1",
        retry: {
          maxAttempts: 2,
          strategy: "EXPONENTIAL",
          delaySeconds: 5,
        },
      },
      new Error("Try again"),
    );

    const update = prisma.workflowRun.update.mock.calls[0]?.[0];
    expect(update.data).not.toHaveProperty("status");
    expect(update.data).not.toHaveProperty("phase");
    expect(prisma.workflowWait.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "RETRY", runId: "run-1" }),
    });
  });

  test("holds a step in the queue while the codebase is busy", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());
    const workerId = (service as unknown as { workerId: string }).workerId;

    const held = await internals(service).holdForBusyCodebase(
      {
        id: "attempt-1",
        runId: "run-1",
        phase: "RUNNING",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      new CodebaseBusyError(),
    );

    expect(held).toBe(true);
    expect(prisma.workflowStepAttempt.updateMany).toHaveBeenCalledWith({
      where: { id: "attempt-1", status: "RUNNING", claimOwner: workerId },
      data: expect.objectContaining({
        status: "READY",
        phase: "WAITING_FOR_RESOURCE",
        claimOwner: null,
        claimExpiresAt: null,
      }),
    });
    expect(prisma.workflowResourceLease.deleteMany).toHaveBeenCalledWith({
      where: { attemptId: "attempt-1" },
    });
    expect(prisma.workflowRunEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "STEP_WAITING_FOR_RESOURCE" }),
    });
  });

  test("stops holding a busy step once its hold budget runs out", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());

    const held = await internals(service).holdForBusyCodebase(
      {
        id: "attempt-1",
        runId: "run-1",
        phase: "WAITING_FOR_RESOURCE",
        startedAt: new Date(Date.now() - 11 * 60_000),
        createdAt: new Date(Date.now() - 11 * 60_000),
      },
      new CodebaseBusyError(),
    );

    expect(held).toBe(false);
    expect(prisma.workflowStepAttempt.updateMany).not.toHaveBeenCalled();
  });

  test("does not hold a step for an unrelated failure", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());

    const held = await internals(service).holdForBusyCodebase(
      {
        id: "attempt-1",
        runId: "run-1",
        phase: "RUNNING",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      new Error("Worktree is unavailable"),
    );

    expect(held).toBe(false);
    expect(prisma.workflowStepAttempt.updateMany).not.toHaveBeenCalled();
  });

  test("only logs the wait once while a step keeps holding", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());
    prisma.workflowRunEvent.findFirst.mockResolvedValue({ id: "wait-event" });

    await internals(service).holdForBusyCodebase(
      {
        id: "attempt-1",
        runId: "run-1",
        phase: "RUNNING",
        startedAt: new Date(),
        createdAt: new Date(),
      },
      new CodebaseBusyError(),
    );

    expect(prisma.workflowStepAttempt.updateMany).toHaveBeenCalled();
    expect(prisma.workflowRunEvent.create).not.toHaveBeenCalled();
  });

  test("only resolves due waits for scheduling runs", async () => {
    prisma.workflowWait.findMany.mockResolvedValue([]);
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).resolveDueWaits();

    expect(prisma.workflowWait.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          run: { status: { in: ["RUNNING", "WAITING"] } },
        }),
      }),
    );
  });

  function pendingCommandWait(config: Record<string, unknown>) {
    const definition = emptyWorkflowDefinition("Wait timing");
    definition.nodes = [
      {
        id: "step-1",
        kind: "CUSTOM_COMMAND",
        position: { x: 0, y: 0 },
        config,
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
    ];
    return {
      id: "wait-1",
      runId: "run-1",
      attemptId: "attempt-1",
      kind: "COMMAND_RUN",
      externalKey: "command-run-1",
      status: "PENDING",
      timeoutAt: null,
      predicateJson: null,
      attempt: {
        id: "attempt-1",
        runId: "run-1",
        nodeId: "step-1",
        run: {
          id: "run-1",
          sessionDataJson: "{}",
          version: { definitionJson: JSON.stringify(definition) },
        },
      },
    };
  }

  test("polls a pending wait on the step's configured cadence", async () => {
    prisma.workflowWait.findMany.mockResolvedValue([
      pendingCommandWait({ cadenceSeconds: 45 }),
    ]);
    prisma.workflowWait.updateMany.mockResolvedValue({ count: 1 });
    const service = new WorkflowsService(new WorkflowEventsService());
    service.registerWaitPoller("COMMAND_RUN", async () => ({
      pending: true,
      pollAfterSeconds: 1,
    }));

    await internals(service).resolveDueWaits();

    const update = prisma.workflowWait.updateMany.mock.calls[0]?.[0];
    expect(
      Math.round((update.data.resumeAfter.getTime() - Date.now()) / 1_000),
    ).toBe(45);
  });

  test("keeps the poller's own cadence when the step configures none", async () => {
    prisma.workflowWait.findMany.mockResolvedValue([pendingCommandWait({})]);
    prisma.workflowWait.updateMany.mockResolvedValue({ count: 1 });
    const service = new WorkflowsService(new WorkflowEventsService());
    service.registerWaitPoller("COMMAND_RUN", async () => ({
      pending: true,
      pollAfterSeconds: 7,
    }));

    await internals(service).resolveDueWaits();

    const update = prisma.workflowWait.updateMany.mock.calls[0]?.[0];
    expect(
      Math.round((update.data.resumeAfter.getTime() - Date.now()) / 1_000),
    ).toBe(7);
  });

  test("parks ready attempts as part of requesting a pause", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({ status: "RUNNING" });
    const service = new WorkflowsService(new WorkflowEventsService());

    await service.lifecycle("run-1", "PAUSE");

    expect(prisma.workflowStepAttempt.updateMany).toHaveBeenCalledWith({
      where: { runId: "run-1", status: "READY" },
      data: { status: "PENDING", phase: "PAUSED_PENDING" },
    });
  });

  test("links a resource-manual run when it is created", async () => {
    const version = { id: "version-1", name: "Resource workflow" };
    prisma.workflowRun.findUnique.mockResolvedValue(null);
    prisma.workflowRunNumberSequence.upsert.mockResolvedValue({ nextValue: 2 });
    prisma.workflowRun.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).createRunForTrigger(
      {
        id: "workflow-1",
        overlapPolicy: "CONCURRENT",
        activeVersion: version,
      },
      version,
      null,
      null,
      "RESOURCE_MANUAL",
      "WORKTREE:worktree-1",
      {
        sessionData: {},
        resourceKind: "worktree",
        resourceId: "worktree-1",
      },
      "idempotency-1",
    );

    expect(prisma.workflowRunResourceLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        runId: expect.any(String),
        kind: "WORKTREE",
        resourceId: "worktree-1",
      }),
    });
  });

  test("links event-triggered runs to the resource that caused the event", async () => {
    const version = { id: "version-1", name: "Run workflow" };
    prisma.workflowRun.findUnique.mockResolvedValue(null);
    prisma.workflowRunNumberSequence.upsert.mockResolvedValue({ nextValue: 3 });
    prisma.workflowRun.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).createRunForTrigger(
      {
        id: "workflow-1",
        overlapPolicy: "CONCURRENT",
        activeVersion: version,
      },
      version,
      null,
      null,
      "RUN_COMPLETED",
      "agent-run-1",
      {
        sessionData: { run: { id: "agent-run-1", kind: "PLAN" } },
      },
      "idempotency-2",
    );

    expect(prisma.workflowRunResourceLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "AGENT_RUN",
        resourceId: "agent-run-1",
        metadataJson: JSON.stringify({ runKind: "PLAN" }),
      }),
    });
  });

  test("loads attempt resource links and question batches for resource-panel runs", async () => {
    prisma.workflowRunResourceLink.findMany.mockResolvedValue([
      { runId: "run-1" },
    ]);
    prisma.workflowRun.findMany.mockResolvedValue([]);
    const service = new WorkflowsService(new WorkflowEventsService());

    await service.runsForResource("WORKTREE", "worktree-1");

    expect(prisma.workflowRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          attempts: expect.objectContaining({
            include: {
              resourceLinks: { orderBy: { createdAt: "asc" } },
              questionBatches: {
                orderBy: { createdAt: "asc" },
                include: {
                  questions: {
                    orderBy: { position: "asc" },
                    include: { options: { orderBy: { position: "asc" } } },
                  },
                },
              },
            },
          }),
        }),
      }),
    );
  });
});

describe("workflow trigger interpolation", () => {
  beforeEach(() => vi.clearAllMocks());

  function matches(
    kind: string,
    config: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
    const service = new WorkflowsService(
      new WorkflowEventsService(),
    ) as unknown as Record<string, (...args: unknown[]) => Promise<boolean>>;
    return service.triggerMatches!(
      { id: "trigger-1", kind, configJson: JSON.stringify(config) },
      "PULL_REQUEST:1",
      payload,
    );
  }

  const pullRequest = {
    pr: { author: "octocat", base: "main" },
    repo: { owner: "octocat" },
    worktree: { baseBranch: "main" },
  };

  test("resolves filter values against the event payload", async () => {
    await expect(
      matches(
        "GITHUB_PR_STATE",
        { filters: { "pr.author": "{{repo.owner}}" } },
        pullRequest,
      ),
    ).resolves.toBe(true);
    await expect(
      matches(
        "GITHUB_PR_STATE",
        { filters: { "pr.base": "{{worktree.baseBranch}}-next" } },
        pullRequest,
      ),
    ).resolves.toBe(false);
  });

  test("resolves a session binding in a filter", async () => {
    await expect(
      matches(
        "GITHUB_PR_STATE",
        {
          filters: {
            "pr.base": { source: "SESSION", path: "worktree.baseBranch" },
          },
        },
        pullRequest,
      ),
    ).resolves.toBe(true);
  });

  test("interpolates the issue command pattern before compiling it", async () => {
    const payload = {
      ...pullRequest,
      comment: { author: { login: "octocat" }, body: "/deploy main" },
    };
    await expect(
      matches(
        "GITHUB_ISSUE_COMMAND",
        {
          allowedLogins: ["octocat"],
          commandPattern: "^/deploy {{worktree.baseBranch}}$",
        },
        payload,
      ),
    ).resolves.toBe(true);
  });

  test("fires disk thresholds only on false-to-true crossings", async () => {
    prisma.workflowTriggerState.findUnique
      .mockResolvedValueOnce({ lastMatched: false })
      .mockResolvedValueOnce({ lastMatched: true })
      .mockResolvedValueOnce({ lastMatched: true })
      .mockResolvedValueOnce({ lastMatched: false });
    const config = {
      thresholdPath: "disk.freeGiB",
      thresholdOperator: "LT",
      thresholdValue: 10,
    };

    await expect(
      matches("AGENT_DISK_THRESHOLD", config, { disk: { freeGiB: 8 } }),
    ).resolves.toBe(true);
    await expect(
      matches("AGENT_DISK_THRESHOLD", config, { disk: { freeGiB: 7 } }),
    ).resolves.toBe(false);
    await expect(
      matches("AGENT_DISK_THRESHOLD", config, { disk: { freeGiB: 15 } }),
    ).resolves.toBe(false);
    await expect(
      matches("AGENT_DISK_THRESHOLD", config, { disk: { freeGiB: 9 } }),
    ).resolves.toBe(true);
  });

  test("does not cursor-suppress repeated cleanup result events", async () => {
    const config = { filters: { "cleanup.status": "SUCCEEDED" } };

    await expect(
      matches("AGENT_DISK_CLEANUP_RESULT", config, {
        cleanup: { jobId: "job-1", status: "SUCCEEDED" },
      }),
    ).resolves.toBe(true);
    await expect(
      matches("AGENT_DISK_CLEANUP_RESULT", config, {
        cleanup: { jobId: "job-2", status: "SUCCEEDED" },
      }),
    ).resolves.toBe(true);
  });
});

describe("workflow choice triggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (
        operation: unknown[] | ((transaction: typeof prisma) => unknown),
      ) =>
        typeof operation === "function"
          ? operation(prisma)
          : Promise.all(operation),
    );
  });

  const choiceDefinition = () => {
    const definition = emptyWorkflowDefinition("Choice workflow");
    definition.triggers = [
      {
        id: "choose",
        kind: "MANUAL_CHOICE",
        position: { x: 0, y: 0 },
        config: {
          choices: [
            { key: "draft", label: "Draft" },
            { key: "ready", label: "Ready" },
          ],
        },
      },
    ];
    return definition;
  };

  const publishedWorkflow = (definition: WorkflowDefinition) => ({
    id: "workflow-1",
    enabled: true,
    archivedAt: null,
    overlapPolicy: "CONCURRENT",
    activeVersion: {
      id: "version-1",
      name: definition.name,
      definitionJson: JSON.stringify(definition),
      triggers: definition.triggers.map((trigger) => ({
        id: `db-${trigger.id}`,
        nodeId: trigger.id,
        kind: trigger.kind,
        configJson: JSON.stringify(trigger.config),
      })),
    },
  });

  test("records the picked option on the run it starts", async () => {
    const definition = choiceDefinition();
    prisma.workflow.findUnique.mockResolvedValue(publishedWorkflow(definition));
    // First lookup is the idempotency check inside the transaction; the second
    // is `run()` reading the created run back out.
    prisma.workflowRun.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: "run-1" });
    prisma.workflowRunNumberSequence.upsert.mockResolvedValue({ nextValue: 1 });
    prisma.workflowRun.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await service.trigger({ workflowId: "workflow-1", choice: "ready" });

    const { data } = prisma.workflowRun.create.mock.calls[0]![0] as {
      data: Record<string, string>;
    };
    expect(data.triggerKind).toBe("MANUAL_CHOICE");
    expect(data.triggerId).toBe("db-choose");
    expect(JSON.parse(data.triggerPayloadJson!).choice).toBe("ready");
    expect(JSON.parse(data.sessionDataJson!).workflow.trigger.choice).toBe(
      "ready",
    );
  });

  test("rejects an option the trigger does not offer", async () => {
    prisma.workflow.findUnique.mockResolvedValue(
      publishedWorkflow(choiceDefinition()),
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await expect(
      service.trigger({ workflowId: "workflow-1", choice: "shipped" }),
    ).rejects.toThrow(/Unknown choice/);
  });

  test("refuses a plain run when the workflow only offers choices", async () => {
    prisma.workflow.findUnique.mockResolvedValue(
      publishedWorkflow(choiceDefinition()),
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await expect(service.trigger({ workflowId: "workflow-1" })).rejects.toThrow(
      /needs a choice: draft, ready/,
    );
  });

  test("activates only the edge leaving the option that was picked", () => {
    const definition = choiceDefinition();
    const service = new WorkflowsService(
      new WorkflowEventsService(),
    ) as unknown as {
      selectedTrigger: (
        run: unknown,
        definition: WorkflowDefinition,
      ) => { id: string | null; choice: string | null };
      edgeState: (
        edge: unknown,
        selected: { id: string | null; choice: string | null },
        attempts: Map<string, unknown>,
        nodeById: Map<string, unknown>,
      ) => string;
    };
    const selected = service.selectedTrigger(
      {
        triggerKind: "MANUAL_CHOICE",
        trigger: { nodeId: "choose" },
        triggerPayloadJson: JSON.stringify({ choice: "ready" }),
      },
      definition,
    );

    const edgeFrom = (sourceHandle: string) => ({
      id: `edge-${sourceHandle}`,
      source: "choose",
      target: "step",
      sourceHandle,
      targetHandle: "input",
    });
    const state = (sourceHandle: string) =>
      service.edgeState(edgeFrom(sourceHandle), selected, new Map(), new Map());

    expect(selected.choice).toBe("ready");
    expect(state("ready")).toBe("ACTIVE");
    expect(state("draft")).toBe("INACTIVE");
  });
});

describe("workflow run worktree tint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves the linked worktree from session data", async () => {
    prisma.worktree.findUnique.mockResolvedValue({
      id: "worktree-1",
      folder: "/tmp/feature",
      branch: "feature",
      highlightColor: "violet",
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    const worktree = await service.runWorktree(
      JSON.stringify({ worktree: { id: "worktree-1" } }),
    );

    expect(prisma.worktree.findUnique).toHaveBeenCalledWith({
      where: { id: "worktree-1" },
      select: { id: true, folder: true, branch: true, highlightColor: true },
    });
    expect(worktree).toMatchObject({ highlightColor: "violet" });
  });

  test("skips the lookup when the run has no worktree", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());

    expect(
      await service.runWorktree(JSON.stringify({ codebase: { id: "code-1" } })),
    ).toBeNull();
    expect(prisma.worktree.findUnique).not.toHaveBeenCalled();
  });
});
