import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { PollingService } from "@/services/polling";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot inspect polling operations");
  }
}

export const createPollingResolvers = (service: PollingService) => ({
  Query: {
    pollingOperations: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.list();
    },
  },
  Subscription: {
    pollingOperationChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
    },
  },
});
