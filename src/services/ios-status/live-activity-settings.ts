import "server-only";
import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";

export const LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC =
  "live-activity-settings.changed";
export const DEFAULT_LIVE_ACTIVITY_SETTINGS = {
  includePlans: true,
  includeSessions: true,
  includeBuilds: true,
  includeWorkflows: true,
  includeCommands: true,
  includeGitHubActions: true,
  includeGitLabPipelines: true,
} as const;

export type LiveActivityCategorySettings = {
  -readonly [Key in keyof typeof DEFAULT_LIVE_ACTIVITY_SETTINGS]: boolean;
};
export type SaveLiveActivitySettingsInput = {
  [Key in keyof LiveActivityCategorySettings]?: boolean | null;
};

export async function liveActivitySettings() {
  const prisma = await getPrismaClient();
  return prisma.liveActivitySettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });
}

export async function saveLiveActivitySettings(
  input: SaveLiveActivitySettingsInput,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Live Activity settings must be an object");
  }
  const update: Partial<LiveActivityCategorySettings> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(DEFAULT_LIVE_ACTIVITY_SETTINGS, name)) {
      throw new Error(`Unknown Live Activity setting: ${name}`);
    }
    if (value == null) continue;
    if (typeof value !== "boolean")
      throw new Error(`${name} must be a boolean`);
    update[name as keyof LiveActivityCategorySettings] = value;
  }
  const prisma = await getPrismaClient();
  // Update only supplied columns so concurrent changes to separate categories never clobber each other.
  const saved = await prisma.liveActivitySettings.upsert({
    where: { id: "default" },
    create: { id: "default", ...update },
    update,
  });
  agentEventBus.publish(LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC, {
    liveActivitySettingsChanged: saved,
  });
  // Native foreground consumers and the APNs reconciler already observe the sidebar invalidation.
  agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
    sidebarStatusChanged: true,
  });
  return saved;
}
