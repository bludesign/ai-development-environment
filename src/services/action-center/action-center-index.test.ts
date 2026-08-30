// @vitest-environment node
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import { queryActionCenterIndex } from "./action-center-index";

const TABLES = [
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
