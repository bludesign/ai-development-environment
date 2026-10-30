// @vitest-environment node
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import { queryActionCenterIndex } from "./action-center-index";

const TABLES = [
  `CREATE TABLE ActionCenterSettings (id TEXT PRIMARY KEY, maximumRequestAgeDays INTEGER, showMyRequestsInSidebar BOOLEAN, showReviewRequestsInSidebar BOOLEAN, hideUnapprovedRequestsInSidebar BOOLEAN DEFAULT 0, hideRunningPipelineRequestsInSidebar BOOLEAN DEFAULT 0)`,
  `CREATE TABLE ActionCenterRequest (id TEXT PRIMARY KEY, resourceKind TEXT, reason TEXT, isMine BOOLEAN, requiresMyApproval BOOLEAN, createdAt DATETIME, updatedAt DATETIME, payloadJson TEXT DEFAULT '{"request":{"pipelineStatus":"SUCCESS","approvalStatus":"APPROVED"}}')`,
  `CREATE TABLE AgentRun (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    updatedAt DATETIME NOT NULL,
    finishedAt DATETIME,
    archivedAt DATETIME
  )`,
  `CREATE TABLE RunQuestionBatch (
    id TEXT PRIMARY KEY,
    runId TEXT,
    workflowStepAttemptId TEXT,
    status TEXT NOT NULL
  )`,
  `CREATE TABLE WorkflowRun (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    generation INTEGER NOT NULL,
    updatedAt DATETIME NOT NULL,
    finishedAt DATETIME,
    archivedAt DATETIME
  )`,
  `CREATE TABLE WorkflowStepAttempt (
    id TEXT PRIMARY KEY,
    runId TEXT NOT NULL,
    supersededAt DATETIME
  )`,
  `CREATE TABLE Build (
    id TEXT PRIMARY KEY,
    worktreeId TEXT,
    configurationId TEXT,
    destinationType TEXT NOT NULL,
    status TEXT NOT NULL,
    createdAt DATETIME NOT NULL,
    updatedAt DATETIME NOT NULL,
    finishedAt DATETIME
  )`,
  `CREATE TABLE Worktree (
    id TEXT PRIMARY KEY,
    missingAt DATETIME,
    availability TEXT NOT NULL
  )`,
  `CREATE TABLE BuildArtifact (
    id TEXT PRIMARY KEY,
    buildId TEXT NOT NULL,
    kind TEXT NOT NULL
  )`,
  `CREATE TABLE BuildDeployment (
    id TEXT PRIMARY KEY,
    buildId TEXT NOT NULL
  )`,
  `CREATE TABLE ActionCenterAcknowledgement (
    id TEXT PRIMARY KEY,
    resourceKind TEXT NOT NULL,
    resourceId TEXT NOT NULL,
    failureFingerprint TEXT NOT NULL
  )`,
];

