import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import {
  BUILDS_CHANGED_TOPIC,
  agentEventBus,
  buildLogTopic,
  buildTopic,
} from "@/services/agent-control";
import type {
  BuildsService,
  SaveBuildConfigurationInput,
  SaveBuildScriptInput,
} from "@/services/builds";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId)
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
}

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;
const json = (value: string, fallback: unknown) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const createBuildResolvers = (service: BuildsService) => ({
  CodebaseProject: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  BuildConfiguration: {
    advancedSettings: (value: { advancedSettingsJson: string }) =>
      json(value.advancedSettingsJson, {}),
    observation: (value: { source?: { observations?: unknown[] } }) =>
      value.source?.observations?.[0] ?? null,
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  BuildSourceObservation: {
    schemes: (value: { schemesJson: string }) => json(value.schemesJson, []),
    configurations: (value: { configurationsJson: string }) =>
      json(value.configurationsJson, []),
    testPlans: (value: { testPlansJson: string }) =>
      json(value.testPlansJson, []),
    lastParseAttemptAt: (value: { lastParseAttemptAt: Date }) =>
      value.lastParseAttemptAt.toISOString(),
    lastParsedAt: (value: { lastParsedAt: Date | null }) =>
      iso(value.lastParsedAt),
  },
  BuildScript: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  BuildArtifact: {
    metadata: (value: { metadataJson: string }) => json(value.metadataJson, {}),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  },
  BuildDeployment: {
    destination: (value: { destinationJson: string }) =>
      json(value.destinationJson, {}),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    startedAt: (value: { startedAt: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  BuildExport: {
    settings: (value: { settingsSnapshotJson: string }) =>
      json(value.settingsSnapshotJson, {}),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    startedAt: (value: { startedAt: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  Build: {
    destination: (value: { destinationJson: string }) =>
      json(value.destinationJson, {}),
    snapshot: (value: { snapshotJson: string }) => json(value.snapshotJson, {}),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    startedAt: (value: { startedAt: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
    durationMs: (value: { startedAt: Date | null; finishedAt: Date | null }) =>
      value.startedAt && value.finishedAt
        ? Math.max(0, value.finishedAt.getTime() - value.startedAt.getTime())
        : null,
  },
  BuildLogEvent: {
    createdAt: (value: { createdAt: Date | string }) =>
      value.createdAt instanceof Date
        ? value.createdAt.toISOString()
        : value.createdAt,
  },
  Query: {
    iosAppProject: (
      _root: unknown,
      { codebaseId }: { codebaseId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.project(codebaseId);
    },
    buildScripts: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.scripts();
    },
    builds: (_root: unknown, args: never, context: GraphQLContext) => {
      requireControlPlane(context);
      return service.builds(args);
    },
    build: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getBuild(id);
    },
    buildLogs: (
      _root: unknown,
      args: { buildId: string; afterSequence?: number; first?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.logs(args.buildId, args.afterSequence, args.first);
    },
  },
  Mutation: {
    createIosAppProject: (
      _root: unknown,
      { codebaseId }: { codebaseId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createProject(codebaseId);
    },
    saveBuildConfiguration: (
      _root: unknown,
      { input }: { input: SaveBuildConfigurationInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveConfiguration(input);
    },
    deleteBuildConfiguration: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteConfiguration(id);
    },
    discoverBuildSources: (
      _root: unknown,
      args: { worktreeId: string; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.discoverSources(args.worktreeId, args.requestId);
    },
    inspectBuildSource: (
      _root: unknown,
      { input }: { input: never },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.inspectSource(input);
    },
    reparseBuildConfiguration: (
      _root: unknown,
      args: { configurationId: string; worktreeId: string; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.reparse(
        args.configurationId,
        args.worktreeId,
        args.requestId,
      );
    },
    inspectBuildDestinations: (
      _root: unknown,
      { input }: { input: never },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.destinations(input);
    },
    inspectBuildRunDestinations: (
      _root: unknown,
      args: { buildId: string; requestId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.destinationsForBuild(args.buildId, args.requestId);
    },
    saveBuildScript: (
      _root: unknown,
      { input }: { input: SaveBuildScriptInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveScript(input);
    },
    deleteBuildScript: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteScript(id);
    },
    setCodebaseBuildScripts: (
      _root: unknown,
      args: { codebaseId: string; scriptIds: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.setAllowedScripts(args.codebaseId, args.scriptIds);
    },
    startBuild: (
      _root: unknown,
      { input }: { input: never },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.startBuild(input);
    },
    cancelBuild: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.cancelBuild(id);
    },
    deleteBuilds: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteBuilds(ids);
    },
    runBuild: (
      _root: unknown,
      { input }: { input: never },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runBuild(input);
    },
    exportBuildArchive: (
      _root: unknown,
      { input }: { input: never },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.exportArchive(input);
    },
    reportBuildProgress: (
      _root: unknown,
      { input }: { input: never },
      context: GraphQLContext,
    ) => service.reportProgress(requireAgent(context), input),
    appendBuildLogEvents: (
      _root: unknown,
      { buildId, events }: { buildId: string; events: never[] },
      context: GraphQLContext,
    ) => service.appendLogs(requireAgent(context), buildId, events),
  },
  Subscription: {
    buildsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return agentEventBus.iterate(BUILDS_CHANGED_TOPIC);
      },
    },
    buildChanged: {
      subscribe: (
        _root: unknown,
        { id }: { id: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return agentEventBus.iterate(buildTopic(id));
      },
    },
    buildLogAdded: {
      subscribe: (
        _root: unknown,
        { buildId }: { buildId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return agentEventBus.iterate(buildLogTopic(buildId));
      },
    },
  },
});
