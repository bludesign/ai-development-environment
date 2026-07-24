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
});
