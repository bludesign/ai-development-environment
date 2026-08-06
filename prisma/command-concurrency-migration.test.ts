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
  [
    "20260802120000_add_command_concurrency",
    "20260802140000_add_command_cross_kind_guards",
    "20260806100000_add_command_git_blocking",
    "20260806100500_backfill_command_job_git_blocking",
  ]
    .map((name) =>
      readFileSync(
        resolve(process.cwd(), `prisma/migrations/${name}/migration.sql`),
        "utf8",
      ),
    )
    .join("\n");

function seed(): Database.Database {
  const instance = new Database(":memory:");
  instance.exec(`
    CREATE TABLE "AgentJob" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "kind" TEXT NOT NULL,
      "status" TEXT NOT NULL,
      "codebaseId" TEXT
    );
    CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
    ON "AgentJob"("codebaseId")
    WHERE "codebaseId" IS NOT NULL
      AND "status" IN ('QUEUED', 'RUNNING')
      AND "kind" NOT LIKE 'ios.%';

    CREATE TABLE "CommandDefinition" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "name" TEXT NOT NULL
    );
    CREATE TABLE "CommandRun" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "commandId" TEXT,
      "snapshotName" TEXT NOT NULL
    );
    CREATE TABLE "CommandRunAttempt" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "runId" TEXT NOT NULL,
      "agentJobId" TEXT
    );

    INSERT INTO "CommandDefinition" ("id", "name")
    VALUES ('command-1', 'Build'), ('command-2', 'Tail logs');
    INSERT INTO "CommandRun" ("id", "commandId", "snapshotName") VALUES
      ('run-1', 'command-1', 'Build'),
      ('run-2', 'command-2', 'Tail logs'),
      ('run-custom', NULL, 'Custom command');
  `);
  return instance;
}

