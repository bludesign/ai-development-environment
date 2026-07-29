// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";

let database: Database.Database | null = null;

afterEach(() => {
  database?.close();
  database = null;
});

describe("worktree run concurrency migration", () => {
  test("preserves leases, backfills active runs, and creates separate lanes", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "Worktree" (
        "id" TEXT NOT NULL PRIMARY KEY
      );
      CREATE TABLE "AgentRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "kind" TEXT NOT NULL,
        "origin" TEXT NOT NULL,
        "worktreeId" TEXT,
        "status" TEXT NOT NULL,
        "startedAt" DATETIME,
        "createdAt" DATETIME NOT NULL,
        CONSTRAINT "AgentRun_worktreeId_fkey"
          FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id")
          ON DELETE SET NULL ON UPDATE CASCADE
      );
      CREATE TABLE "WorktreeRunLease" (
        "worktreeId" TEXT NOT NULL PRIMARY KEY,
        "runId" TEXT NOT NULL,
        "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "WorktreeRunLease_worktreeId_fkey"
          FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "WorktreeRunLease_runId_fkey"
          FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id")
          ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE UNIQUE INDEX "WorktreeRunLease_runId_key"
        ON "WorktreeRunLease"("runId");

      INSERT INTO "Worktree" ("id") VALUES ('worktree-1'), ('worktree-2');
      INSERT INTO "AgentRun" (
        "id", "kind", "origin", "worktreeId", "status", "startedAt", "createdAt"
      ) VALUES
        ('session-active', 'SESSION', 'MANAGED', 'worktree-1', 'IN_PROGRESS', '2026-07-29T10:00:00Z', '2026-07-29T09:59:00Z'),
        ('plan-active', 'PLAN', 'MANAGED', 'worktree-1', 'IN_PROGRESS', '2026-07-29T10:01:00Z', '2026-07-29T10:00:00Z'),
        ('session-paused', 'SESSION', 'MANAGED', 'worktree-2', 'PAUSED', NULL, '2026-07-29T10:02:00Z'),
        ('plan-complete', 'PLAN', 'MANAGED', 'worktree-1', 'COMPLETED', '2026-07-29T09:00:00Z', '2026-07-29T08:59:00Z'),
        ('session-imported', 'SESSION', 'IMPORTED', 'worktree-1', 'IN_PROGRESS', '2026-07-29T10:03:00Z', '2026-07-29T10:03:00Z');
      INSERT INTO "WorktreeRunLease" ("worktreeId", "runId", "acquiredAt")
      VALUES ('worktree-1', 'session-active', '2026-07-29T10:00:00Z');
    `);

    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20260729120000_add_worktree_run_concurrency/migration.sql",
        ),
        "utf8",
      ),
    );

    expect(
      database
        .prepare(
          `SELECT "id", "worktreeConcurrencyLimit" FROM "AgentRun" ORDER BY "id"`,
        )
        .all(),
    ).toEqual([
      { id: "plan-active", worktreeConcurrencyLimit: 0 },
      { id: "plan-complete", worktreeConcurrencyLimit: 0 },
      { id: "session-active", worktreeConcurrencyLimit: 1 },
      { id: "session-imported", worktreeConcurrencyLimit: 1 },
      { id: "session-paused", worktreeConcurrencyLimit: 1 },
    ]);
    expect(
      database
        .prepare(
          `SELECT "worktreeId", "runId" FROM "WorktreeRunLease" ORDER BY "runId"`,
        )
        .all(),
    ).toEqual([
      { worktreeId: "worktree-1", runId: "plan-active" },
      { worktreeId: "worktree-1", runId: "session-active" },
      { worktreeId: "worktree-2", runId: "session-paused" },
    ]);
    expect(
      database
        .prepare(
          `SELECT "worktreeId", "kind" FROM "WorktreeRunConcurrencyLane" ORDER BY "worktreeId", "kind"`,
        )
        .all(),
    ).toEqual([
      { worktreeId: "worktree-1", kind: "PLAN" },
      { worktreeId: "worktree-1", kind: "SESSION" },
      { worktreeId: "worktree-2", kind: "SESSION" },
    ]);

    database
      .prepare(
        `INSERT INTO "WorktreeRunLease" ("id", "worktreeId", "runId") VALUES (?, ?, ?)`,
      )
      .run("extra-lease", "worktree-1", "plan-complete");
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS "count" FROM "WorktreeRunLease" WHERE "worktreeId" = ?`,
        )
        .get("worktree-1"),
    ).toEqual({ count: 3 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
