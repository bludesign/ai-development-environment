import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ToolsService } from "@/services/tools";
import type { ExternalMcpServerInput } from "@/services/tools/types";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createToolsResolvers = (service: ToolsService) => ({
  Query: {
    externalMcpServers: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.externalServers();
    },
  },
  Mutation: {
    createExternalMcpServer: (
      _root: unknown,
      { input }: { input: ExternalMcpServerInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createExternalServer(input);
    },
    updateExternalMcpServer: (
      _root: unknown,
      { id, input }: { id: string; input: ExternalMcpServerInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateExternalServer(id, input);
    },
    deleteExternalMcpServer: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteExternalServer(id);
    },
  },
});