const timestamp = (hour: number) =>
  `2026-07-26T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("Action Center index", () => {
  let prisma: InstanceType<typeof PrismaClient>;

  beforeEach(async () => {
    // In-memory: the assertions only read rows back through Prisma, and a temp
    // directory plus an on-disk database made this suite the first casualty
    // whenever a loaded CI runner stalled on filesystem I/O.
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
    });
    for (const table of TABLES) await prisma.$executeRawUnsafe(table);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function addBuild(input: {
    id: string;
    hour: number;
    worktreeId?: string | null;
    status?: string;
    runnable?: boolean;
    deployed?: boolean;
  }) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO Build (
        id, worktreeId, configurationId, destinationType, status,
        createdAt, updatedAt, finishedAt
      ) VALUES (?, ?, 'debug', 'SIMULATOR', ?, ?, ?, ?)`,
      input.id,
      input.worktreeId === undefined ? "worktree-1" : input.worktreeId,
      input.status ?? "SUCCEEDED",
      timestamp(input.hour),
      timestamp(input.hour),
      timestamp(input.hour),
    );
    if (input.runnable ?? true) {
      await prisma.$executeRawUnsafe(
        "INSERT INTO BuildArtifact (id, buildId, kind) VALUES (?, ?, 'RUNNABLE_APP')",
        `artifact-${input.id}`,
        input.id,
      );
    }
    if (input.deployed) {
      await prisma.$executeRawUnsafe(
        "INSERT INTO BuildDeployment (id, buildId) VALUES (?, ?)",
        `deployment-${input.id}`,
        input.id,
      );
    }
  }

  test("selects the latest build before checking deployments", async () => {
    await prisma.$executeRawUnsafe(
      "INSERT INTO Worktree (id, missingAt, availability) VALUES ('worktree-1', NULL, 'AVAILABLE')",
    );
    await addBuild({ id: "older-unrun", hour: 8 });
    await addBuild({ id: "newer-run", hour: 9, deployed: true });

    await expect(
      queryActionCenterIndex(prisma, { first: 10, cursor: null }),
    ).resolves.toMatchObject({ rows: [], totalCount: 0 });

    await addBuild({ id: "newest-unrun", hour: 10 });
    const result = await queryActionCenterIndex(prisma, {
      first: 10,
      cursor: null,
    });
    expect(result.rows.map(({ resourceId }) => resourceId)).toEqual([
      "newest-unrun",
    ]);

    await prisma.$executeRawUnsafe(
      `INSERT INTO ActionCenterAcknowledgement (
        id, resourceKind, resourceId, failureFingerprint
      ) VALUES ('dismiss-newest', 'BUILD', 'newest-unrun', 'BUILD:newest-unrun:UNRUN_BUILD')`,
    );
    await expect(
      queryActionCenterIndex(prisma, { first: 10, cursor: null }),
    ).resolves.toMatchObject({ rows: [], totalCount: 0 });
  });

  test("excludes builds whose worktree cannot run them", async () => {
    await prisma.$executeRawUnsafe(
      "INSERT INTO Worktree (id, missingAt, availability) VALUES ('missing-worktree', ?, 'AVAILABLE')",
      timestamp(8),
    );
    await prisma.$executeRawUnsafe(
      "INSERT INTO Worktree (id, missingAt, availability) VALUES ('unavailable-worktree', NULL, 'MISSING')",
    );
    await addBuild({ id: "orphan", hour: 8, worktreeId: null });
    await addBuild({
      id: "missing",
      hour: 9,
      worktreeId: "missing-worktree",
    });
    await addBuild({
      id: "unavailable",
      hour: 10,
      worktreeId: "unavailable-worktree",
    });

    await expect(
      queryActionCenterIndex(prisma, { first: 10, cursor: null }),
    ).resolves.toMatchObject({ rows: [], totalCount: 0 });
  });

  test("shows worktree-queued agent runs as active", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO AgentRun (
        id, kind, status, phase, updatedAt, finishedAt, archivedAt
      ) VALUES ('session-queued', 'SESSION', 'QUEUED', 'WAITING_FOR_WORKTREE', ?, NULL, NULL)`,
      timestamp(12),
    );

    await expect(
      queryActionCenterIndex(prisma, { first: 10, cursor: null }),
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          resourceId: "session-queued",
          reason: "ACTIVE",
        }),
      ],
      totalCount: 1,
      activeCount: 1,
    });
  });

  test("paginates the mixed feed and excludes current acknowledgements", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO AgentRun (
        id, kind, status, phase, updatedAt, finishedAt, archivedAt
      ) VALUES ('plan-1', 'PLAN', 'IN_PROGRESS', 'WAITING_FOR_ANSWER', ?, NULL, NULL)`,
      timestamp(12),
    );
    await prisma.$executeRawUnsafe(
      "INSERT INTO RunQuestionBatch (id, runId, workflowStepAttemptId, status) VALUES ('question-1', 'plan-1', NULL, 'PENDING')",
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO AgentRun (
        id, kind, status, phase, updatedAt, finishedAt, archivedAt
      ) VALUES ('session-1', 'SESSION', 'FAILED', 'FAILED', ?, ?, NULL)`,
      timestamp(11),
      timestamp(11),
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO ActionCenterAcknowledgement (
        id, resourceKind, resourceId, failureFingerprint
      ) VALUES (
        'ack-1', 'SESSION', 'session-1',
        'SESSION:session-1:0:2026-07-26T11:00:00.000Z'
      )`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO WorkflowRun (
        id, status, generation, updatedAt, finishedAt, archivedAt
      ) VALUES ('workflow-1', 'BLOCKED', 0, ?, NULL, NULL)`,
      timestamp(10),
    );
    await addBuild({ id: "build-active", hour: 9, status: "RUNNING" });

    const first = await queryActionCenterIndex(prisma, {
      first: 1,
      cursor: null,
    });
    expect(first.rows.map(({ resourceId }) => resourceId)).toEqual([
      "plan-1",
      "workflow-1",
    ]);
    expect(first).toMatchObject({
      totalCount: 3,
      needsAttentionCount: 2,
      activeCount: 1,
    });

    const second = await queryActionCenterIndex(prisma, {
      first: 10,
      cursor: {
        priority: 0,
        updatedAt: timestamp(12),
        key: "PLAN:plan-1",
      },
    });
    expect(second.rows.map(({ resourceId }) => resourceId)).toEqual([
      "workflow-1",
      "build-active",
    ]);
  });
});

describe("request visibility in the mixed index", () => {
  let prisma: InstanceType<typeof PrismaClient>;
  beforeEach(async () => {
    prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
    });
    for (const table of TABLES) await prisma.$executeRawUnsafe(table);
    for (const [id, mine, review, age] of [
      ["mine", 1, 0, 1],
      ["review", 0, 1, 1],
      ["both", 1, 1, 1],
      ["approved", 0, 0, 1],
      ["old", 1, 0, 31],
    ] as const) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ActionCenterRequest (id, resourceKind, reason, isMine, requiresMyApproval, createdAt, updatedAt) VALUES (?, 'PULL_REQUEST', 'ACTIVE', ?, ?, ?, ?)`,
        id,
        mine,
        review,
        new Date(Date.now() - age * 86_400_000).toISOString(),
        new Date().toISOString(),
      );
    }
  });
  afterEach(async () => {
    await prisma.$disconnect();
  });
  test.each([
    [true, true, 3],
    [true, false, 2],
    [false, true, 2],
    [false, false, 0],
  ])(
    "sidebar mine=%s review=%s filters before counting",
    async (mine, review, count) => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ActionCenterSettings (id, maximumRequestAgeDays, showMyRequestsInSidebar, showReviewRequestsInSidebar) VALUES ('default', 30, ?, ?)`,
        mine,
        review,
      );
      expect(
        (
          await queryActionCenterIndex(prisma, {
            first: 1,
            cursor: null,
            surface: "SIDEBAR",
          })
        ).totalCount,
      ).toBe(count);
      expect(
        (await queryActionCenterIndex(prisma, { first: 1, cursor: null }))
          .totalCount,
      ).toBe(3);
    },
  );
  test("uses the server clock and includes the exact creation-age boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-31T00:00:00.000Z"));
    try {
      for (const [id, createdAt] of [
        ["boundary", "2026-01-01T00:00:00.000Z"],
        ["too-old", "2025-12-31T23:59:59.999Z"],
      ]) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO ActionCenterRequest (id, resourceKind, reason, isMine, requiresMyApproval, createdAt, updatedAt) VALUES (?, 'MERGE_REQUEST', 'ACTIVE', 1, 0, ?, ?)`,
          id,
          createdAt,
          createdAt,
        );
      }
      const result = await queryActionCenterIndex(prisma, {
        first: 10,
        cursor: null,
        resourceKinds: ["MERGE_REQUEST"],
      });
      expect(result.rows.map((row) => row.resourceId)).toEqual(["boundary"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("zero disables age filtering and kind filters affect totals", async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ActionCenterSettings (id, maximumRequestAgeDays, showMyRequestsInSidebar, showReviewRequestsInSidebar) VALUES ('default', 0, 1, 1)`,
    );
    expect(
      (await queryActionCenterIndex(prisma, { first: 10, cursor: null }))
        .totalCount,
    ).toBe(4);
    expect(
      (
        await queryActionCenterIndex(prisma, {
          first: 10,
          cursor: null,
          resourceKinds: ["MERGE_REQUEST"],
        })
      ).totalCount,
    ).toBe(0);
  });
  test.each([
    [true, true, "REVIEW_REQUIRED", "SUCCESS", false],
    [true, false, "APPROVED", "RUNNING", true],
    [false, true, "REVIEW_REQUIRED", "SUCCESS", true],
    [true, true, "NONE", "SUCCESS", true],
    [true, true, "NOT_REQUIRED", "NONE", true],
    [true, true, "APPROVED", "QUEUED", false],
    [true, true, "APPROVED", "WAITING_FOR_RESOURCE", false],
    [true, true, "APPROVED", "WAITING_FOR_CALLBACK", false],
    [true, true, "REVIEW_REQUIRED", "FAILED", true],
    [true, true, "CHANGES_REQUESTED", "FAILURE", true],
    [true, true, "REVIEW_REQUIRED", "ERROR", true],
    [true, true, "REVIEW_REQUIRED", "TIMED_OUT", true],
  ])(
    "sidebar hide-unapproved=%s hide-running=%s approval=%s pipeline=%s visible=%s",
    async (
      hideUnapproved,
      hideRunning,
      approvalStatus,
      pipelineStatus,
      visible,
    ) => {
      await prisma.$executeRawUnsafe(
        "INSERT INTO ActionCenterSettings (id, maximumRequestAgeDays, showMyRequestsInSidebar, showReviewRequestsInSidebar, hideUnapprovedRequestsInSidebar, hideRunningPipelineRequestsInSidebar) VALUES ('default', 30, 1, 1, ?, ?)",
        hideUnapproved,
        hideRunning,
      );
      await prisma.$executeRawUnsafe(
        "UPDATE ActionCenterRequest SET payloadJson = ? WHERE id = 'mine'",
        JSON.stringify({ request: { pipelineStatus, approvalStatus } }),
      );
      const sidebar = await queryActionCenterIndex(prisma, {
        first: 1,
        cursor: null,
        surface: "SIDEBAR",
      });
      expect(sidebar.totalCount).toBe(visible ? 3 : 2);
      const full = await queryActionCenterIndex(prisma, {
        first: 50,
        cursor: null,
        surface: "FULL",
      });
      expect(full.totalCount).toBe(3);
      const all = await queryActionCenterIndex(prisma, {
        first: 50,
        cursor: null,
        surface: "SIDEBAR",
      });
      expect(all.rows.some((row) => row.resourceId === "mine")).toBe(visible);
    },
  );
});
