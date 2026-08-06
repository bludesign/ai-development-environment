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

const migration = () =>
  readFileSync(
    resolve(
      process.cwd(),
      "prisma/migrations/20260806110000_add_workflow_worktree_concurrency/migration.sql",
    ),
    "utf8",
  );

function seed(): Database.Database {
  const instance = new Database(":memory:");
  instance.exec(`
    CREATE TABLE "Workflow" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "exclusiveWorktree" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "WorkflowRun" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "exclusiveWorktree" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE "AgentJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "kind" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "codebaseId" TEXT,
      "blocksGitOperations" BOOLEAN NOT NULL DEFAULT false
    );
    CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
    ON "AgentJob"("codebaseId")
    WHERE "codebaseId" IS NOT NULL
      AND "status" IN ('QUEUED', 'RUNNING')
      AND "kind" NOT LIKE 'ios.%'
      AND "kind" <> 'command.run';

    INSERT INTO "Workflow" ("id", "exclusiveWorktree") VALUES
      ('shared', false),
      ('exclusive', true);
    INSERT INTO "WorkflowRun" ("id", "exclusiveWorktree") VALUES
      ('run-shared', false),
      ('run-exclusive', true);
  `);
  return instance;
}

describe("workflow worktree concurrency migration", () => {
  test("preserves reserved workflows and defaults the rest to shared", () => {
    database = seed();
    database.exec(migration());

    expect(
      database
        .prepare(
          `SELECT "id", "worktreeConcurrency", "blocksGitOperations" FROM "Workflow" ORDER BY "id"`,
        )
        .all(),
    ).toEqual([
      {
        id: "exclusive",
        worktreeConcurrency: "EXCLUSIVE",
        blocksGitOperations: 1,
      },
      {
        id: "shared",
        worktreeConcurrency: "NON_EXCLUSIVE",
        blocksGitOperations: 0,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT "id", "worktreeConcurrency", "blocksGitOperations" FROM "WorkflowRun" ORDER BY "id"`,
        )
        .all(),
    ).toEqual([
      {
        id: "run-exclusive",
        worktreeConcurrency: "EXCLUSIVE",
        blocksGitOperations: 1,
      },
      {
        id: "run-shared",
        worktreeConcurrency: "NON_EXCLUSIVE",
        blocksGitOperations: 0,
      },
    ]);
  });

  test("lets non-blocking workflow terminals overlap Git and guards opt-ins", () => {
    database = seed();
    database.exec(migration());
    const active = database.prepare(
      `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId", "blocksGitOperations") VALUES (?, ?, 'RUNNING', ?, ?)`,
    );

    active.run("terminal-shared", "workflow.terminal.run", "codebase-1", 0);
    expect(() =>
      active.run("git-shared", "codebase.git.inspect", "codebase-1", 0),
    ).not.toThrow();

    active.run("terminal-blocking", "workflow.terminal.run", "codebase-2", 1);
    expect(() =>
      active.run("git-blocked", "codebase.git.inspect", "codebase-2", 0),
    ).toThrow(/AgentJob_codebaseId_active_key/);

    active.run("git-first", "codebase.git.inspect", "codebase-3", 0);
    expect(() =>
      active.run("terminal-blocked", "workflow.terminal.run", "codebase-3", 1),
    ).toThrow(/AgentJob_codebaseId_active_key/);
    expect(() =>
      active.run("terminal-allowed", "workflow.terminal.run", "codebase-3", 0),
    ).not.toThrow();
  });
});