describe("command concurrency migration", () => {
  test("defaults every existing command and run to the permissive mode", () => {
    database = seed();
    database.exec(migration());

    expect(
      database
        .prepare(
          `SELECT "id", "concurrency", "blocksGitOperations" FROM "CommandDefinition"`,
        )
        .all(),
    ).toEqual([
      {
        id: "command-1",
        concurrency: "NON_EXCLUSIVE",
        blocksGitOperations: 0,
      },
      {
        id: "command-2",
        concurrency: "NON_EXCLUSIVE",
        blocksGitOperations: 0,
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT "id", "snapshotConcurrency", "snapshotBlocksGitOperations" FROM "CommandRun"`,
        )
        .all(),
    ).toEqual([
      {
        id: "run-1",
        snapshotConcurrency: "NON_EXCLUSIVE",
        snapshotBlocksGitOperations: 0,
      },
      {
        id: "run-2",
        snapshotConcurrency: "NON_EXCLUSIVE",
        snapshotBlocksGitOperations: 0,
      },
      {
        id: "run-custom",
        snapshotConcurrency: "NON_EXCLUSIVE",
        snapshotBlocksGitOperations: 0,
      },
    ]);
  });

  test("backfills run snapshots from the command they belong to", () => {
    database = seed();
    database.exec(migration());
    // A second application is not what happens in production, but it is the
    // cheapest way to prove the backfill reads the definition rather than the
    // column default.
    database
      .prepare(
        `UPDATE "CommandDefinition" SET "concurrency" = 'EXCLUSIVE' WHERE "id" = 'command-1'`,
      )
      .run();
    database
      .prepare(
        `UPDATE "CommandRun"
         SET "snapshotConcurrency" = (
           SELECT "concurrency" FROM "CommandDefinition"
           WHERE "CommandDefinition"."id" = "CommandRun"."commandId"
         )
         WHERE "commandId" IS NOT NULL`,
      )
      .run();

    expect(
      database
        .prepare(
          `SELECT "snapshotConcurrency" FROM "CommandRun" WHERE "id" = 'run-1'`,
        )
        .get(),
    ).toEqual({ snapshotConcurrency: "EXCLUSIVE" });
    // A custom run has no definition to read, so it keeps the default.
    expect(
      database
        .prepare(
          `SELECT "snapshotConcurrency" FROM "CommandRun" WHERE "id" = 'run-custom'`,
        )
        .get(),
    ).toEqual({ snapshotConcurrency: "NON_EXCLUSIVE" });
  });

  test("allows non-blocking command peers to overlap repository work", () => {
    database = seed();
    const beforeMigration = database.prepare(
      `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId") VALUES (?, ?, 'RUNNING', 'codebase-1')`,
    );
    beforeMigration.run("command-a", "command.run");
    expect(() => beforeMigration.run("command-b", "command.run")).toThrow(
      /UNIQUE constraint failed/,
    );

    database.exec(migration());
    const active = database.prepare(
      `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId", "blocksGitOperations") VALUES (?, ?, 'RUNNING', ?, ?)`,
    );

    // Two command runs may hold the same codebase; their concurrency is
    // decided by the command's own mode.
    expect(() =>
      active.run("command-b", "command.run", "codebase-1", 0),
    ).not.toThrow();
    // Commands using the permissive default may overlap repository work.
    expect(() =>
      active.run("git-a", "codebase.git.inspect", "codebase-1", 0),
    ).not.toThrow();
    expect(() =>
      active.run("command-c", "command.run", "codebase-1", 0),
    ).not.toThrow();
    // Repository work still serializes with other repository work.
    expect(() =>
      active.run("git-b", "codebase.git.mutate", "codebase-1", 0),
    ).toThrow(/UNIQUE constraint failed/);

    // A command that opted into Git blocking prevents repository work.
    active.run("command-blocking", "command.run", "codebase-2", 1);
    expect(() =>
      active.run("git-blocked", "codebase.git.inspect", "codebase-2", 0),
    ).toThrow(/AgentJob_codebaseId_active_key/);

    // The opposite scheduling order is guarded as well, but a non-blocking
    // command may still enter.
    active.run("git-first", "codebase.git.inspect", "codebase-3", 0);
    expect(() =>
      active.run("command-blocked", "command.run", "codebase-3", 1),
    ).toThrow(/AgentJob_codebaseId_active_key/);
    expect(() =>
      active.run("command-allowed", "command.run", "codebase-3", 0),
    ).not.toThrow();

    // iOS jobs stay exempt as before.
    active.run("ios-a", "ios.build.run", "codebase-1", 0);
    expect(() =>
      active.run("ios-b", "ios.build.run", "codebase-1", 0),
    ).not.toThrow();
  });

  test("backfills the Git-blocking snapshot onto existing command jobs", () => {
    database = seed();
    database.exec(migration());
    database
      .prepare(
        `UPDATE "CommandRun" SET "snapshotBlocksGitOperations" = true WHERE "id" = 'run-1'`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId") VALUES ('command-existing', 'command.run', 'RUNNING', 'codebase-1')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO "CommandRunAttempt" ("id", "runId", "agentJobId") VALUES ('attempt-1', 'run-1', 'command-existing')`,
      )
      .run();

    const backfill = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260806100500_backfill_command_job_git_blocking/migration.sql",
      ),
      "utf8",
    );
    database.exec(backfill);

    expect(
      database
        .prepare(
          `SELECT "blocksGitOperations" FROM "AgentJob" WHERE "id" = 'command-existing'`,
        )
        .get(),
    ).toEqual({ blocksGitOperations: 1 });
  });

  test("applies the opt-in guard when a command becomes blocking", () => {
    database = seed();
    database.exec(migration());
    database
      .prepare(
        `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId", "blocksGitOperations") VALUES ('command-a', 'command.run', 'RUNNING', 'codebase-1', false)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId") VALUES ('git-a', 'codebase.git.inspect', 'RUNNING', 'codebase-1')`,
      )
      .run();

    expect(() =>
      database!
        .prepare(
          `UPDATE "AgentJob" SET "blocksGitOperations" = true WHERE "id" = 'command-a'`,
        )
        .run(),
    ).toThrow(/AgentJob_codebaseId_active_key/);
  });

  test("applies the cross-kind guard when existing repository work becomes active", () => {
    database = seed();
    database.exec(migration());
    database
      .prepare(
        `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId", "blocksGitOperations") VALUES ('command-a', 'command.run', 'RUNNING', 'codebase-1', true)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId") VALUES ('git-a', 'codebase.git.inspect', 'SUCCEEDED', 'codebase-1')`,
      )
      .run();

    expect(() =>
      database!
        .prepare(
          `UPDATE "AgentJob" SET "status" = 'QUEUED' WHERE "id" = 'git-a'`,
        )
        .run(),
    ).toThrow(/AgentJob_codebaseId_active_key/);
  });
});
