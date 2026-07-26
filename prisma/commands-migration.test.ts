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

describe("commands migration", () => {
  test("adds command storage and only cancels active legacy tunnel jobs", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "Agent" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "CodebaseRepository" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "Worktree" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "AgentJob" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "kind" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "error" TEXT,
        "finishedAt" DATETIME,
        "updatedAt" DATETIME NOT NULL
      );
      INSERT INTO "AgentJob" ("id", "kind", "status", "updatedAt") VALUES
        ('queued', 'cloudflared.runTunnel', 'QUEUED', CURRENT_TIMESTAMP),
        ('running', 'cloudflared.runTunnel', 'RUNNING', CURRENT_TIMESTAMP),
        ('completed', 'cloudflared.runTunnel', 'SUCCEEDED', CURRENT_TIMESTAMP),
        ('other', 'other.capability', 'RUNNING', CURRENT_TIMESTAMP);
    `);

    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20260725180000_add_commands/migration.sql",
        ),
        "utf8",
      ),
    );

    expect(
      database
        .prepare(
          `SELECT "id", "status", "error", "finishedAt" FROM "AgentJob" ORDER BY "id"`,
        )
        .all(),
    ).toEqual([
      {
        id: "completed",
        status: "SUCCEEDED",
        error: null,
        finishedAt: null,
      },
      { id: "other", status: "RUNNING", error: null, finishedAt: null },
      {
        id: "queued",
        status: "CANCELLED",
        error:
          "cloudflared.runTunnel was removed; create a saved command instead",
        finishedAt: expect.any(String),
      },
      {
        id: "running",
        status: "CANCELLED",
        error:
          "cloudflared.runTunnel was removed; create a saved command instead",
        finishedAt: expect.any(String),
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Command%' ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "CommandDefinition" },
      { name: "CommandRun" },
      { name: "CommandRunAttempt" },
      { name: "CommandRunNumberSequence" },
      { name: "CommandRunOutputChunk" },
    ]);
  });

  test("allows definition-less command runs without changing saved runs", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "Agent" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "CodebaseRepository" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "Worktree" ("id" TEXT NOT NULL PRIMARY KEY);
      CREATE TABLE "AgentJob" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "kind" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "error" TEXT,
        "finishedAt" DATETIME,
        "updatedAt" DATETIME NOT NULL
      );
    `);
    for (const migration of [
      "20260725180000_add_commands",
      "20260725210000_add_command_run_notifications",
    ]) {
      database.exec(
        readFileSync(
          resolve(
            process.cwd(),
            `prisma/migrations/${migration}/migration.sql`,
          ),
          "utf8",
        ),
      );
    }
    database.exec(`
      INSERT INTO "CommandDefinition" (
        "id", "name", "script", "targetKind", "createdAt", "updatedAt"
      ) VALUES (
        'command-1', 'Saved', 'printf saved', 'ANY_AGENT_HOME',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "CommandRun" (
        "id", "displayNumber", "commandId", "idempotencyKey", "snapshotName",
        "snapshotScript", "snapshotTargetKind", "agentName", "agentHostname",
        "createdAt", "updatedAt"
      ) VALUES (
        'run-saved', 1, 'command-1', 'saved-key', 'Saved', 'printf saved',
        'ANY_AGENT_HOME', 'Agent', 'agent.local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
      INSERT INTO "CommandRunAttempt" (
        "id", "runId", "attempt", "createdAt", "updatedAt"
      ) VALUES (
        'attempt-saved', 'run-saved', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);
    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20260726010000_allow_custom_command_runs/migration.sql",
        ),
        "utf8",
      ),
    );
    database.exec(`
      INSERT INTO "CommandRun" (
        "id", "displayNumber", "commandId", "idempotencyKey", "snapshotName",
        "snapshotScript", "snapshotTargetKind", "agentName", "agentHostname",
        "createdAt", "updatedAt"
      ) VALUES (
        'run-custom', 2, NULL, 'custom-key', 'Custom command', 'printf custom',
        'ANY_AGENT_HOME', 'Agent', 'agent.local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );
    `);

    expect(
      database
        .prepare(
          `SELECT "id", "commandId" FROM "CommandRun" ORDER BY "displayNumber"`,
        )
        .all(),
    ).toEqual([
      { id: "run-saved", commandId: "command-1" },
      { id: "run-custom", commandId: null },
    ]);
    expect(
      database.prepare(`SELECT "id", "runId" FROM "CommandRunAttempt"`).all(),
    ).toEqual([{ id: "attempt-saved", runId: "run-saved" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
