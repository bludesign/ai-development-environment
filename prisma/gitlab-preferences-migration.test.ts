import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("GitLab discovery and merge preferences preserve settings with safe defaults", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`CREATE TABLE "GitLabSettings" (
        "id" TEXT PRIMARY KEY,
        "pipelinePollIntervalSeconds" INTEGER NOT NULL DEFAULT 60
      );
      INSERT INTO "GitLabSettings" ("id", "pipelinePollIntervalSeconds")
      VALUES ('default', 120);`);
    database.exec(
      readFileSync(
        "prisma/migrations/20260930120000_add_gitlab_preferences/migration.sql",
        "utf8",
      ),
    );

    expect(database.prepare('SELECT * FROM "GitLabSettings"').get()).toEqual({
      id: "default",
      pipelinePollIntervalSeconds: 120,
      memberProjectsOnly: 1,
      defaultSquash: 1,
      defaultMoveTicketToDone: 0,
      defaultDeleteWorktree: 0,
    });
  } finally {
    database.close();
  }
});
