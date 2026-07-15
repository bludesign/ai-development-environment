// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

// Integration test: exercises the real Prisma client + better-sqlite3 driver adapter against
// a throwaway SQLite database, proving DB connectivity end-to-end (CI does not run the dev
// server). DATABASE_URL is set before importing the client so its singleton connects here.
let tmpDir: string;
let databasePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aide-db-test-"));
  databasePath = join(tmpDir, "test.db");
  process.env.DATABASE_URL = `file:${databasePath}`;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("PrismaService.healthCheck resolves true against a SQLite database", async () => {
  expect(existsSync(databasePath)).toBe(false);
  const { PrismaService } = await import("@/services/prisma");
  expect(existsSync(databasePath)).toBe(false);

  const service = new PrismaService();
  await expect(service.healthCheck()).resolves.toBe(true);
  expect(existsSync(databasePath)).toBe(true);
});
