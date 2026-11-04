// @vitest-environment node
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("migrates legacy active work to conservative durable requests and removes codebase execution guards", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE AgentJob (id TEXT PRIMARY KEY, agentId TEXT, codebaseId TEXT, status TEXT, createdAt DATETIME);
      CREATE TABLE BuildScript (id TEXT PRIMARY KEY);
      CREATE TABLE Codebase (id TEXT PRIMARY KEY);
      CREATE TABLE WorktreeMove (id TEXT PRIMARY KEY);
      CREATE TABLE Worktree (id TEXT PRIMARY KEY, codebaseId TEXT, gitDirectory TEXT);
      CREATE TABLE AgentRun (id TEXT PRIMARY KEY, worktreeId TEXT, kind TEXT, origin TEXT);
      CREATE TABLE RunCommand (id TEXT PRIMARY KEY, runId TEXT, agentId TEXT, type TEXT, status TEXT, claimedAt DATETIME, createdAt DATETIME);
      CREATE UNIQUE INDEX AgentJob_codebaseId_active_key ON AgentJob(codebaseId) WHERE status = 'QUEUED';
      CREATE TRIGGER AgentJob_codebase_command_guard_insert BEFORE INSERT ON AgentJob BEGIN SELECT 1; END;
      CREATE TRIGGER AgentJob_codebase_command_guard_update BEFORE UPDATE ON AgentJob BEGIN SELECT 1; END;
      INSERT INTO BuildScript (id) VALUES ('hook');
      INSERT INTO AgentJob VALUES
        ('queued', 'agent', 'repo', 'QUEUED', '2026-11-03T10:00:00Z'),
        ('running', 'agent', 'repo', 'RUNNING', '2026-11-03T10:00:00Z'),
        ('cancelling', 'agent', 'repo', 'CANCELLING', '2026-11-03T10:00:00Z'),
        ('finished', 'agent', 'repo', 'SUCCEEDED', '2026-11-03T10:00:00Z'),
        ('untargeted', 'agent', NULL, 'RUNNING', '2026-11-03T10:00:00Z');
    `);
    database.exec(
      readFileSync(
        "prisma/migrations/20261103120000_operation_resource_locks/migration.sql",
        "utf8",
      ),
    );
    expect(
      database
        .prepare("SELECT ownerId, state FROM OperationHolder ORDER BY ownerId")
        .all(),
    ).toEqual([
      { ownerId: "cancelling", state: "HELD" },
      { ownerId: "queued", state: "REQUESTED" },
      { ownerId: "running", state: "HELD" },
    ]);
    expect(
      database
        .prepare("SELECT DISTINCT kind, key, mode FROM OperationResource")
        .all(),
    ).toEqual([
      { kind: "CODEBASE", key: "agent:codebase:repo", mode: "WRITE" },
    ]);
    expect(
      database
        .prepare("SELECT lockScope FROM BuildScript WHERE id = 'hook'")
        .get(),
    ).toEqual({ lockScope: "WORKTREE" });
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('AgentJob_codebaseId_active_key', 'AgentJob_codebase_command_guard_insert', 'AgentJob_codebase_command_guard_update')",
        )
        .all(),
    ).toEqual([]);
    database.exec(
      "INSERT INTO AgentJob (id, agentId, codebaseId, status, createdAt) VALUES ('another-queued', 'agent', 'repo', 'QUEUED', CURRENT_TIMESTAMP)",
    );
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
