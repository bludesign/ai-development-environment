import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import {
  serverUrlSettingsService,
  type SaveServerUrlSettingsInput,
} from "@/services/server-urls/server-urls.service";

function requireControlPlane(context: GraphQLContext) {
  if (context.agentId)
    throw new Error("Agent credentials cannot manage server URL settings");
}
export const createServerUrlResolvers = () => ({
  Query: {
    serverUrlSettings: (
      _: unknown,
      { requestOrigin }: { requestOrigin?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return serverUrlSettingsService.settings({
        requestOrigin: requestOrigin ?? context.requestOrigin,
      });
    },
  },
  Mutation: {
    saveServerUrlSettings: (
      _: unknown,
      {
        input,
        requestOrigin,
      }: { input: SaveServerUrlSettingsInput; requestOrigin?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return serverUrlSettingsService.saveSettings(input, {
        requestOrigin: requestOrigin ?? context.requestOrigin,
      });
    },
  },
  Subscription: {
    serverUrlSettingsChanged: {
      subscribe: (_: unknown, __: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return serverUrlSettingsService.subscribeSettings();
      },
      resolve: (payload: { updatedAt: string }) => payload,
    },
  },
});
