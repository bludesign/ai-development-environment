// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import {
  historicalBuildBranches,
  historicalBranchBuildIds,
} from "./build-history-branches";

let database: Database.Database;
let prisma: Pick<PrismaClient, "$queryRaw">;
beforeEach(() => {
  database = new Database(":memory:");
  database.exec(`CREATE TABLE Build (id TEXT PRIMARY KEY, createdAt INTEGER, status TEXT, repositoryId TEXT, configurationId TEXT, codebaseId TEXT, worktreeId TEXT, snapshotJson TEXT);
    CREATE TABLE AppRepository (appId TEXT, repositoryId TEXT);
    INSERT INTO AppRepository VALUES ('app', 'repo');`);
  prisma = {
    $queryRaw: async (query: Prisma.Sql) =>
      database.prepare(query.sql).all(...query.values),
  } as Pick<PrismaClient, "$queryRaw">;
});
afterEach(() => database.close());

function build(
  id: string,
  branch: unknown,
  options: {
    repositoryId?: string;
    status?: string;
    configurationId?: string;
    snapshot?: string;
    createdAt?: number;
  } = {},
) {
  database
    .prepare("INSERT INTO Build VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      id,
      options.createdAt ?? 1,
      options.status ?? "SUCCEEDED",
      options.repositoryId ?? "repo",
      options.configurationId ?? "config",
      "codebase",
      null,
      options.snapshot ?? JSON.stringify({ worktree: { branch } }),
    );
}

describe("historical build branches", () => {
  test("scopes distinct historical choices, independent of status and current worktree availability", async () => {
    build("one", "feature/old");
    build("duplicate", "feature/old", { status: "FAILED" });
    build("failed", "feature/failed", { status: "FAILED" });
    build("other-repo", "feature/other", { repositoryId: "other" });
    build("other-config", "feature/config", { configurationId: "other" });
    build("detached", null);
    build("empty", "");
    build("malformed", null, { snapshot: "invalid json" });
    build("wrong-type", 2);
    build("array", ["feature/array"]);
    build("object", { branch: "feature/object" });
    expect(
      await historicalBuildBranches(prisma, {
        appId: "app",
        configurationId: "config",
      }),
    ).toEqual(["feature/failed", "feature/old"]);
    expect(
      await historicalBuildBranches(prisma, { repositoryId: "other" }),
    ).toEqual(["feature/other"]);
  });

  test("matches exact branches safely and paginates tied dates across the complete history", async () => {
    for (let index = 0; index < 60; index++)
      build(`build-${String(index).padStart(2, "0")}`, "feature/old");
    build("uppercase", "FEATURE/OLD");
    build("suffix", "feature/old-more");
    build("failed", "feature/old", { status: "FAILED" });
    build("other", "feature/old", { repositoryId: "other" });
    const scope = {
      branch: "feature/old",
      repositoryId: "repo",
      status: "SUCCEEDED",
      first: 50,
    };
    const first = await historicalBranchBuildIds(prisma, scope);
    expect(first).toHaveLength(51);
    expect(first[0]).toBe("build-59");
    const second = await historicalBranchBuildIds(prisma, {
      ...scope,
      after: first[49],
    });
    expect(second).toHaveLength(10);
    expect(second.at(-1)).toBe("build-00");
    expect(new Set([...first.slice(0, 50), ...second]).size).toBe(60);
    expect(
      await historicalBranchBuildIds(prisma, {
        ...scope,
        branch: "' OR 1 = 1 --",
      }),
    ).toEqual([]);
  });
});
