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
