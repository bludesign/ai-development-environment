// @vitest-environment node
import { readFileSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { ActionCenterService } from "./action-center.service";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

let prisma: PrismaClient;
beforeEach(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  await prisma.$executeRawUnsafe(
    `CREATE TABLE ActionCenterSettings (id TEXT PRIMARY KEY, maximumRequestAgeDays INTEGER NOT NULL DEFAULT 30, showMyRequestsInSidebar BOOLEAN NOT NULL DEFAULT true, showReviewRequestsInSidebar BOOLEAN NOT NULL DEFAULT true, updatedAt DATETIME NOT NULL)`,
  );
  await prisma.$executeRawUnsafe(
    "INSERT INTO ActionCenterSettings VALUES ('default', 15, 0, 1, '2026-10-29T12:00:00Z')",
  );
  const migration = readFileSync(
    "prisma/migrations/20261030120000_action_center_sidebar_preferences/migration.sql",
    "utf8",
  );
  for (const statement of migration.split(";").filter((sql) => sql.trim()))
    await prisma.$executeRawUnsafe(statement);
  getPrismaClient.mockResolvedValue(prisma);
});
afterEach(async () => {
  await prisma.$disconnect();
});

test("migration enables the preferences and preserves existing request settings", async () => {
  expect(await new ActionCenterService().settings()).toMatchObject({
    maximumRequestAgeDays: 15,
    showMyRequestsInSidebar: false,
    showReviewRequestsInSidebar: true,
    confirmClearAllNotifications: true,
    showIntegrationCountsInSidebar: true,
    showWorktreeCountsInSidebar: true,
  });
});

test("persists preferences, streams changes, and preserves them for clients sending the original input", async () => {
  const service = new ActionCenterService();
  const input = {
    maximumRequestAgeDays: 30,
    showMyRequestsInSidebar: true,
    showReviewRequestsInSidebar: true,
  };
  const events = service.subscribeSettings();
  try {
    const saved = await service.saveSettings({
      ...input,
      confirmClearAllNotifications: false,
      showIntegrationCountsInSidebar: false,
      showWorktreeCountsInSidebar: false,
    });
    expect(await events.next()).toMatchObject({
      value: { actionCenterSettingsChanged: saved },
    });
    await service.saveSettings({
      ...input,
      confirmClearAllNotifications: null,
    });
    expect(await service.settings()).toMatchObject({
      confirmClearAllNotifications: false,
      showIntegrationCountsInSidebar: false,
      showWorktreeCountsInSidebar: false,
    });
  } finally {
    await events.return?.();
  }
});

test("new installations receive enabled defaults before settings are saved", async () => {
  await prisma.actionCenterSettings.deleteMany();
  expect(await new ActionCenterService().settings()).toMatchObject({
    confirmClearAllNotifications: true,
    showIntegrationCountsInSidebar: true,
    showWorktreeCountsInSidebar: true,
  });
});
