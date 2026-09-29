import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("GitLab merge operations retain Jira-only intent and are isolated by instance and MR", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      readFileSync(
        "prisma/migrations/20260930000000_add_gitlab_merge_operations/migration.sql",
        "utf8",
      ),
    );
    const insert = db.prepare(
      'INSERT INTO "GitLabMergeOperation" (id, instanceUrl, projectId, iid, branch, sha, updatedAt) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)',
    );
    insert.run("one", "https://gitlab.one", "1", 4, "feature", "abc");
    insert.run("two", "https://gitlab.two", "1", 4, "feature", "abc");
    expect(() =>
      insert.run("duplicate", "https://gitlab.one", "1", 4, "feature", "abc"),
    ).toThrow();
    expect(
      db
        .prepare(
          'SELECT state, worktreeId, deleteWorktree, moveTicketToDone FROM "GitLabMergeOperation" WHERE id = ?',
        )
        .get("one"),
    ).toEqual({
      state: "PREPARING",
      worktreeId: null,
      deleteWorktree: 0,
      moveTicketToDone: 0,
    });
    expect(
      db.prepare('PRAGMA foreign_key_list("GitLabMergeOperation")').all(),
    ).toEqual([]);
  } finally {
    db.close();
  }
});
