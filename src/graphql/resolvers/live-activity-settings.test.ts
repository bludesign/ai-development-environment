import { expect, test, vi } from "vitest";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
const service = vi.hoisted(() => ({
  liveActivitySettings: vi.fn(),
  saveLiveActivitySettings: vi.fn(),
}));
vi.mock("@/services/ios-status/live-activity-settings", () => ({
  ...service,
  LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC: "test-live-activity-settings",
}));
import { createLiveActivitySettingsResolvers } from "./live-activity-settings";

test("agent credentials cannot read, change, or subscribe to Live Activity settings", () => {
  const resolver = createLiveActivitySettingsResolvers();
  const context = { agentId: "agent-1" } as GraphQLContext;
  expect(() => resolver.Query.liveActivitySettings({}, {}, context)).toThrow(
    /Agent credentials/,
  );
  expect(() =>
    resolver.Mutation.saveLiveActivitySettings(
      {},
      { input: { includePlans: false } },
      context,
    ),
  ).toThrow(/Agent credentials/);
  expect(() =>
    resolver.Subscription.liveActivitySettingsChanged.subscribe(
      {},
      {},
      context,
    ),
  ).toThrow(/Agent credentials/);
  expect(service.liveActivitySettings).not.toHaveBeenCalled();
  expect(service.saveLiveActivitySettings).not.toHaveBeenCalled();
});
