import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

let database: Database.Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

describe("workflow additive migration", () => {
  test("preserves existing managed-run questions and checkpoints", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "RunQuestionBatch" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "runId" TEXT NOT NULL,
        "attemptId" TEXT,
        "nativeRequestId" TEXT,
        "eventSequence" INTEGER,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "answeredAt" DATETIME,
        "supersededAt" DATETIME,
        "revisionPreparedAt" DATETIME,
        "rollbackPatch" TEXT,
        "pushedCommitWarning" TEXT
      );
      CREATE TABLE "RunCheckpoint" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "runId" TEXT NOT NULL,
        "attemptId" TEXT,
        "questionBatchId" TEXT,
        "kind" TEXT NOT NULL,
        "headSha" TEXT,
        "branch" TEXT,
        "upstreamSha" TEXT,
        "indexTree" TEXT,
        "worktreeTree" TEXT,
        "refName" TEXT,
        "manifestJson" TEXT,
        "diffSummary" TEXT,
        "diffPatch" TEXT,
        "stashRef" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO "RunQuestionBatch" ("id", "runId", "nativeRequestId", "status")
      VALUES ('question-1', 'run-1', 'native-1', 'ANSWERED');
      INSERT INTO "RunCheckpoint" ("id", "runId", "questionBatchId", "kind", "headSha")
      VALUES ('checkpoint-1', 'run-1', 'question-1', 'FINAL', 'abc123');
    `);
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260724022719_add_workflows/migration.sql",
      ),
      "utf8",
    );
    database.exec(migration);

    expect(
      database
        .prepare(
          `SELECT "runId", "workflowStepAttemptId", "status" FROM "RunQuestionBatch" WHERE "id" = ?`,
        )
        .get("question-1"),
    ).toEqual({
      runId: "run-1",
      workflowStepAttemptId: null,
      status: "ANSWERED",
    });
    expect(
      database
        .prepare(
          `SELECT "runId", "workflowStepAttemptId", "kind", "headSha" FROM "RunCheckpoint" WHERE "id" = ?`,
        )
        .get("checkpoint-1"),
    ).toEqual({
      runId: "run-1",
      workflowStepAttemptId: null,
      kind: "FINAL",
      headSha: "abc123",
    });
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('Workflow', 'WorkflowRun', 'WorkflowStepAttempt') ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "Workflow" },
      { name: "WorkflowRun" },
      { name: "WorkflowStepAttempt" },
    ]);
  });

  test("preserves legacy quick-action availability while adding rebase state", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "Workflow" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "globalQuickAction" BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE "WorkflowQuickActionRepository" (
        "workflowId" TEXT NOT NULL,
        "repositoryId" TEXT NOT NULL,
        PRIMARY KEY ("workflowId", "repositoryId")
      );
      CREATE TABLE "Worktree" (
        "id" TEXT NOT NULL PRIMARY KEY
      );
      INSERT INTO "Workflow" ("id", "globalQuickAction") VALUES
        ('global', true),
        ('scoped', false),
        ('mixed', true),
        ('disabled', false);
      INSERT INTO "WorkflowQuickActionRepository" ("workflowId", "repositoryId") VALUES
        ('scoped', 'repo-1'),
        ('mixed', 'repo-2');
      INSERT INTO "Worktree" ("id") VALUES ('worktree-1');
    `);
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260725120000_expand_workflow_quick_actions/migration.sql",
      ),
      "utf8",
    );
    database.exec(migration);

    expect(
      database
        .prepare(`SELECT "id", "quickActionKind" FROM "Workflow" ORDER BY "id"`)
        .all(),
    ).toEqual([
      { id: "disabled", quickActionKind: "NONE" },
      { id: "global", quickActionKind: "STANDARD" },
      { id: "mixed", quickActionKind: "STANDARD" },
      { id: "scoped", quickActionKind: "STANDARD" },
    ]);
    expect(
      database
        .prepare(
          `SELECT "workflowId", "repositoryId" FROM "WorkflowQuickActionRepository" ORDER BY "workflowId"`,
        )
        .all(),
    ).toEqual([{ workflowId: "scoped", repositoryId: "repo-1" }]);
    expect(
      database
        .prepare(
          `SELECT "rebaseInProgress", "hasConflicts" FROM "Worktree" WHERE "id" = 'worktree-1'`,
        )
        .get(),
    ).toEqual({ rebaseInProgress: 0, hasConflicts: 0 });
  });

  test("adds trigger delivery receipts that follow their workflow run", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE "WorkflowRun" (
        "id" TEXT NOT NULL PRIMARY KEY
      );
      INSERT INTO "WorkflowRun" ("id") VALUES ('run-1');
    `);
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260726080000_add_workflow_trigger_deliveries/migration.sql",
      ),
      "utf8",
    );
    database.exec(migration);
    database
      .prepare(
        `INSERT INTO "WorkflowTriggerDelivery" ("id", "runId") VALUES (?, ?)`,
      )
      .run("delivery-1", "run-1");

    expect(
      database
        .prepare(
          `SELECT "id", "runId" FROM "WorkflowTriggerDelivery" WHERE "id" = ?`,
        )
        .get("delivery-1"),
    ).toEqual({ id: "delivery-1", runId: "run-1" });

    database.prepare(`DELETE FROM "WorkflowRun" WHERE "id" = ?`).run("run-1");
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM "WorkflowTriggerDelivery"`)
        .get(),
    ).toEqual({ count: 0 });
  });
});
