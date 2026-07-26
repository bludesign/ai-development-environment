import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ToolsService } from "@/services/tools";
import type {
  ExternalMcpServerInput,
  McpToolPresetInput,
} from "@/services/tools/types";

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
    mcpToolPresets: (
      _root: unknown,
      { kind }: { kind?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.mcpToolPresets(kind);
    },
    toolCallAudits: (
      _root: unknown,
      {
        first,
        toolName,
        resultStatus,
      }: {
        first?: number;
        toolName?: string | null;
        resultStatus?: string | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.toolCallAudits({ first, toolName, resultStatus });
    },
  },
  Mutation: {
    clearToolCallAudits: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.clearToolCallAudits();
    },
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
    createMcpToolPreset: (
      _root: unknown,
      { input }: { input: McpToolPresetInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createMcpToolPreset(input);
    },
    updateMcpToolPreset: (
      _root: unknown,
      { id, input }: { id: string; input: McpToolPresetInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateMcpToolPreset(id, input);
    },
    deleteMcpToolPreset: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteMcpToolPreset(id);
    },
  },
});
