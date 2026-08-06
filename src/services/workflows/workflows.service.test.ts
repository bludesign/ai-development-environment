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
  workflow: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  codebaseRepository: { count: vi.fn() },
  worktree: { findUnique: vi.fn(), findFirst: vi.fn() },
  agent: { findUnique: vi.fn() },
  codebase: { findUnique: vi.fn() },
  build: { findUnique: vi.fn() },
  agentRun: { findUnique: vi.fn(), findFirst: vi.fn() },
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
    count: vi.fn(),
  },
  worktreeAdmissionLane: { upsert: vi.fn() },
  worktreeWorkflowLease: {
    findUnique: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  worktreeRunLease: { count: vi.fn(), deleteMany: vi.fn() },
  workflowRunNumberSequence: { upsert: vi.fn() },
  workflowRunResourceLink: {
    create: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
  },
  workflowStepAttempt: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
    createMany: vi.fn(),
  },
  workflowWait: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  workflowTriggerState: { findUnique: vi.fn(), upsert: vi.fn() },
  workflowTriggerEvent: {
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  workflowTriggerDelivery: { findUnique: vi.fn(), create: vi.fn() },
  workflowResourceLease: { deleteMany: vi.fn() },
  workflowRunEvent: { findFirst: vi.fn(), create: vi.fn() },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => prisma,
}));

describe("workflow completion notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (operation: (transaction: typeof prisma) => unknown) =>
        operation(prisma),
    );
  });

  test("suppresses successful completion notifications without hiding failures", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({
      sessionDataJson: "{}",
      workflow: { completionNotificationsEnabled: false },
    });
    const notification = { id: "notification-1" };
    const recordInTransaction = vi.fn().mockResolvedValue(notification);
    const created = vi.fn();
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      { recordInTransaction, created } as never,
    ) as unknown as {
      notifyRun(
        runId: string,
        typeKey: "WORKFLOW_COMPLETED" | "WORKFLOW_FAILED",
        title: string,
        body: string,
        dedupeSuffix: string,
      ): Promise<void>;
    };

    await service.notifyRun(
      "run-1",
      "WORKFLOW_COMPLETED",
      "Workflow completed",
      "Done",
      "succeeded",
    );
    expect(recordInTransaction).not.toHaveBeenCalled();

    await service.notifyRun(
      "run-1",
      "WORKFLOW_FAILED",
      "Workflow failed",
      "Failed",
      "failed",
    );
    expect(recordInTransaction).toHaveBeenCalledOnce();
    expect(created).toHaveBeenCalledWith(notification);
  });
});

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

  test("hydrates a pull-request launch from a persisted snapshot", async () => {
    const workflowSessionDataForPullRequest = vi.fn().mockResolvedValue({
      worktree: { id: "worktree-1", branch: "feature/APP-42" },
      codebase: { id: "codebase-1", agentId: "agent-1" },
      agent: { id: "agent-1" },
      repo: { id: "repository-1" },
      pr: { id: "pull-request-1", number: 42, title: "Stored title" },
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
        workflowSessionDataForPullRequest,
      },
    ) as unknown as {
      hydrateResourceSessionData(
        resourceKind: string,
        resourceId: string,
        sessionData: Record<string, unknown>,
      ): Promise<Record<string, unknown>>;
    };

    await expect(
      service.hydrateResourceSessionData("PULL_REQUEST", "acme/widgets#42", {
        pr: { number: 42, title: "Caller title" },
        repo: { displayOrigin: "github.com/acme/widgets" },
      }),
    ).resolves.toMatchObject({
      pr: {
        id: "pull-request-1",
        number: 42,
        title: "Caller title",
      },
      worktree: { id: "worktree-1" },
      agent: { id: "agent-1" },
      repo: { id: "repository-1" },
      ticket: { key: "APP-42" },
    });
    expect(workflowSessionDataForPullRequest).toHaveBeenCalledWith(
      "acme",
      "widgets",
      42,
    );
  });

  test("keeps minimal caller data when no pull-request snapshot exists", async () => {
    const workflowSessionDataForPullRequest = vi.fn().mockResolvedValue({});
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
        workflowSessionDataForPullRequest,
      },
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
        repo: { displayOrigin: "github.com/acme/widgets" },
      }),
    ).resolves.toEqual({
      pr: { number: 42 },
      repo: { displayOrigin: "github.com/acme/widgets" },
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

  test("validates command patterns with the server RE2 implementation", async () => {
    const draft = emptyWorkflowDefinition("Command matcher");
    draft.nodes = [
      {
        id: "command",
        kind: "CUSTOM_COMMAND",
        position: { x: 200, y: 100 },
        config: {
          script: "serve",
          completionMode: "WAIT_FOR_EXIT",
          outputPattern: "(?=ready)",
        },
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
    ];
    draft.edges = [
      {
        id: "start-command",
        source: "manual",
        target: "command",
        sourceHandle: "success",
        targetHandle: "input",
      },
    ];
    prisma.workflow.findUnique.mockResolvedValue({
      id: "workflow-a",
      draftDefinitionJson: JSON.stringify(draft),
      activeVersion: null,
      versions: [],
      _count: { runs: 0 },
    });

    const service = new WorkflowsService(new WorkflowEventsService());
    const result = await service.validateDraft("workflow-a");

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMMAND_MATCH_PATTERN_INVALID",
        nodeId: "command",
      }),
    );

    draft.nodes[0]!.config.outputPattern = "\\Aready\\z";
    prisma.workflow.findUnique.mockResolvedValue({
      id: "workflow-a",
      draftDefinitionJson: JSON.stringify(draft),
      activeVersion: null,
      versions: [],
      _count: { runs: 0 },
    });
    await expect(service.validateDraft("workflow-a")).resolves.toMatchObject({
      valid: true,
    });

    draft.nodes[0]!.config.outputPattern = "\\b";
    prisma.workflow.findUnique.mockResolvedValue({
      id: "workflow-a",
      draftDefinitionJson: JSON.stringify(draft),
      activeVersion: null,
      versions: [],
      _count: { runs: 0 },
    });
    const zeroWidth = await service.validateDraft("workflow-a");
    expect(zeroWidth.valid).toBe(false);
    expect(zeroWidth.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMMAND_MATCH_PATTERN_INVALID",
        nodeId: "command",
        message: expect.stringMatching(/consume/),
      }),
    );
  });
});

