import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
import {
  DEFAULT_LIVE_ACTIVITY_SETTINGS,
  LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC,
  liveActivitySettings,
  saveLiveActivitySettings,
} from "./live-activity-settings";

let prisma: PrismaClient;
beforeEach(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: ":memory:" }),
  });
  await prisma.$executeRawUnsafe(
    readFileSync(
      resolve(
        process.cwd(),
        "prisma/migrations/20261117220000_live_activity_settings/migration.sql",
      ),
      "utf8",
    ),
  );
  getPrismaClient.mockResolvedValue(prisma);
});
afterEach(async () => {
  await prisma.$disconnect();
});

test("persists a singleton with every work category enabled by default", async () => {
  const settings = await liveActivitySettings();
  expect(settings).toMatchObject({
    id: "default",
    ...DEFAULT_LIVE_ACTIVITY_SETTINGS,
    updatedAt: expect.any(Date),
  });
  expect(await liveActivitySettings()).toEqual(settings);
  expect(await prisma.liveActivitySettings.count()).toBe(1);
});

test("partial updates preserve omitted and null categories across subsequent reads", async () => {
  await saveLiveActivitySettings({
    includePlans: false,
    includeSessions: false,
  });
  await saveLiveActivitySettings({ includePlans: null, includeBuilds: false });
  expect(await liveActivitySettings()).toMatchObject({
    ...DEFAULT_LIVE_ACTIVITY_SETTINGS,
    includePlans: false,
    includeSessions: false,
    includeBuilds: false,
  });
  await saveLiveActivitySettings({ includeSessions: true });
  expect(
    await prisma.liveActivitySettings.findUnique({ where: { id: "default" } }),
  ).toMatchObject({
    includePlans: false,
    includeSessions: true,
    includeBuilds: false,
  });
});

test("settings changes notify the settings UI and the existing native status stream", async () => {
  const settingsChanges = agentEventBus.iterate(
    LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC,
  );
  const statusChanges = agentEventBus.iterate(SIDEBAR_STATUS_CHANGED_TOPIC);
  try {
    const saved = await saveLiveActivitySettings({
      includeGitHubActions: false,
    });
    expect((await settingsChanges.next()).value).toEqual({
      liveActivitySettingsChanged: saved,
    });
    expect((await statusChanges.next()).value).toEqual({
      sidebarStatusChanged: true,
    });
  } finally {
    await settingsChanges.return?.();
    await statusChanges.return?.();
  }
});

test("rejects unsupported fields and non-boolean values before persisting changes", async () => {
  await expect(
    saveLiveActivitySettings({ includePlans: "false" } as never),
  ).rejects.toThrow(/boolean/);
  await expect(
    saveLiveActivitySettings({ userId: "other" } as never),
  ).rejects.toThrow(/Unknown/);
  expect(await prisma.liveActivitySettings.count()).toBe(0);
});
