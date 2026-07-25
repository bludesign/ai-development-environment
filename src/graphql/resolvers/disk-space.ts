import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { DiskSpaceService } from "@/services/disk-space";
import type { SystemStatusService } from "@/services/system-status";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

export const createDiskSpaceResolvers = (
  diskSpace: DiskSpaceService,
  systemStatus: SystemStatusService,
) => ({
  Query: {
    diskSpaceSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return diskSpace.settings();
    },
    diskSpaceOverview: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return diskSpace.overview();
    },
    agentDiskSpace: (
      _root: unknown,
      { agentId }: { agentId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return diskSpace.agentView(agentId);
    },
    sidebarStatus: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return systemStatus.status();
    },
    agentDiskSpaceConfiguration: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => diskSpace.configuration(requireAgent(context)),
  },
  Mutation: {
    updateDiskSpaceSettings: (
      _root: unknown,
      { input }: { input: Parameters<DiskSpaceService["updateSettings"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return diskSpace.updateSettings(input);
    },
    setAgentDiskSpaceMonitoring: (
      _root: unknown,
      { agentId, enabled }: { agentId: string; enabled: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return diskSpace.setMonitoring(agentId, enabled);
    },
    setAgentDiskSpacePressureMode: (
      _root: unknown,
      { agentId, enabled }: { agentId: string; enabled: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return diskSpace.setManualPressureMode(agentId, enabled);
    },
    reportAgentDiskSpace: (
      _root: unknown,
      { input }: { input: unknown },
      context: GraphQLContext,
    ) => diskSpace.report(requireAgent(context), input).then(() => true),
  },
  Subscription: {
    diskSpaceChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return diskSpace.subscribe();
      },
      resolve: (payload: { diskSpaceChanged: string }) =>
        payload.diskSpaceChanged,
    },
    sidebarStatusChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return systemStatus.subscribe();
      },
      resolve: () => true,
    },
  },
});