describe("workflow trigger event processing", () => {
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
    prisma.workflowTriggerEvent.update.mockResolvedValue({});
    prisma.workflowTriggerEvent.delete.mockResolvedValue({});
    prisma.workflowTriggerDelivery.findUnique.mockResolvedValue(null);
    prisma.workflowTriggerDelivery.create.mockResolvedValue({});
  });

  function internals(service: WorkflowsService) {
    return service as unknown as {
      processTriggerEvents(): Promise<void>;
    };
  }

  test("loads active workflows once for a batch and deletes every success", async () => {
    prisma.workflowTriggerEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        kind: "RUN_COMPLETED",
        subjectKey: "run-1",
        dedupeKey: "run-status:run-1:COMPLETED",
        payloadJson: "{}",
        receivedAt: new Date(),
      },
      {
        id: "event-2",
        kind: "RUN_COMPLETED",
        subjectKey: "run-2",
        dedupeKey: "run-status:run-2:COMPLETED",
        payloadJson: "{}",
        receivedAt: new Date(),
      },
    ]);
    prisma.workflow.findMany.mockResolvedValue([]);

    await internals(
      new WorkflowsService(new WorkflowEventsService()),
    ).processTriggerEvents();

    expect(prisma.workflow.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.workflowTriggerEvent.delete).toHaveBeenNthCalledWith(1, {
      where: { id: "event-1" },
    });
    expect(prisma.workflowTriggerEvent.delete).toHaveBeenNthCalledWith(2, {
      where: { id: "event-2" },
    });
    expect(prisma.workflowTriggerEvent.update).not.toHaveBeenCalled();
  });

  test("uses the producer dedupe key for run idempotency", async () => {
    prisma.workflowTriggerEvent.findMany.mockResolvedValue([
      {
        id: "temporary-event-id",
        kind: "RUN_COMPLETED",
        subjectKey: "run-1",
        dedupeKey: "run-status:run-1:COMPLETED",
        payloadJson: JSON.stringify({ sessionData: {} }),
        receivedAt: new Date(),
      },
    ]);
    prisma.workflow.findMany.mockResolvedValue([
      {
        id: "workflow-1",
        overlapPolicy: "CONCURRENT",
        activeVersion: {
          id: "version-1",
          name: "Run completion",
          triggers: [
            {
              id: "trigger-1",
              nodeId: "completed",
              kind: "RUN_COMPLETED",
              configJson: "{}",
            },
          ],
        },
      },
    ]);
    prisma.workflowRun.findUnique.mockResolvedValue({ id: "existing-run" });

    await internals(
      new WorkflowsService(new WorkflowEventsService()),
    ).processTriggerEvents();

    const deliveryId = prisma.workflowTriggerDelivery.findUnique.mock
      .calls[0]?.[0].where.id as string;
    expect(deliveryId).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.workflowRun.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: deliveryId },
    });
    expect(prisma.workflowTriggerDelivery.create).toHaveBeenCalledWith({
      data: { id: deliveryId, runId: "existing-run" },
    });
  });

  test("skips trigger evaluation when the target delivery already exists", async () => {
    prisma.workflowTriggerEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        kind: "RUN_COMPLETED",
        subjectKey: "run-1",
        dedupeKey: "run-status:run-1:COMPLETED",
        payloadJson: JSON.stringify({ sessionData: {}, cursorValue: "done" }),
        receivedAt: new Date(),
      },
    ]);
    prisma.workflow.findMany.mockResolvedValue([
      {
        id: "workflow-1",
        overlapPolicy: "CONCURRENT",
        activeVersion: {
          id: "version-1",
          name: "Run completion",
          triggers: [
            {
              id: "trigger-1",
              nodeId: "completed",
              kind: "RUN_COMPLETED",
              configJson: "{}",
            },
          ],
        },
      },
    ]);
    prisma.workflowTriggerDelivery.findUnique.mockResolvedValue({
      id: "delivered",
    });

    await internals(
      new WorkflowsService(new WorkflowEventsService()),
    ).processTriggerEvents();

    expect(prisma.workflowTriggerState.findUnique).not.toHaveBeenCalled();
    expect(prisma.workflowRun.findUnique).not.toHaveBeenCalled();
    expect(prisma.workflowTriggerEvent.delete).toHaveBeenCalledWith({
      where: { id: "event-1" },
    });
  });

  test("records a delivery when an event coalesces into a queued run", async () => {
    prisma.workflowTriggerEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        kind: "RUN_COMPLETED",
        subjectKey: "run-1",
        dedupeKey: "run-status:run-1:COMPLETED",
        payloadJson: JSON.stringify({ sessionData: {} }),
        receivedAt: new Date(),
      },
    ]);
    prisma.workflow.findMany.mockResolvedValue([
      {
        id: "workflow-1",
        overlapPolicy: "COALESCE_LATEST",
        activeVersion: {
          id: "version-1",
          name: "Run completion",
          triggers: [
            {
              id: "trigger-1",
              nodeId: "completed",
              kind: "RUN_COMPLETED",
              configJson: "{}",
            },
          ],
        },
      },
    ]);
    prisma.workflowRun.findUnique.mockResolvedValue(null);
    prisma.workflowRun.findFirst.mockResolvedValue({ id: "queued-run" });
    prisma.workflowRun.update.mockResolvedValue({ id: "queued-run" });

    await internals(
      new WorkflowsService(new WorkflowEventsService()),
    ).processTriggerEvents();

    const deliveryId = prisma.workflowTriggerDelivery.findUnique.mock
      .calls[0]?.[0].where.id as string;
    expect(prisma.workflowTriggerDelivery.create).toHaveBeenCalledWith({
      data: { id: deliveryId, runId: "queued-run" },
    });
    expect(prisma.workflowTriggerEvent.delete).toHaveBeenCalledWith({
      where: { id: "event-1" },
    });
  });

  test("retains the payload when processing fails", async () => {
    prisma.workflowTriggerEvent.findMany.mockResolvedValue([
      {
        id: "event-1",
        kind: "RUN_COMPLETED",
        subjectKey: "run-1",
        dedupeKey: "run-status:run-1:COMPLETED",
        payloadJson: "not-json",
        receivedAt: new Date(),
      },
    ]);
    prisma.workflow.findMany.mockResolvedValue([]);

    await internals(
      new WorkflowsService(new WorkflowEventsService()),
    ).processTriggerEvents();

    expect(prisma.workflowTriggerEvent.update).toHaveBeenCalledWith({
      where: { id: "event-1" },
      data: expect.objectContaining({
        status: "FAILED",
        error: expect.any(String),
      }),
    });
    expect(
      prisma.workflowTriggerEvent.update.mock.calls[0]?.[0].data,
    ).not.toHaveProperty("payloadJson");
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
      { id: "step-1", name: "Step one" },
      { wait: { kind: "DELAY", resumeAfter: new Date() } },
    );

    expect(prisma.workflowStepAttempt.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowWait.create).not.toHaveBeenCalled();
    expect(prisma.workflowRunEvent.create).not.toHaveBeenCalled();
  });

  test("names the step and what it parked on when a step waits", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({ status: "RUNNING" });
    const service = new WorkflowsService(new WorkflowEventsService());
    const timeoutAt = new Date("2026-08-05T12:00:00.000Z");

    await internals(service).parkAttempt(
      { id: "attempt-1", runId: "run-1" },
      { id: "step-1", name: "Commit changes" },
      { wait: { kind: "AGENT_JOB", externalKey: "job-1", timeoutAt } },
    );

    const event = prisma.workflowRunEvent.create.mock.calls.at(-1)?.[0] as {
      data: { type: string; message: string; detailJson: string };
    };
    expect(event.data.type).toBe("STEP_WAITING");
    expect(event.data.message).toBe(
      "Step Commit changes is waiting for agent job",
    );
    expect(JSON.parse(event.data.detailJson)).toMatchObject({
      kind: "AGENT_JOB",
      nodeId: "step-1",
      externalKey: "job-1",
      timeoutAt: timeoutAt.toISOString(),
    });
  });

  test("publishes command identity and empty match data while the command is running", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "RUNNING",
      sessionDataJson: "{}",
      exclusiveWorktree: false,
      worktreeId: null,
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).parkAttempt(
      {
        id: "attempt-1",
        runId: "run-1",
        iterationKey: "",
      },
      { id: "command", name: "Serve", kind: "CUSTOM_COMMAND" },
      {
        sessionPatch: {
          steps: {
            command: {
              commandRunId: "command-run-1",
              matches: [],
              latestMatch: null,
            },
          },
        },
        wait: { kind: "COMMAND_RUN", externalKey: "command-run-1" },
      },
    );

    const runUpdate = prisma.workflowRun.updateMany.mock.calls[0]?.[0];
    expect(JSON.parse(runUpdate.data.sessionDataJson)).toMatchObject({
      steps: {
        command: {
          commandRunId: "command-run-1",
          matches: [],
          latestMatch: null,
        },
      },
    });
    const attemptUpdate =
      prisma.workflowStepAttempt.updateMany.mock.calls[0]?.[0];
    expect(
      JSON.parse(attemptUpdate.data.outputJson).sessionPatch,
    ).toBeUndefined();
  });

  test("reports how long a wait lasted and what freed it", async () => {
    prisma.workflowWait.findFirst.mockResolvedValue({
      id: "wait-1",
      kind: "AGENT_JOB",
      externalKey: "job-1",
      createdAt: new Date("2026-08-05T11:00:00.000Z"),
      resolvedAt: new Date("2026-08-05T11:02:08.000Z"),
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).appendWaitResolvedEvent(
      { id: "attempt-1", runId: "run-1" },
      { id: "step-1", name: "Commit changes" },
      "POLL",
    );

    const event = prisma.workflowRunEvent.create.mock.calls.at(-1)?.[0] as {
      data: { type: string; message: string; detailJson: string };
    };
    expect(event.data.type).toBe("STEP_WAIT_RESOLVED");
    expect(event.data.message).toBe(
      "Step Commit changes resumed after waiting 2m 8s for agent job",
    );
    expect(JSON.parse(event.data.detailJson)).toMatchObject({
      waitId: "wait-1",
      waitedMs: 128_000,
      resolvedBy: "POLL",
    });
  });

  test("completes a resolved wait even when its diagnostic event fails", async () => {
    const definition = emptyWorkflowDefinition("Wait completion");
    definition.nodes = [
      {
        id: "step-1",
        kind: "CUSTOM_COMMAND",
        position: { x: 0, y: 0 },
        config: {},
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
    ];
    prisma.workflowStepAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      runId: "run-1",
      nodeId: "step-1",
      iterationKey: "",
      status: "WAITING",
      outputJson: null,
      run: { version: { definitionJson: JSON.stringify(definition) } },
    });
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "WAITING",
      sessionDataJson: "{}",
    });
    prisma.workflowWait.findFirst.mockResolvedValue({
      id: "wait-1",
      kind: "COMMAND_RUN",
      externalKey: "command-run-1",
      createdAt: new Date("2026-08-05T11:00:00.000Z"),
      resolvedAt: new Date("2026-08-05T11:00:05.000Z"),
    });
    prisma.workflowRunEvent.create.mockRejectedValueOnce(
      new Error("database is locked"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).completeWaitingAttempt(
      "attempt-1",
      { ok: true },
      "POLL",
    );

    expect(prisma.workflowStepAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      }),
    );
    expect(prisma.workflowRunEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.workflowRunEvent.create.mock.calls[1]?.[0]).toEqual({
      data: expect.objectContaining({ type: "STEP_SUCCEEDED" }),
    });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("attempt-1"),
      expect.any(Error),
    );
    consoleError.mockRestore();
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

  test("rejects a session patch that changes an exclusive run's worktree", async () => {
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "run-1",
      status: "RUNNING",
      exclusiveWorktree: true,
      worktreeId: "worktree-1",
      sessionDataJson: JSON.stringify({ worktree: { id: "worktree-1" } }),
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    await expect(
      internals(service).completeAttempt(
        { id: "attempt-1", runId: "run-1", iterationKey: "" },
        { id: "move", name: "Move worktree" },
        { sessionPatch: { worktree: { id: "worktree-2" } } },
      ),
    ).rejects.toThrow(/Exclusive workflows cannot change worktrees/);

    expect(prisma.workflowStepAttempt.updateMany).not.toHaveBeenCalled();
    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
  });

  test("rejects a worktree move before an exclusive run executes it", async () => {
    const definition = emptyWorkflowDefinition("Exclusive move");
    definition.nodes = [
      {
        id: "move",
        kind: "WORKTREE_MOVE",
        name: "Move worktree",
        position: { x: 0, y: 0 },
        config: {},
        requiredPaths: [],
        providedPaths: [],
        retry: {
          maxAttempts: 1,
          strategy: "EXPONENTIAL",
          delaySeconds: 1,
        },
        failurePolicy: "FAIL",
      },
    ];
    prisma.workflowStepAttempt.findUnique.mockResolvedValue({
      id: "attempt-1",
      runId: "run-1",
      nodeId: "move",
      status: "RUNNING",
      iterationKey: "",
      run: {
        id: "run-1",
        status: "RUNNING",
        exclusiveWorktree: true,
        worktreeId: "worktree-1",
        sessionDataJson: JSON.stringify({ worktree: { id: "worktree-1" } }),
        version: { definitionJson: JSON.stringify(definition) },
      },
    });
    const execute = vi.fn();
    const service = new WorkflowsService(new WorkflowEventsService(), {
      execute,
    } as never);
    const serviceInternals = service as unknown as {
      executeAttempt(id: string, signal: AbortSignal): Promise<void>;
      failAttempt(...args: unknown[]): Promise<void>;
    };
    const failAttempt = vi
      .spyOn(serviceInternals, "failAttempt")
      .mockResolvedValue(undefined);

    await serviceInternals.executeAttempt(
      "attempt-1",
      new AbortController().signal,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(failAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ id: "attempt-1" }),
      expect.objectContaining({ kind: "WORKTREE_MOVE" }),
      expect.objectContaining({
        message: expect.stringMatching(/Exclusive workflows cannot run steps/),
      }),
    );
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

describe("workflow command output matching", () => {
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
    prisma.workflowWait.updateMany.mockResolvedValue({ count: 1 });
    prisma.workflowStepAttempt.createMany.mockResolvedValue({ count: 0 });
    prisma.workflowRun.update.mockResolvedValue({});
    prisma.workflowRunEvent.findFirst.mockResolvedValue(null);
    prisma.workflowRunEvent.create.mockResolvedValue({ id: "event-1" });
  });

  function commandDefinition() {
    const definition = emptyWorkflowDefinition("Command matcher");
    definition.nodes = [
      {
        id: "command",
        kind: "CUSTOM_COMMAND",
        position: { x: 100, y: 100 },
        config: {
          script: "serve",
          completionMode: "WAIT_FOR_EXIT",
          outputPattern: "ready",
        },
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
      {
        id: "matched",
        kind: "NOTIFICATION_SEND",
        position: { x: 300, y: 0 },
        config: {},
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
    ];
    definition.edges = [
      {
        id: "start",
        source: "manual",
        target: "command",
        sourceHandle: "success",
        targetHandle: "input",
      },
      {
        id: "matched",
        source: "command",
        target: "matched",
        sourceHandle: "match",
        targetHandle: "input",
      },
    ];
    return definition;
  }

  function matcherWait(
    pattern: string,
    mode: "ONCE" | "EACH_MATCH" = "EACH_MATCH",
  ) {
    return {
      id: "wait-1",
      runId: "workflow-run-1",
      attemptId: "workflow-attempt-1",
      kind: "COMMAND_RUN",
      status: "PENDING",
      predicateJson: JSON.stringify({
        outputMatch: {
          pattern,
          mode,
          matchCount: 0,
          matched: false,
          scanAttempt: 1,
          scanCharacterOffset: 0,
          observedAttempt: 0,
          observedSequence: -1,
        },
      }),
      externalKey: "command-run-1",
      attempt: {
        id: "workflow-attempt-1",
        runId: "workflow-run-1",
        nodeId: "command",
        kind: "CUSTOM_COMMAND",
        generation: 0,
        iterationKey: "",
        attempt: 0,
        status: "WAITING",
        outputJson: null,
        run: {
          id: "workflow-run-1",
          status: "WAITING",
          version: { definitionJson: JSON.stringify(commandDefinition()) },
        },
      },
    };
  }

  function outputService(
    rows: Array<{
      attempt: number;
      sequence: number;
      stream: "STDOUT" | "STDERR" | "SYSTEM";
      bytes: Buffer;
    }>,
  ) {
    const normalized = rows.map((row) => ({
      sequence: row.sequence,
      stream: row.stream,
      dataBase64: row.bytes.toString("base64"),
      byteLength: row.bytes.length,
      attempt: { attempt: row.attempt, runId: "command-run-1" },
    }));
    const listOutput = vi.fn(
      async (
        _runId: string,
        afterAttempt: number,
        afterSequence: number,
        first: number,
      ) =>
        normalized
          .filter(
            (row) =>
              row.attempt.attempt > afterAttempt ||
              (row.attempt.attempt === afterAttempt &&
                row.sequence > afterSequence),
          )
          .slice(0, first),
    );
    const commands = { listOutput, terminateRun: vi.fn() };
    const service = new WorkflowsService(
      new WorkflowEventsService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      commands as never,
    );
    return { service, commands };
  }

  function matcherInternals(service: WorkflowsService) {
    return service as unknown as {
      processCommandMatchWait(wait: unknown): Promise<void>;
      persistCommandMatches(
        wait: unknown,
        cursor: unknown,
        matches: unknown[],
      ): Promise<boolean>;
      progressRun(runId: string): Promise<void>;
      dispatchReadyAttempts(): Promise<void>;
      failCommandMatchWait(wait: unknown, error: Error): Promise<void>;
      failAttempt(
        attempt: unknown,
        node: unknown,
        error: Error,
        result?: unknown,
      ): Promise<void>;
    };
  }

  test("matches across split UTF-8 output chunks with captures", async () => {
    const bytes = Buffer.from("ready π=42", "utf8");
    const { service } = outputService([
      {
        attempt: 1,
        sequence: 0,
        stream: "STDOUT",
        bytes: bytes.subarray(0, 7),
      },
      {
        attempt: 1,
        sequence: 1,
        stream: "STDOUT",
        bytes: bytes.subarray(7),
      },
    ]);
    const internals = matcherInternals(service);
    const persist = vi.fn().mockResolvedValue(true);
    internals.persistCommandMatches = persist;

    await internals.processCommandMatchWait(
      matcherWait("ready π=(?<answer>[0-9]+)"),
    );

    expect(persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ matchCount: 1, scanCharacterOffset: 10 }),
      [
        expect.objectContaining({
          text: "ready π=42",
          captures: ["42"],
          namedCaptures: { answer: "42" },
          commandAttempt: 1,
          start: { sequence: 0, offset: 0 },
          end: { sequence: 1, offset: 4 },
        }),
      ],
    );
  });

  test("emits every combined stdout and stderr occurrence", async () => {
    const { service } = outputService([
      {
        attempt: 1,
        sequence: 0,
        stream: "STDOUT",
        bytes: Buffer.from("ready "),
      },
      {
        attempt: 1,
        sequence: 1,
        stream: "STDERR",
        bytes: Buffer.from("12\nready "),
      },
      {
        attempt: 1,
        sequence: 2,
        stream: "STDOUT",
        bytes: Buffer.from("34"),
      },
      {
        attempt: 1,
        sequence: 3,
        stream: "SYSTEM",
        bytes: Buffer.from("ready 99"),
      },
    ]);
    const internals = matcherInternals(service);
    const persist = vi.fn().mockResolvedValue(true);
    internals.persistCommandMatches = persist;

    await internals.processCommandMatchWait(matcherWait("ready ([0-9]+)"));

    const matches = persist.mock.calls[0]?.[2];
    expect(matches).toEqual([
      expect.objectContaining({ text: "ready 12", captures: ["12"] }),
      expect.objectContaining({ text: "ready 34", captures: ["34"] }),
    ]);
  });

  test("never carries an unfinished match into a restarted process", async () => {
    const { service } = outputService([
      {
        attempt: 1,
        sequence: 0,
        stream: "STDOUT",
        bytes: Buffer.from("foo"),
      },
      {
        attempt: 2,
        sequence: 0,
        stream: "STDOUT",
        bytes: Buffer.from("bar"),
      },
    ]);
    const internals = matcherInternals(service);
    const persist = vi.fn().mockResolvedValue(true);
    internals.persistCommandMatches = persist;

    await internals.processCommandMatchWait(matcherWait("foobar"));

    expect(persist.mock.calls[0]?.[2]).toEqual([]);
    expect(persist.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ scanAttempt: 2, scanCharacterOffset: 0 }),
    );
  });

  test("fails clearly after 16 MiB of unmatched output", async () => {
    const { service } = outputService([
      {
        attempt: 1,
        sequence: 0,
        stream: "STDOUT",
        bytes: Buffer.alloc(16 * 1024 * 1024 + 1, 97),
      },
    ]);
    const internals = matcherInternals(service);
    const fail = vi.fn().mockResolvedValue(undefined);
    internals.failCommandMatchWait = fail;

    await internals.processCommandMatchWait(matcherWait("never-matches"));

    expect(fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: expect.stringContaining("16 MiB") }),
    );
  });

  test("atomically appends session matches and creates isolated branch attempts", async () => {
    const { service } = outputService([]);
    const internals = matcherInternals(service);
    internals.progressRun = vi.fn().mockResolvedValue(undefined);
    internals.dispatchReadyAttempts = vi.fn().mockResolvedValue(undefined);
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-run-1",
      status: "WAITING",
      exclusiveWorktree: false,
      worktreeId: null,
      sessionDataJson: JSON.stringify({
        steps: {
          command: {
            commandRunId: "command-run-1",
            matches: [],
            latestMatch: null,
          },
        },
      }),
    });
    const first = {
      ordinal: 1,
      text: "ready 12",
      captures: ["12"],
      namedCaptures: {},
      commandRunId: "command-run-1",
      commandAttempt: 1,
      start: { sequence: 0, offset: 0 },
      end: { sequence: 0, offset: 8 },
    };
    const second = { ...first, ordinal: 2, text: "ready 34" };
    const wait = matcherWait("ready ([0-9]+)");
    const cursor = JSON.parse(wait.predicateJson).outputMatch;
    cursor.matchCount = 2;

    await internals.persistCommandMatches(wait, cursor, [first, second]);

    const created = prisma.workflowStepAttempt.createMany.mock.calls[0]?.[0]
      .data as Array<Record<string, unknown>>;
    expect(created).toHaveLength(4);
    expect(
      created.filter(({ phase }) => phase === "MATCH_EMITTED"),
    ).toHaveLength(2);
    expect(
      created.filter(({ phase }) => phase === "MATCH_PENDING"),
    ).toHaveLength(2);
    expect(
      JSON.parse(
        String(
          created.find(({ phase }) => phase === "MATCH_EMITTED")?.outputJson,
        ),
      ).selectedHandles,
    ).toEqual(["match"]);
    const session = JSON.parse(
      prisma.workflowRun.update.mock.calls[0]?.[0].data.sessionDataJson,
    );
    expect(session.steps.command.matches).toEqual([first, second]);
    expect(session.steps.command.latestMatch).toEqual(second);
  });

  test("does not duplicate a match when another reconciler advanced the cursor", async () => {
    const { service } = outputService([]);
    const internals = matcherInternals(service);
    prisma.workflowWait.updateMany.mockResolvedValueOnce({ count: 0 });
    const wait = matcherWait("ready");
    const match = {
      ordinal: 1,
      text: "ready",
      captures: [],
      namedCaptures: {},
      commandRunId: "command-run-1",
      commandAttempt: 1,
      start: { sequence: 0, offset: 0 },
      end: { sequence: 0, offset: 5 },
    };

    const persisted = await internals.persistCommandMatches(
      wait,
      JSON.parse(wait.predicateJson).outputMatch,
      [match],
    );

    expect(persisted).toBe(false);
    expect(prisma.workflowStepAttempt.createMany).not.toHaveBeenCalled();
    expect(prisma.workflowRun.update).not.toHaveBeenCalled();
  });

  test("preserves match data and final command data on failure", async () => {
    const { service } = outputService([]);
    const internals = matcherInternals(service);
    const definition = commandDefinition();
    const node = definition.nodes[0]!;
    const existingMatch = { ordinal: 1, text: "ready" };
    prisma.workflowRun.findUnique.mockResolvedValue({
      id: "workflow-run-1",
      status: "WAITING",
      exclusiveWorktree: false,
      worktreeId: null,
      sessionDataJson: JSON.stringify({
        steps: {
          command: { matches: [existingMatch], latestMatch: existingMatch },
        },
      }),
    });
    prisma.workflowStepAttempt.updateMany.mockResolvedValue({ count: 1 });
    prisma.workflowResourceLease.deleteMany.mockResolvedValue({ count: 0 });
    const attempt = {
      id: "workflow-attempt-1",
      runId: "workflow-run-1",
      nodeId: "command",
      iterationKey: "",
      attempt: 0,
    };

    await internals.failAttempt(attempt, node, new Error("exit 1"), {
      output: { status: "FAILED", exitCode: 1 },
      sessionPatch: { command: { id: "command-run-1", status: "FAILED" } },
    });

    const session = JSON.parse(
      prisma.workflowRun.update.mock.calls[0]?.[0].data.sessionDataJson,
    );
    expect(session.steps.command).toMatchObject({
      matches: [existingMatch],
      latestMatch: existingMatch,
      status: "FAILED",
      error: "exit 1",
      output: { status: "FAILED", exitCode: 1 },
    });
    expect(session.command).toEqual({
      id: "command-run-1",
      status: "FAILED",
    });
  });
});

