import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { AppsService } from "@/services/apps";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createAppResolvers = (service: AppsService) => ({
  App: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  Query: {
    apps: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.list();
    },
    app: (_root: unknown, { id }: { id: string }, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.get(id);
    },
  },
  Mutation: {
    createApp: (
      _root: unknown,
      { input }: { input: Parameters<AppsService["create"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.create(input);
    },
    updateApp: (
      _root: unknown,
      { input }: { input: Parameters<AppsService["update"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.update(input);
    },
    deleteApp: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.delete(id);
    },
  },
  Subscription: {
    appsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
    },
  },
});
