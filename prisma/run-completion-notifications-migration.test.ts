// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

describe("run completion notifications migration", () => {
  test("leaves existing and new runs inheriting their workflow setting", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE "AgentRun" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "workflowRunId" TEXT
        );
        INSERT INTO "AgentRun" ("id", "workflowRunId")
        VALUES ('linked', 'workflow-run'), ('standalone', NULL);
      `);
      database.exec(
        readFileSync(
          resolve(
            process.cwd(),
            "prisma/migrations/20261104200000_add_run_completion_notifications/migration.sql",
          ),
          "utf8",
        ),
      );
      database.exec(`INSERT INTO "AgentRun" ("id") VALUES ('new');`);

      expect(
        database
          .prepare(
            `SELECT "id", "workflowRunId", "completionNotificationsEnabled"
             FROM "AgentRun" ORDER BY "id"`,
          )
          .all(),
      ).toEqual([
        {
          id: "linked",
          workflowRunId: "workflow-run",
          completionNotificationsEnabled: null,
        },
        {
          id: "new",
          workflowRunId: null,
          completionNotificationsEnabled: null,
        },
        {
          id: "standalone",
          workflowRunId: null,
          completionNotificationsEnabled: null,
        },
      ]);
    } finally {
      database.close();
    }
  });
});
