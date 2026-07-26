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

function prisma(overrides: Record<string, unknown> = {}) {
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
  return {
    agentRun: { findMany: vi.fn().mockResolvedValue([plan, sessionFailure]) },
    workflowRun: { findMany: vi.fn().mockResolvedValue([blockedWorkflow]) },
    build: {
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          where.status === "SUCCEEDED"
            ? Promise.resolve([newestUnrun, olderUnrun])
            : Promise.resolve([activeBuild, failedBuild]),
        ),
    },
    worktree: { findMany: vi.fn().mockResolvedValue([worktree]) },
    actionCenterAcknowledgement: {
      findMany: vi.fn().mockResolvedValue([]),
    },
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

  test("hides an acknowledged failure and paginates the mixed feed", async () => {
    const database = prisma();
    database.actionCenterAcknowledgement.findMany.mockImplementation(
      ({ where }) => {
        const failure = where.OR.find(
          (entry: { resourceId: string }) =>
            entry.resourceId === "session-failed",
        );
        return Promise.resolve(failure ? [failure] : []);
      },
    );
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
