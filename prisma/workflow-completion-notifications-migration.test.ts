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

describe("workflow completion notifications migration", () => {
  test("enables successful completion notifications for existing workflows", () => {
    database = new Database(":memory:");
    database.exec(`
      CREATE TABLE "Workflow" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL
      );
      INSERT INTO "Workflow" ("id", "name") VALUES ('workflow-1', 'Existing');
    `);

    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20260728140000_add_workflow_completion_notifications/migration.sql",
        ),
        "utf8",
      ),
    );

    expect(
      database
        .prepare(
          `SELECT "completionNotificationsEnabled" FROM "Workflow" WHERE "id" = ?`,
        )
        .get("workflow-1"),
    ).toEqual({ completionNotificationsEnabled: 1 });
  });
});
