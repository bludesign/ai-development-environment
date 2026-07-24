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

describe("run Jira summary migration", () => {
  test("drops stored summaries while preserving ticket keys", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "AgentRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "jiraIssueKey" TEXT,
        "jiraSummary" TEXT
      );
      CREATE TABLE "RunDraft" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "jiraIssueKey" TEXT,
        "jiraSummary" TEXT
      );
      INSERT INTO "AgentRun" ("id", "jiraIssueKey", "jiraSummary")
      VALUES ('run-1', 'AIDE-123', 'Stored run summary');
      INSERT INTO "RunDraft" ("id", "jiraIssueKey", "jiraSummary")
      VALUES ('draft-1', 'AIDE-456', 'Stored draft summary');
    `);

    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260724160000_drop_run_jira_summary/migration.sql",
      ),
      "utf8",
    );
    database.exec(migration);

    const columns = (table: string) =>
      (
        database!.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name);
    expect(columns("AgentRun")).toEqual(["id", "jiraIssueKey"]);
    expect(columns("RunDraft")).toEqual(["id", "jiraIssueKey"]);
    expect(
      database
        .prepare(`SELECT "jiraIssueKey" FROM "AgentRun" WHERE "id" = ?`)
        .get("run-1"),
    ).toEqual({ jiraIssueKey: "AIDE-123" });
    expect(
      database
        .prepare(`SELECT "jiraIssueKey" FROM "RunDraft" WHERE "id" = ?`)
        .get("draft-1"),
    ).toEqual({ jiraIssueKey: "AIDE-456" });
  });
});
