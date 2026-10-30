// @vitest-environment node
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import type { CcusageService } from "@/services/ccusage";
import type { DiskSpaceService } from "@/services/disk-space";
import type { PollingService } from "@/services/polling";
import { SystemStatusService } from "./system-status.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

let prisma: PrismaClient;
let raw: ReturnType<typeof vi.fn>;
let enabled: boolean;
beforeEach(async () => {
  enabled = true;
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  await prisma.$executeRawUnsafe(
    "CREATE TABLE Codebase (id TEXT PRIMARY KEY, defaultBranch TEXT)",
  );
  await prisma.$executeRawUnsafe(
    "CREATE TABLE Worktree (id TEXT PRIMARY KEY, codebaseId TEXT, branch TEXT, hasStagedChanges BOOLEAN, hasUnstagedChanges BOOLEAN, missingAt DATETIME)",
  );
  await prisma.$executeRawUnsafe(
    "INSERT INTO Codebase VALUES ('known', 'main'), ('unknown', NULL), ('empty', '')",
  );
  raw = vi.fn(prisma.$queryRaw.bind(prisma));
  getPrismaClient.mockResolvedValue({
    actionCenterSettings: {
      findUnique: async () => ({ showWorktreeCountsInSidebar: enabled }),
    },
    sidebarUsageSummary: {
      findUnique: async () => ({
        period: new Date().toLocaleDateString("en-CA"),
        totalCost: 0,
        collectedAt: new Date(),
      }),
    },
    agentRun: { count: async () => 0 },
    build: { count: async () => 0 },
    workflowRun: { count: async () => 0 },
    commandRun: { count: async () => 0 },
    $queryRaw: raw,
  });
});
afterEach(async () => {
  await prisma.$disconnect();
});

function service() {
  return new SystemStatusService(
    { registerCompletionObserver: vi.fn() } as unknown as CcusageService,
    {} as DiskSpaceService,
    {} as PollingService,
  );
}

test("counts staged and unstaged changes once, excludes missing worktrees, and follows each default branch", async () => {
  await prisma.$executeRawUnsafe(`INSERT INTO Worktree VALUES
    ('clean', 'known', 'main', 0, 0, NULL),
    ('staged', 'known', 'main', 1, 0, NULL),
    ('unstaged', 'known', 'feature', 0, 1, NULL),
    ('both', 'known', 'feature', 1, 1, NULL),
    ('detached', 'known', NULL, 0, 0, NULL),
    ('unknown', 'unknown', 'feature', 0, 0, NULL),
    ('empty', 'empty', 'feature', 0, 0, NULL),
    ('missing', 'known', 'feature', 1, 1, '2026-10-30')`);
  expect((await service().status(false)).activity).toMatchObject({
    dirtyWorktrees: 3,
    offMainWorktrees: 3,
  });
  await prisma.$executeRawUnsafe(
    "UPDATE Codebase SET defaultBranch = 'develop' WHERE id = 'known'",
  );
  expect((await service().status(false)).activity.offMainWorktrees).toBe(5);
});

test("empty repositories show zero counts", async () => {
  expect((await service().status(false)).activity).toMatchObject({
    dirtyWorktrees: 0,
    offMainWorktrees: 0,
  });
});

test("turning off worktree counters skips the aggregation", async () => {
  enabled = false;
  expect((await service().status(false)).activity).toMatchObject({
    dirtyWorktrees: null,
    offMainWorktrees: null,
  });
  expect(raw).not.toHaveBeenCalled();
});
