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
});
