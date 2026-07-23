// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";

import { nextDisplayNumber } from "./runs.service";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("run display number allocation", () => {
  test("starts each kind at zero and never derives numbers from remaining rows", async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ kind: "PLAN", nextValue: 1 })
      .mockResolvedValueOnce({ kind: "PLAN", nextValue: 2 })
      .mockResolvedValueOnce({ kind: "SESSION", nextValue: 1 });
    const transaction = { runNumberSequence: { upsert } } as never;

    await expect(nextDisplayNumber(transaction, "PLAN")).resolves.toBe(0);
    await expect(nextDisplayNumber(transaction, "PLAN")).resolves.toBe(1);
    await expect(nextDisplayNumber(transaction, "SESSION")).resolves.toBe(0);
    expect(upsert).toHaveBeenNthCalledWith(1, {
      where: { kind: "PLAN" },
      create: { kind: "PLAN", nextValue: 1 },
      update: { nextValue: { increment: 1 } },
    });
  });

  test("allocates zero-based numbers atomically under concurrent transactions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aide-run-number-test-"));
    directories.push(directory);
    const prisma = new PrismaClient({
      adapter: new PrismaBetterSqlite3({ url: join(directory, "test.db") }),
    });
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "RunNumberSequence" (
        "kind" TEXT NOT NULL PRIMARY KEY,
        "nextValue" INTEGER NOT NULL DEFAULT 0,
        "updatedAt" DATETIME NOT NULL
      )
    `);
    try {
      const plans = await Promise.all(
        Array.from({ length: 16 }, () =>
          prisma.$transaction((transaction) =>
            nextDisplayNumber(transaction, "PLAN"),
          ),
        ),
      );
      const sessions = await Promise.all(
        Array.from({ length: 8 }, () =>
          prisma.$transaction((transaction) =>
            nextDisplayNumber(transaction, "SESSION"),
          ),
        ),
      );
      expect(plans.toSorted((left, right) => left - right)).toEqual(
        Array.from({ length: 16 }, (_, index) => index),
      );
      expect(sessions.toSorted((left, right) => left - right)).toEqual(
        Array.from({ length: 8 }, (_, index) => index),
      );
      await expect(
        prisma.$transaction((transaction) =>
          nextDisplayNumber(transaction, "PLAN"),
        ),
      ).resolves.toBe(16);
    } finally {
      await prisma.$disconnect();
    }
  });
});
