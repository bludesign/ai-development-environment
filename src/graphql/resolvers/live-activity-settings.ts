import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import { agentEventBus } from "@/services/agent-control";
import {
  LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC,
  liveActivitySettings,
  saveLiveActivitySettings,
  type SaveLiveActivitySettingsInput,
} from "@/services/ios-status/live-activity-settings";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId)
    throw new Error("Agent credentials cannot manage Live Activity settings");
}

export function createLiveActivitySettingsResolvers() {
  return {
    LiveActivitySettings: {
      updatedAt: (settings: { updatedAt: Date }) =>
        settings.updatedAt.toISOString(),
    },
    Query: {
      liveActivitySettings: (
        _root: unknown,
        _args: unknown,
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return liveActivitySettings();
      },
    },
    Mutation: {
      saveLiveActivitySettings: (
        _root: unknown,
        { input }: { input: SaveLiveActivitySettingsInput },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return saveLiveActivitySettings(input);
      },
    },
    Subscription: {
      liveActivitySettingsChanged: {
        subscribe: (
          _root: unknown,
          _args: unknown,
          context: GraphQLContext,
        ) => {
          requireControlPlane(context);
          return agentEventBus.iterate(LIVE_ACTIVITY_SETTINGS_CHANGED_TOPIC);
        },
      },
    },
  };
}
