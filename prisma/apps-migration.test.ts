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

describe("apps migration", () => {
  test("creates case-normalized apps and cascading repository assignments", () => {
    database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE "CodebaseRepository" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL
      );
    `);
    database.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "prisma/migrations/20260803230000_add_apps/migration.sql",
        ),
        "utf8",
      ),
    );
    database
      .prepare(`INSERT INTO "CodebaseRepository" ("id", "name") VALUES (?, ?)`)
      .run("repository-1", "Main");
    database
      .prepare(
        `INSERT INTO "App" ("id", "name", "normalizedName", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run("app-1", "Console", "console");
    database
      .prepare(
        `INSERT INTO "AppRepository" ("appId", "repositoryId") VALUES (?, ?)`,
      )
      .run("app-1", "repository-1");

    expect(() =>
      database!
        .prepare(
          `INSERT INTO "App" ("id", "name", "normalizedName", "updatedAt") VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        )
        .run("app-2", "CONSOLE", "console"),
    ).toThrow(/UNIQUE/);

    database.prepare(`DELETE FROM "App" WHERE "id" = ?`).run("app-1");
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM "AppRepository"`).get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(`SELECT COUNT(*) AS count FROM "CodebaseRepository"`)
        .get(),
    ).toEqual({ count: 1 });
  });
});
