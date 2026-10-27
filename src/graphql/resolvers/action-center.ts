import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ActionCenterService } from "@/services/action-center";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createActionCenterResolvers = (service: ActionCenterService) => ({
  Query: {
    actionCenterSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings();
    },
    actionCenter: (
      _root: unknown,
      args: Parameters<ActionCenterService["list"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.list(args);
    },
  },
  Mutation: {
    saveActionCenterSettings: (
      _root: unknown,
      { input }: { input: Parameters<ActionCenterService["saveSettings"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(input);
    },
    refreshActionCenter: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.refresh();
    },
    acknowledgeActionCenterItem: (
      _root: unknown,
      { input }: { input: Parameters<ActionCenterService["acknowledge"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.acknowledge(input);
    },
    dismissActionCenterItem: (
      _root: unknown,
      { input }: { input: Parameters<ActionCenterService["dismiss"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.dismiss(input);
    },
  },
  Subscription: {
    actionCenterChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
      resolve: () => true,
    },
  },
});
