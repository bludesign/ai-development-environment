import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("post-merge switching remains disabled for existing provider operations", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      'CREATE TABLE "WorktreeAutoMerge" (worktreeId TEXT PRIMARY KEY); CREATE TABLE "GitLabMergeOperation" (id TEXT PRIMARY KEY);',
    );
    db.exec(
      "INSERT INTO \"WorktreeAutoMerge\" VALUES ('primary'); INSERT INTO \"GitLabMergeOperation\" VALUES ('mr');",
    );
    db.exec(
      readFileSync(
        "prisma/migrations/20261106160000_post_merge_switch/migration.sql",
        "utf8",
      ),
    );
    for (const table of ["WorktreeAutoMerge", "GitLabMergeOperation"]) {
      expect(
        db.prepare(`SELECT postMergeSwitchJson FROM "${table}"`).get(),
      ).toEqual({ postMergeSwitchJson: null });
    }
  } finally {
    db.close();
  }
});
