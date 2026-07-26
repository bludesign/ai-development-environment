import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { agentEventBus } from "@/services/agent-control";

import { ActionCenterService } from "./action-center.service";

const at = (hour: number) =>
  new Date(`2026-07-26T${String(hour).padStart(2, "0")}:00:00.000Z`);
const worktree = {
  id: "worktree-1",
  folder: "feature-aide",
  branch: "feature/AIDE-101-action-center",
  highlightColor: "blue",
};
const questionBatch = {
  id: "batch-1",
  createdAt: at(9),
  questions: [
    {
      id: "question-1",
      position: 0,
      header: "Approach",
      prompt: "Which approach should be used?",
      multiSelect: false,
      allowCustom: true,
      options: [
        {
          id: "option-1",
          position: 0,
          label: "Recommended",
          description: "Use the recommended approach.",
        },
      ],
    },
  ],
};

function build(overrides: Record<string, unknown>) {
  return {
    id: "build-active",
    worktreeId: "worktree-1",
    codebaseId: "codebase-1",
    configurationId: "configuration-1",
    status: "RUNNING",
    destinationType: "SIMULATOR",
    destinationJson: JSON.stringify({
      type: "SIMULATOR",
      id: "sim-1",
      name: "iPhone 17 Pro",
      platform: "iOS Simulator",
      osVersion: "26.0",
      state: "Booted",
    }),
    error: null,
    createdAt: at(8),
    startedAt: at(8),
    finishedAt: null,
    updatedAt: at(8),
    worktree,
    codebase: { repository: { name: "aide" } },
    configuration: { name: "Debug" },
    artifacts: [],
    deployments: [],
    ...overrides,
  };
}

const reasonPriority = {
  QUESTION: 0,
  BLOCKED: 1,
  FAILED: 2,
  UNRUN_BUILD: 3,
  ACTIVE: 4,
} as const;

function actionCenterIndex(acknowledgedResourceIds: string[] = []) {
  const acknowledged = new Set(acknowledgedResourceIds);
  const rows = [
    {
      resourceKind: "PLAN",
      resourceId: "plan-question",
      reason: "QUESTION",
      key: "PLAN:plan-question",
      updatedAt: at(12).toISOString(),
    },
    {
      resourceKind: "WORKFLOW",
      resourceId: "workflow-blocked",
      reason: "BLOCKED",
      key: "WORKFLOW:workflow-blocked",
      updatedAt: at(10).toISOString(),
    },
    {
      resourceKind: "SESSION",
      resourceId: "session-failed",
      reason: "FAILED",
      key: "SESSION:session-failed",
      updatedAt: at(11).toISOString(),
    },
    {
      resourceKind: "BUILD",
      resourceId: "build-failed",
      reason: "FAILED",
      key: "BUILD:build-failed",
      updatedAt: at(9).toISOString(),
    },
    {
      resourceKind: "BUILD",
      resourceId: "build-unrun-new",
      reason: "UNRUN_BUILD",
      key: "BUILD:build-unrun-new",
      updatedAt: at(7).toISOString(),
    },
    {
      resourceKind: "BUILD",
      resourceId: "build-active",
      reason: "ACTIVE",
      key: "BUILD:build-active",
      updatedAt: at(8).toISOString(),
    },
  ].filter(({ resourceId }) => !acknowledged.has(resourceId));

  return vi.fn().mockImplementation((query: string, ...values: unknown[]) => {
    if (query.includes("COUNT(*)")) {
      return Promise.resolve([
        {
          totalCount: rows.length,
          needsAttentionCount: rows.filter(({ reason }) => reason !== "ACTIVE")
            .length,
        },
      ]);
    }
    const hasCursor = values[0] === 1;
    const cursorPriority = Number(values[1]);
    const cursorUpdatedAt = String(values[3]);
    const cursorKey = String(values[5]);
    const limit = Number(values[6]);
    const remaining = hasCursor
      ? rows.filter((row) => {
          const priority =
            reasonPriority[row.reason as keyof typeof reasonPriority];
          return (
            priority > cursorPriority ||
            (priority === cursorPriority &&
              (row.updatedAt < cursorUpdatedAt ||
                (row.updatedAt === cursorUpdatedAt && row.key > cursorKey)))
          );
        })
      : rows;
    return Promise.resolve(remaining.slice(0, limit));
  });
}

