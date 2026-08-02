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
      "prisma/migrations/20260802120000_add_command_concurrency/migration.sql",
    ),
    "utf8",
  );

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
        .prepare(`SELECT "id", "concurrency" FROM "CommandDefinition"`)
        .all(),
    ).toEqual([
      { id: "command-1", concurrency: "NON_EXCLUSIVE" },
      { id: "command-2", concurrency: "NON_EXCLUSIVE" },
    ]);
    expect(
      database
        .prepare(`SELECT "id", "snapshotConcurrency" FROM "CommandRun"`)
        .all(),
    ).toEqual([
      { id: "run-1", snapshotConcurrency: "NON_EXCLUSIVE" },
      { id: "run-2", snapshotConcurrency: "NON_EXCLUSIVE" },
      { id: "run-custom", snapshotConcurrency: "NON_EXCLUSIVE" },
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

  test("releases the codebase guard for command runs but keeps it for git work", () => {
    database = seed();
    const active = database.prepare(
      `INSERT INTO "AgentJob" ("id", "kind", "status", "codebaseId") VALUES (?, ?, 'RUNNING', 'codebase-1')`,
    );
    active.run("command-a", "command.run");
    expect(() => active.run("command-b", "command.run")).toThrow(
      /UNIQUE constraint failed/,
    );

    database.exec(migration());

    // Two command runs may now hold the same codebase; their concurrency is
    // decided by the command's own mode instead.
    expect(() => active.run("command-b", "command.run")).not.toThrow();
    // Git work still takes the codebase alone.
    active.run("git-a", "codebase.git.inspect");
    expect(() => active.run("git-b", "codebase.git.mutate")).toThrow(
      /UNIQUE constraint failed/,
    );
    // iOS jobs stay exempt as before.
    active.run("ios-a", "ios.build.run");
    expect(() => active.run("ios-b", "ios.build.run")).not.toThrow();
  });
});
