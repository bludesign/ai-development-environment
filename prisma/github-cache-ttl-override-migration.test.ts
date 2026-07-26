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

describe("GitHub cache TTL override migration", () => {
  test("creates the override table and seeds the worktree status TTL", () => {
    database = new Database(":memory:");
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20260726070000_add_github_graphql_cache_ttl_overrides/migration.sql",
      ),
      "utf8",
    );

    database.exec(migration);

    expect(
      database
        .prepare(
          `SELECT "operation", "ttlSeconds" FROM "GitHubGraphqlCacheTtlOverride"`,
        )
        .all(),
    ).toEqual([
      {
        operation: "GitHubWorktreePullRequestStatuses",
        ttlSeconds: 60,
      },
    ]);
  });
});