describe("workflow attempt dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workflowStepAttempt.count.mockResolvedValue(0);
    prisma.workflowStepAttempt.findMany.mockResolvedValue([
      {
        id: "ready-sibling",
        startedAt: null,
      },
    ]);
    prisma.workflowStepAttempt.updateMany.mockResolvedValue({ count: 1 });
  });

  test("dispatches a ready sibling while another step has the run waiting", async () => {
    const executeAttempt = vi.fn().mockResolvedValue(undefined);
    const service = new WorkflowsService(
      new WorkflowEventsService(),
    ) as unknown as {
      dispatchReadyAttempts(): Promise<void>;
      executeAttempt: typeof executeAttempt;
    };
    service.executeAttempt = executeAttempt;

    await service.dispatchReadyAttempts();

    const schedulingStatuses = { in: ["RUNNING", "WAITING"] };
    expect(prisma.workflowStepAttempt.findMany).toHaveBeenCalledWith({
      where: {
        status: "READY",
        run: { status: schedulingStatuses },
      },
      orderBy: { createdAt: "asc" },
      take: 8,
    });
    expect(prisma.workflowStepAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "ready-sibling",
          status: "READY",
          run: { status: schedulingStatuses },
        },
      }),
    );
    expect(executeAttempt).toHaveBeenCalledWith(
      "ready-sibling",
      expect.any(AbortSignal),
    );
  });
});