function prisma(
  overrides: Record<string, unknown> = {},
  acknowledgedResourceIds: string[] = [],
) {
  const plan = {
    id: "plan-question",
    kind: "PLAN",
    displayNumber: 4,
    status: "IN_PROGRESS",
    phase: "WAITING_FOR_ANSWER",
    initialPrompt: "Choose how the Action Center should be organized.",
    repositoryName: "aide",
    branch: worktree.branch,
    error: null,
    createdAt: at(7),
    finishedAt: null,
    updatedAt: at(12),
    worktree,
    questionBatches: [questionBatch],
  };
  const sessionFailure = {
    ...plan,
    id: "session-failed",
    kind: "SESSION",
    displayNumber: 7,
    status: "FAILED",
    phase: "FAILED",
    initialPrompt: "Implement the Action Center.",
    error: "Provider stopped unexpectedly",
    finishedAt: at(11),
    updatedAt: at(11),
    questionBatches: [],
  };
  const blockedWorkflow = {
    id: "workflow-blocked",
    displayNumber: 2,
    status: "BLOCKED",
    phase: "SESSION_DATA_INVALID",
    generation: 0,
    triggerSubjectKey: "AIDE-101",
    blockedReason: "Required worktree data is missing",
    error: null,
    queuedAt: at(6),
    finishedAt: null,
    createdAt: at(6),
    updatedAt: at(10),
    sessionDataJson: JSON.stringify({ worktree: { id: worktree.id } }),
    workflow: { name: "Implement ticket" },
    attempts: [],
  };
  const activeBuild = build({});
  const failedBuild = build({
    id: "build-failed",
    status: "FAILED",
    error: "xcodebuild failed",
    finishedAt: at(9),
    updatedAt: at(9),
  });
  const newestUnrun = build({
    id: "build-unrun-new",
    status: "SUCCEEDED",
    createdAt: at(7),
    finishedAt: at(7),
    updatedAt: at(7),
    artifacts: [{ kind: "RUNNABLE_APP" }],
  });
  const olderUnrun = build({
    id: "build-unrun-old",
    status: "SUCCEEDED",
    createdAt: at(5),
    finishedAt: at(5),
    updatedAt: at(5),
    artifacts: [{ kind: "RUNNABLE_APP" }],
  });
  const allBuilds = [activeBuild, failedBuild, newestUnrun, olderUnrun];
  return {
    $queryRawUnsafe: actionCenterIndex(acknowledgedResourceIds),
    agentRun: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            [plan, sessionFailure].filter((run) =>
              where.id.in.includes(run.id),
            ),
          ),
        ),
    },
    workflowRun: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            [blockedWorkflow].filter((run) => where.id.in.includes(run.id)),
          ),
        ),
    },
    build: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(
            allBuilds.filter((candidate) => where.id.in.includes(candidate.id)),
          ),
        ),
    },
    worktree: { findMany: vi.fn().mockResolvedValue([worktree]) },
    ...overrides,
  };
}

describe("ActionCenterService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("prioritizes questions, blockers, failures, unrun builds, and active work", async () => {
    getPrismaClient.mockResolvedValue(prisma());

    const result = await new ActionCenterService().list({ first: 50 });

    expect(result.items.map(({ key, reason }) => [key, reason])).toEqual([
      ["PLAN:plan-question", "QUESTION"],
      ["WORKFLOW:workflow-blocked", "BLOCKED"],
      ["SESSION:session-failed", "FAILED"],
      ["BUILD:build-failed", "FAILED"],
      ["BUILD:build-unrun-new", "UNRUN_BUILD"],
      ["BUILD:build-active", "ACTIVE"],
    ]);
    expect(result.items.map(({ key }) => key)).not.toContain(
      "BUILD:build-unrun-old",
    );
    expect(result.items[0]?.questionBatches[0]?.questions[0]?.prompt).toBe(
      "Which approach should be used?",
    );
    expect(result.items[1]?.worktree).toEqual(worktree);
    expect(result).toMatchObject({
      totalCount: 6,
      needsAttentionCount: 5,
      activeCount: 1,
      nextCursor: null,
    });
  });

  test("hydrates only resources on the requested page", async () => {
    const database = prisma();
    getPrismaClient.mockResolvedValue(database);

    const result = await new ActionCenterService().list({ first: 1 });

    expect(result.items.map(({ key }) => key)).toEqual(["PLAN:plan-question"]);
    expect(result.nextCursor).not.toBeNull();
    expect(database.agentRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["plan-question"] } },
        take: 1,
      }),
    );
    expect(database.workflowRun.findMany).not.toHaveBeenCalled();
    expect(database.build.findMany).not.toHaveBeenCalled();
  });

  test("hides an acknowledged failure and paginates the mixed feed", async () => {
    const database = prisma({}, ["session-failed"]);
    getPrismaClient.mockResolvedValue(database);
    const service = new ActionCenterService();

    const first = await service.list({ first: 2 });
    const second = await service.list({ first: 20, after: first.nextCursor });

    expect(first.items.map(({ key }) => key)).toEqual([
      "PLAN:plan-question",
      "WORKFLOW:workflow-blocked",
    ]);
    expect(second.items.map(({ key }) => key)).toEqual([
      "BUILD:build-failed",
      "BUILD:build-unrun-new",
      "BUILD:build-active",
    ]);
    expect(first.totalCount).toBe(5);
  });

  test("acknowledges only the current failure fingerprint and publishes a refresh", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({
      agentRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: "session-failed",
          kind: "SESSION",
          status: "FAILED",
          finishedAt: at(11),
          updatedAt: at(11),
        }),
      },
      actionCenterAcknowledgement: { upsert },
    });
    const publish = vi.spyOn(agentEventBus, "publish");
    const service = new ActionCenterService();
    const fingerprint = "SESSION:session-failed:0:2026-07-26T11:00:00.000Z";

    await expect(
      service.acknowledge({
        resourceKind: "SESSION",
        resourceId: "session-failed",
        failureFingerprint: fingerprint,
      }),
    ).resolves.toBe(true);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          resourceKind_resourceId_failureFingerprint: {
            resourceKind: "SESSION",
            resourceId: "session-failed",
            failureFingerprint: fingerprint,
          },
        },
      }),
    );
    expect(publish).toHaveBeenCalledWith("sidebar-status.changed", {
      sidebarStatusChanged: true,
    });
    await expect(
      service.acknowledge({
        resourceKind: "SESSION",
        resourceId: "session-failed",
        failureFingerprint: `${fingerprint}:stale`,
      }),
    ).rejects.toThrow("no longer current");
  });
});
