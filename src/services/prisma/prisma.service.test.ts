// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

// Integration test: exercises the real Prisma client + better-sqlite3 driver adapter against
// a throwaway SQLite database, proving DB connectivity end-to-end (CI does not run the dev
// server). DATABASE_URL is set before importing the client so its singleton connects here.
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "aide-db-test-"));
  process.env.DATABASE_URL = `file:${join(tmpDir, "test.db")}`;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("PrismaService.healthCheck resolves true against a SQLite database", async () => {
  const { PrismaService } = await import("@/services/prisma");
  const service = new PrismaService();
  await expect(service.healthCheck()).resolves.toBe(true);
});
