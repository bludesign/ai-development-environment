import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("Jira status exclusions default to empty without changing completed settings", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`CREATE TABLE "JiraProject" ("id" TEXT PRIMARY KEY, "hideCompletedTickets" BOOLEAN, "completedStatusIdsJson" TEXT);
      INSERT INTO "JiraProject" VALUES ('project', 1, '["done"]');`);
    database.exec(
      readFileSync(
        resolve(
          "prisma/migrations/20261028010000_jira_excluded_statuses/migration.sql",
        ),
        "utf8",
      ),
    );
    expect(database.prepare('SELECT * FROM "JiraProject"').get()).toEqual({
      id: "project",
      hideCompletedTickets: 1,
      completedStatusIdsJson: '["done"]',
      excludedStatusIdsJson: "[]",
    });
  } finally {
    database.close();
  }
});
