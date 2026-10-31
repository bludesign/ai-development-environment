// @vitest-environment node
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("migration enables the new preferences and protects existing worktrees from old creation replays", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE ActionCenterSettings (id TEXT PRIMARY KEY);
      CREATE TABLE WorktreeSettings (id TEXT PRIMARY KEY, editorVariant TEXT);
      CREATE TABLE Worktree (id TEXT PRIMARY KEY, highlightColor TEXT);
      INSERT INTO ActionCenterSettings VALUES ('default');
      INSERT INTO WorktreeSettings VALUES ('default', 'CODE_INSIDERS');
      INSERT INTO Worktree VALUES ('existing', NULL);`);
    db.exec(
      readFileSync(
        "prisma/migrations/20261030150000_sidebar_worktree_preferences/migration.sql",
        "utf8",
      ),
    );
    expect(
      db.prepare("SELECT * FROM ActionCenterSettings").get(),
    ).toMatchObject({
      hideUnapprovedRequestsInSidebar: 1,
      hideRunningPipelineRequestsInSidebar: 1,
    });
    expect(db.prepare("SELECT * FROM WorktreeSettings").get()).toMatchObject({
      editorVariant: "CODE_INSIDERS",
      autoAssignHighlightColor: 1,
      highlightColorMode: "SPREAD",
    });
    expect(db.prepare("SELECT * FROM Worktree").get()).toMatchObject({
      highlightColor: null,
      initialHighlightApplied: 1,
    });
    db.exec("INSERT INTO Worktree (id) VALUES ('new')");
    expect(
      db
        .prepare("SELECT initialHighlightApplied FROM Worktree WHERE id='new'")
        .get(),
    ).toEqual({ initialHighlightApplied: 0 });
  } finally {
    db.close();
  }
});
