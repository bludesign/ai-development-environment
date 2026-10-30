// @vitest-environment node
import { readFileSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
const mock = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => mock);
import {
  cachedReviewerDirectory,
  clearReviewerDirectory,
} from "./directory-cache";
let prisma: PrismaClient;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  for (const sql of readFileSync(
    "prisma/migrations/20261030151000_reviewer_directory_cache/migration.sql",
    "utf8",
  )
    .split(";")
    .filter((sql) => sql.trim()))
    await prisma.$executeRawUnsafe(sql);
  mock.getPrismaClient.mockResolvedValue(prisma);
});
afterEach(async () => {
  await prisma.$disconnect();
  vi.useRealTimers();
});
const read = (load: () => Promise<unknown>, extra = {}) =>
  cachedReviewerDirectory({
    provider: "GITHUB",
    scope: "connection-a",
    endpoint: "/repos/acme/app/collaborators?page=1",
    load,
    ...extra,
  });
test("persists a complete large directory and expires after 24 hours", async () => {
  const people = Array.from({ length: 1200 }, (_, id) => ({ id }));
  const load = vi.fn().mockResolvedValue(people);
  await expect(read(load)).resolves.toHaveLength(1200);
  // A different loader represents a new provider/service instance using the same database.
  const fresh = vi.fn().mockResolvedValue([{ id: "new" }]);
  await expect(read(fresh)).resolves.toHaveLength(1200);
  expect(fresh).not.toHaveBeenCalled();
  vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
  await expect(read(fresh)).resolves.toEqual([{ id: "new" }]);
  expect(fresh).toHaveBeenCalledOnce();
});
test("retains data after failed refreshes, reports stale, and isolates credentials", async () => {
  await read(async () => [{ id: 1 }]);
  const onCache = vi.fn();
  const load = vi.fn().mockRejectedValue(new Error("offline"));
  await expect(read(load, { force: true, onCache })).resolves.toEqual([
    { id: 1 },
  ]);
  expect(onCache).toHaveBeenCalledWith(true);
  expect(
    (
      await prisma.reviewerDirectorySnapshot.findFirst()
    )?.fetchedAt.toISOString(),
  ).toBe("2026-10-30T12:00:00.000Z");
  await expect(
    read(load, { scope: "different-token", onCache }),
  ).rejects.toThrow("offline");
});
test("coalesces refreshes and cache clearing fences late responses", async () => {
  let finish!: (value: unknown) => void;
  const load = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = read(load);
  const second = read(load);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  await clearReviewerDirectory("GITHUB");
  finish([{ id: 1 }]);
  await Promise.all([first, second]);
  expect(await prisma.reviewerDirectorySnapshot.count()).toBe(0);
});
