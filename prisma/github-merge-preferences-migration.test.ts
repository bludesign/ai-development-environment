import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("merge preferences preserve existing settings and start with compatible defaults", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`CREATE TABLE "GitHubSettings" ("id" TEXT PRIMARY KEY, "defaultJiraKeyRegex" TEXT);
      INSERT INTO "GitHubSettings" VALUES ('default', 'existing-pattern');`);
    database.exec(
      readFileSync(
        "prisma/migrations/20260929100000_add_github_merge_preferences/migration.sql",
        "utf8",
      ),
    );
    expect(database.prepare('SELECT * FROM "GitHubSettings"').get()).toEqual({
      id: "default",
      defaultJiraKeyRegex: "existing-pattern",
      defaultMergeMethod: "SQUASH",
      emptyMergeCommitDescription: 0,
      defaultMoveTicketToDone: 0,
      defaultDeleteWorktree: 0,
    });
  } finally {
    database.close();
  }
});
