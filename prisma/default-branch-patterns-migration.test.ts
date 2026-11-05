import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("default branch pattern migration preserves existing maintenance settings", () => {
  const database = new Database(":memory:");
  try {
    database.exec(
      'CREATE TABLE "CodebaseRepository" ("id" TEXT PRIMARY KEY, "keepBaseBranchUpToDate" BOOLEAN); INSERT INTO "CodebaseRepository" VALUES (\'on\', 1), (\'off\', 0);',
    );
    database.exec(
      readFileSync(
        resolve(
          "prisma/migrations/20261104160000_repository_default_branch_patterns/migration.sql",
        ),
        "utf8",
      ),
    );
    expect(
      database
        .prepare('SELECT * FROM "CodebaseRepository" ORDER BY "id"')
        .all(),
    ).toEqual([
      { id: "off", keepBaseBranchUpToDate: 0, defaultBranchPatternsJson: "[]" },
      { id: "on", keepBaseBranchUpToDate: 1, defaultBranchPatternsJson: "[]" },
    ]);
  } finally {
    database.close();
  }
});