describe("workflow overlap settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workflow.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    prisma.workflow.findUnique.mockResolvedValue({ id: "workflow-1" });
  });

  test("counts overlap per worktree unless a workflow asks for global", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());

    await service.create({ name: "Commit" });
    await service.create({ name: "Deploy", overlapScope: "global" });

    expect(prisma.workflow.create.mock.calls[0]?.[0].data).toMatchObject({
      overlapScope: "WORKTREE",
    });
    expect(prisma.workflow.create.mock.calls[1]?.[0].data).toMatchObject({
      overlapScope: "GLOBAL",
    });
    await expect(
      service.create({ name: "Broken", overlapScope: "REPOSITORY" }),
    ).rejects.toThrow(/overlap scope is not supported/);
  });

  test("normalizes worktree concurrency and forces Git blocking for exclusive workflows", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());

    await service.create({ name: "Shared" });
    await service.create({
      name: "Ignored by admission",
      worktreeConcurrency: "excluded",
      blocksGitOperations: true,
    });
    await service.create({
      name: "Exclusive",
      worktreeConcurrency: "exclusive",
      blocksGitOperations: false,
    });

    expect(prisma.workflow.create.mock.calls[0]?.[0].data).toMatchObject({
      worktreeConcurrency: "NON_EXCLUSIVE",
      exclusiveWorktree: false,
      blocksGitOperations: false,
    });
    expect(prisma.workflow.create.mock.calls[1]?.[0].data).toMatchObject({
      worktreeConcurrency: "EXCLUDED",
      exclusiveWorktree: false,
      blocksGitOperations: true,
    });
    expect(prisma.workflow.create.mock.calls[2]?.[0].data).toMatchObject({
      worktreeConcurrency: "EXCLUSIVE",
      exclusiveWorktree: true,
      blocksGitOperations: true,
    });
  });

  test("reads the scope of an export written before the setting existed", async () => {
    const service = new WorkflowsService(new WorkflowEventsService());
    const exported = (exclusiveWorktree: boolean) => ({
      format: "aide.workflow.export",
      schemaVersion: 1,
      workflow: {
        name: "Commit",
        overlapPolicy: "QUEUE",
        exclusiveWorktree,
        definition: emptyWorkflowDefinition("Commit"),
      },
    });

    await service.import({ payload: exported(true) });
    await service.import({ payload: exported(false) });

    expect(prisma.workflow.create.mock.calls[0]?.[0].data).toMatchObject({
      overlapScope: "WORKTREE",
      exclusiveWorktree: true,
      worktreeConcurrency: "EXCLUSIVE",
      blocksGitOperations: true,
    });
    expect(prisma.workflow.create.mock.calls[1]?.[0].data).toMatchObject({
      overlapScope: "GLOBAL",
      exclusiveWorktree: false,
      worktreeConcurrency: "NON_EXCLUSIVE",
      blocksGitOperations: false,
    });
  });
});

