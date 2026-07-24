import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  emptyWorkflowDefinition,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import { WorkflowEventsService } from "./workflow-events.service";
import { WorkflowsService } from "./workflows.service";

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  workflow: { findUnique: vi.fn() },
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
  workflowWait: { create: vi.fn(), findMany: vi.fn() },
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

  test("loads attempt resource links for resource-panel runs", async () => {
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
            },
          }),
        }),
      }),
    );
  });
});
