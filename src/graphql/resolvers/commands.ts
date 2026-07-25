import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import {
  COMMANDS_CHANGED_TOPIC,
  agentEventBus,
  commandRunChangedTopic,
  commandRunOutputTopic,
} from "@/services/agent-control";
import type {
  CommandDefinitionInput,
  CommandsService,
  StartCommandRunInput,
} from "@/services/commands";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId)
    throw new Error("Agent credentials cannot manage commands");
}

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

const iso = (value: Date | null | undefined) => value?.toISOString() ?? null;
const dates = {
  archivedAt: (value: { archivedAt?: Date | null }) => iso(value.archivedAt),
  createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
  updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
};

export const createCommandResolvers = (service: CommandsService) => ({
  CommandDefinition: dates,
  CommandRun: {
    snapshot: (value: { snapshotJson: string }) =>
      JSON.parse(value.snapshotJson) as unknown,
    queuedAt: (value: { queuedAt: Date }) => value.queuedAt.toISOString(),
    startedAt: (value: { startedAt?: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    nextRestartAt: (value: { nextRestartAt?: Date | null }) =>
      iso(value.nextRestartAt),
    ...dates,
  },
  CommandRunAttempt: {
    startedAt: (value: { startedAt?: Date | null }) => iso(value.startedAt),
    finishedAt: (value: { finishedAt?: Date | null }) => iso(value.finishedAt),
    ...dates,
  },
  CommandRunOutputChunk: {
    attemptNumber: (value: {
      attemptNumber?: number;
      attempt?: { attempt: number };
    }) => value.attemptNumber ?? value.attempt?.attempt ?? 1,
    createdAt: (value: { createdAt: Date | string }) =>
      typeof value.createdAt === "string"
        ? value.createdAt
        : value.createdAt.toISOString(),
  },
  Query: {
    commandDefinitions: (
      _root: unknown,
      { includeArchived }: { includeArchived?: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.listDefinitions(includeArchived);
    },
    commandDefinition: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getDefinition(id);
    },
    commandRuns: (
      _root: unknown,
      args: Parameters<CommandsService["listRuns"]>[0],
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.listRuns(args);
    },
    commandRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getRun(id);
    },
    commandRunOutput: (
      _root: unknown,
      args: {
        runId: string;
        afterAttempt?: number;
        afterSequence?: number;
        first?: number;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.listOutput(
        args.runId,
        args.afterAttempt,
        args.afterSequence,
        args.first,
      );
    },
    eligibleCommandsForAgent: (
      _root: unknown,
      { agentId }: { agentId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.eligibleForAgent(agentId);
    },
    eligibleCommandsForWorktree: (
      _root: unknown,
      { worktreeId }: { worktreeId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.eligibleForWorktree(worktreeId);
    },
  },
  Mutation: {
    createCommandDefinition: (
      _root: unknown,
      { input }: { input: CommandDefinitionInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.createDefinition(input);
    },
    updateCommandDefinition: (
      _root: unknown,
      { id, input }: { id: string; input: CommandDefinitionInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateDefinition(id, input);
    },
    archiveCommandDefinition: (
      _root: unknown,
      args: { id: string; archived: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.archiveDefinition(args.id, args.archived);
    },
    startCommandRun: (
      _root: unknown,
      { input }: { input: StartCommandRunInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.startRun(input);
    },
    terminateCommandRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.terminateRun(id);
    },
    rerunCommandRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.rerun(id);
    },
    archiveCommandRuns: (
      _root: unknown,
      args: { ids: string[]; archived: boolean },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.archiveRuns(args.ids, args.archived);
    },
    deleteCommandRuns: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteRuns(ids);
    },
    appendCommandRunOutput: (
      _root: unknown,
      args: {
        jobId: string;
        attemptId: string;
        chunks: Array<{
          sequence: number;
          stream: string;
          dataBase64: string;
          byteLength: number;
          createdAt: string;
        }>;
      },
      context: GraphQLContext,
    ) =>
      service.appendOutput(
        requireAgent(context),
        args.jobId,
        args.attemptId,
        args.chunks,
      ),
  },
  Subscription: {
    commandsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return agentEventBus.iterate(COMMANDS_CHANGED_TOPIC);
      },
    },
    commandRunChanged: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return agentEventBus.iterate(commandRunChangedTopic(runId));
      },
      resolve: (payload: { commandRunChanged: { id: string } }) =>
        service.getRun(payload.commandRunChanged.id),
    },
    commandRunOutputAdded: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return agentEventBus.iterate(commandRunOutputTopic(runId));
      },
    },
  },
});