describe("workflow queue admission", () => {
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
    prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    prisma.workflowStepAttempt.count.mockResolvedValue(0);
    prisma.worktreeAdmissionLane.upsert.mockResolvedValue({});
    prisma.worktreeWorkflowLease.deleteMany.mockResolvedValue({ count: 0 });
    prisma.worktreeWorkflowLease.findUnique.mockResolvedValue(null);
    prisma.worktreeWorkflowLease.create.mockResolvedValue({});
    prisma.worktreeRunLease.deleteMany.mockResolvedValue({ count: 0 });
    prisma.worktreeRunLease.count.mockResolvedValue(0);
    prisma.workflowRun.findFirst.mockResolvedValue(null);
    prisma.agentRun.findFirst.mockResolvedValue(null);
  });

  function internals(service: WorkflowsService) {
    return service as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
  }

  function queuedRun(overrides: Record<string, unknown>) {
    return {
      id: "run-2",
      workflowId: "workflow-1",
      worktreeId: "worktree-2",
      worktreeLeaseOwnerRunId: "run-2",
      exclusiveWorktree: true,
      worktreeConcurrency: "EXCLUSIVE",
      blocksGitOperations: true,
      parentRunId: null,
      generation: 0,
      startedAt: null,
      queuedAt: new Date("2026-08-03T12:00:00.000Z"),
      sessionDataJson: "{}",
      workflow: {
        overlapPolicy: "QUEUE",
        overlapScope: "WORKTREE",
        maxConcurrentRuns: 1,
      },
      version: {
        definitionJson: JSON.stringify(emptyWorkflowDefinition("Commit")),
      },
      ...overrides,
    };
  }

  test("starts a worktree-scoped run while the workflow runs on another worktree", async () => {
    prisma.workflowRun.findMany.mockResolvedValue([queuedRun({})]);
    // One run of this workflow is already going on worktree-1.
    prisma.workflowRun.count.mockImplementation(
      async ({ where }: { where: { worktreeId?: string } }) =>
        where.worktreeId === "worktree-2" ? 0 : 1,
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).startQueuedRuns();

    expect(prisma.workflowRun.count.mock.calls[0]?.[0].where).toMatchObject({
      workflowId: "workflow-1",
      worktreeId: "worktree-2",
    });
    expect(prisma.worktreeWorkflowLease.create).toHaveBeenCalledWith({
      data: { worktreeId: "worktree-2", workflowRunId: "run-2" },
    });
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { id: "run-2", status: "QUEUED" },
      data: expect.objectContaining({ status: "RUNNING" }),
    });
  });

  test("starts an excluded run without entering the worktree admission lane", async () => {
    prisma.workflowRun.findMany.mockResolvedValue([
      queuedRun({
        worktreeLeaseOwnerRunId: null,
        exclusiveWorktree: false,
        worktreeConcurrency: "EXCLUDED",
        blocksGitOperations: false,
      }),
    ]);
    prisma.workflowRun.count.mockResolvedValue(0);
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).startQueuedRuns();

    expect(prisma.worktreeAdmissionLane.upsert).not.toHaveBeenCalled();
    expect(prisma.worktreeWorkflowLease.findUnique).not.toHaveBeenCalled();
    expect(prisma.worktreeWorkflowLease.create).not.toHaveBeenCalled();
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { id: "run-2", status: "QUEUED" },
      data: expect.objectContaining({ status: "RUNNING" }),
    });
  });

  test("holds a second worktree-scoped run queued on the worktree it shares", async () => {
    prisma.workflowRun.findMany.mockResolvedValue([queuedRun({})]);
    prisma.workflowRun.count.mockResolvedValue(1);
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).startQueuedRuns();

    expect(prisma.worktreeWorkflowLease.create).not.toHaveBeenCalled();
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  test("counts a worktree-scoped run with no worktree against the runs that have none", async () => {
    prisma.workflowRun.findMany.mockResolvedValue([
      queuedRun({ worktreeId: null, worktreeLeaseOwnerRunId: null }),
    ]);
    prisma.workflowRun.count.mockResolvedValue(0);
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).startQueuedRuns();

    expect(prisma.workflowRun.count.mock.calls[0]?.[0].where).toMatchObject({
      worktreeId: null,
    });
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledWith({
      where: { id: "run-2", status: "QUEUED" },
      data: expect.objectContaining({ status: "RUNNING" }),
    });
  });

  test("keeps a globally scoped workflow serialized across worktrees", async () => {
    prisma.workflowRun.findMany.mockResolvedValue([
      queuedRun({
        exclusiveWorktree: false,
        worktreeLeaseOwnerRunId: null,
        workflow: {
          overlapPolicy: "QUEUE",
          overlapScope: "GLOBAL",
          maxConcurrentRuns: 1,
        },
      }),
    ]);
    prisma.workflowRun.count.mockResolvedValue(1);
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).startQueuedRuns();

    expect(
      prisma.workflowRun.count.mock.calls[0]?.[0].where,
    ).not.toHaveProperty("worktreeId");
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  test("coalesces the latest trigger only within the run's own worktree", async () => {
    const version = { id: "version-1", name: "Coalescing workflow" };
    prisma.workflowRun.findUnique.mockResolvedValue(null);
    prisma.workflowRun.findFirst.mockResolvedValue(null);
    prisma.worktree.findUnique.mockResolvedValue({ id: "worktree-2" });
    prisma.workflowRunNumberSequence.upsert.mockResolvedValue({ nextValue: 4 });
    prisma.workflowRun.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );
    const service = new WorkflowsService(new WorkflowEventsService());

    await internals(service).createRunForTrigger(
      {
        id: "workflow-1",
        overlapPolicy: "COALESCE_LATEST",
        overlapScope: "WORKTREE",
        activeVersion: version,
      },
      version,
      null,
      null,
      "RESOURCE_MANUAL",
      "WORKTREE:worktree-2",
      { sessionData: { worktree: { id: "worktree-2" } } },
      "idempotency-3",
    );

    expect(prisma.workflowRun.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workflowId: "workflow-1",
          status: "QUEUED",
          worktreeId: "worktree-2",
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

  test("fires worktree clean only on a dirty-to-clean transition", async () => {
    prisma.workflowTriggerState.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cursorJson: JSON.stringify({ value: false }) })
      .mockResolvedValueOnce({ cursorJson: JSON.stringify({ value: true }) })
      .mockResolvedValueOnce({ cursorJson: JSON.stringify({ value: false }) });

    await expect(
      matches("WORKTREE_CLEAN", {}, { cursorValue: false }),
    ).resolves.toBe(false);
    await expect(
      matches("WORKTREE_CLEAN", {}, { cursorValue: true }),
    ).resolves.toBe(false);
    await expect(
      matches("WORKTREE_CLEAN", {}, { cursorValue: false }),
    ).resolves.toBe(true);
    await expect(
      matches("WORKTREE_CLEAN", {}, { cursorValue: false }),
    ).resolves.toBe(false);
  });

  test("fires Jira sprint triggers only when the matching sprint set grows", async () => {
    prisma.workflowTriggerState.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ cursorJson: JSON.stringify({ value: [] }) })
      .mockResolvedValueOnce({
        cursorJson: JSON.stringify({ value: ["Sprint 1"] }),
      })
      .mockResolvedValueOnce({ cursorJson: JSON.stringify({ value: [] }) });

    await expect(
      matches("JIRA_SPRINT_ENDED", {}, { cursorValue: [] }),
    ).resolves.toBe(false);
    await expect(
      matches("JIRA_SPRINT_ENDED", {}, { cursorValue: ["Sprint 1"] }),
    ).resolves.toBe(true);
    await expect(
      matches("JIRA_SPRINT_STARTED", {}, { cursorValue: [] }),
    ).resolves.toBe(false);
    await expect(
      matches("JIRA_SPRINT_STARTED", {}, { cursorValue: ["Sprint 2"] }),
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
    worktreeConcurrency: "EXCLUDED",
    blocksGitOperations: true,
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
    expect(data.worktreeConcurrency).toBe("EXCLUDED");
    expect(data.blocksGitOperations).toBe(true);
    expect(data.exclusiveWorktree).toBe(false);
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

describe("workflow run agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolves the snapshotted agent from session data", async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: "agent-1",
      name: "Studio Mac",
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    const agent = await service.runAgent(
      JSON.stringify({ agent: { id: "agent-1" } }),
    );

    expect(prisma.agent.findUnique).toHaveBeenCalledWith({
      where: { id: "agent-1" },
    });
    expect(agent).toMatchObject({ id: "agent-1", name: "Studio Mac" });
    expect(prisma.worktree.findUnique).not.toHaveBeenCalled();
  });

  test("falls back to the worktree owner for older session data", async () => {
    prisma.worktree.findUnique.mockResolvedValue({
      codebase: { agent: { id: "agent-2", name: "Build Mac" } },
    });
    const service = new WorkflowsService(new WorkflowEventsService());

    await expect(
      service.runAgent(JSON.stringify({ worktree: { id: "worktree-1" } })),
    ).resolves.toMatchObject({ id: "agent-2", name: "Build Mac" });
    expect(prisma.worktree.findUnique).toHaveBeenCalledWith({
      where: { id: "worktree-1" },
      select: { codebase: { select: { agent: true } } },
    });
  });
});
