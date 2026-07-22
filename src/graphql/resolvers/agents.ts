import { GraphQLScalarType, Kind, type ValueNode } from "graphql";

import type { AgentControlService } from "@/services/agent-control";
import { effectiveBuildsDirectory } from "@/services/builds/build-directory";
import {
  AGENT_CHANGED_TOPIC,
  agentOnlineWindowMs,
  agentEventBus,
  agentEventsTopic,
  agentJobChangedTopic,
  agentJobLogTopic,
} from "@/services/agent-control";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

type JsonRecord = Record<string, unknown>;

function requireAgent(context: GraphQLContext): string {
  if (!context.agentId) throw new Error("Agent authentication is required");
  return context.agentId;
}

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

function requireOwnedAgent(context: GraphQLContext, agentId: string): void {
  if (context.agentId && context.agentId !== agentId) {
    throw new Error("An agent may only read its own resources");
  }
}

async function requireOwnedJob(
  context: GraphQLContext,
  agentControlService: AgentControlService,
  jobId: string,
) {
  const job = await agentControlService.getJob(jobId);
  if (job) requireOwnedAgent(context, job.agentId);
  return job;
}

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function serializeLiteral(node: ValueNode): unknown {
  switch (node.kind) {
    case Kind.NULL:
      return null;
    case Kind.STRING:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(node.value);
    case Kind.LIST:
      return node.values.map((value) => serializeLiteral(value));
    case Kind.OBJECT:
      return Object.fromEntries(
        node.fields.map((field) => {
          return [field.name.value, serializeLiteral(field.value)];
        }),
      );
    default:
      throw new Error("Unsupported JSON literal");
  }
}

const jsonScalar = new GraphQLScalarType({
  name: "JSON",
  description: "A JSON-serializable value.",
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (node) => serializeLiteral(node),
});

export const createAgentResolvers = (
  agentControlService: AgentControlService,
) => ({
  JSON: jsonScalar,
  Agent: {
    capabilities: (agent: { capabilitiesJson: string }) =>
      parseJson(agent.capabilitiesJson),
    connectionStatus: (agent: {
      lastSeenAt: Date | null;
      disconnectedAt: Date | null;
      heartbeatIntervalSeconds?: number | null;
    }) => {
      const recentlySeen =
        agent.lastSeenAt !== null &&
        Date.now() - agent.lastSeenAt.getTime() <= agentOnlineWindowMs(agent);
      return recentlySeen && agent.disconnectedAt === null
        ? "ONLINE"
        : "OFFLINE";
    },
    effectiveBuildsDirectory: (agent: {
      baseRepoDirectory: string | null;
      buildsDirectory: string | null;
    }) => effectiveBuildsDirectory(agent),
    lastSeenAt: (agent: { lastSeenAt: Date | null }) =>
      agent.lastSeenAt?.toISOString() ?? null,
    disconnectedAt: (agent: { disconnectedAt: Date | null }) =>
      agent.disconnectedAt?.toISOString() ?? null,
    createdAt: (agent: { createdAt: Date }) => agent.createdAt.toISOString(),
    updatedAt: (agent: { updatedAt: Date }) => agent.updatedAt.toISOString(),
  },
  AgentJob: {
    payload: (job: { payloadJson: string }) => parseJson(job.payloadJson),
    result: (job: { resultJson: string | null }) => parseJson(job.resultJson),
    createdAt: (job: { createdAt: Date }) => job.createdAt.toISOString(),
    startedAt: (job: { startedAt: Date | null }) =>
      job.startedAt?.toISOString() ?? null,
    finishedAt: (job: { finishedAt: Date | null }) =>
      job.finishedAt?.toISOString() ?? null,
    updatedAt: (job: { updatedAt: Date }) => job.updatedAt.toISOString(),
  },
  AgentJobLog: {
    createdAt: (log: { createdAt: Date }) => log.createdAt.toISOString(),
  },
  AgentEnrollmentToken: {
    expiresAt: (token: { expiresAt: Date }) => token.expiresAt.toISOString(),
  },
  Query: {
    agents: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      requireControlPlane(context);
      return agentControlService.listAgents();
    },
    agent: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireOwnedAgent(context, id);
      return agentControlService.getAgent(id);
    },
    agentSelf: (_root: unknown, _args: unknown, context: GraphQLContext) => {
      const agentId = requireAgent(context);
      return agentControlService.getAgent(agentId);
    },
    agentCadenceSettings: (
      _root: unknown,
      { agentId }: { agentId: string },
      context: GraphQLContext,
    ) => {
      requireOwnedAgent(context, agentId);
      return agentControlService.cadenceSettings(agentId);
    },
    agentJobs: (
      _root: unknown,
      { agentId, limit }: { agentId: string; limit?: number },
      context: GraphQLContext,
    ) => {
      requireOwnedAgent(context, agentId);
      return agentControlService.listJobs(
        agentId,
        limit,
        Boolean(context.agentId),
      );
    },
    agentJob: async (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => requireOwnedJob(context, agentControlService, id),
    agentJobLogs: async (
      _root: unknown,
      { jobId, afterSequence }: { jobId: string; afterSequence?: number },
      context: GraphQLContext,
    ) => {
      await requireOwnedJob(context, agentControlService, jobId);
      return agentControlService.listLogs(jobId, afterSequence);
    },
  },
  Mutation: {
    createAgentEnrollmentToken: (
      _root: unknown,
      { expiresInMinutes }: { expiresInMinutes?: number },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.createEnrollmentToken(expiresInMinutes);
    },
    enrollAgent: (
      _root: unknown,
      { input }: { input: JsonRecord },
      context: GraphQLContext,
    ) =>
      agentControlService.enroll({
        ...(input as {
          enrollmentToken: string;
          name: string;
          hostname: string;
          version: string;
          osVersion: string;
          architecture: string;
          cpuModel?: string | null;
          memoryTotalBytes?: number | null;
          memoryFreeBytes?: number | null;
          diskTotalBytes?: number | null;
          diskFreeBytes?: number | null;
          capabilities: string[];
          defaultBuildsDirectory?: string | null;
        }),
        ipAddress: context.ipAddress,
      }),
    heartbeatAgent: (
      _root: unknown,
      { input }: { input: JsonRecord },
      context: GraphQLContext,
    ) =>
      agentControlService.heartbeat(requireAgent(context), {
        ...(input as {
          version: string;
          osVersion: string;
          architecture: string;
          cpuModel?: string | null;
          memoryTotalBytes?: number | null;
          memoryFreeBytes?: number | null;
          diskTotalBytes?: number | null;
          diskFreeBytes?: number | null;
          capabilities: string[];
          defaultBuildsDirectory?: string | null;
        }),
        ipAddress: context.ipAddress,
      }),
    createAgentJob: (
      _root: unknown,
      { input }: { input: JsonRecord },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.createJob(input as never);
    },
    claimAgentJob: (
      _root: unknown,
      { jobId }: { jobId: string },
      context: GraphQLContext,
    ) => agentControlService.claimJob(requireAgent(context), jobId),
    claimSigningSecretTransfer: (
      _root: unknown,
      { transferId }: { transferId: string },
      context: GraphQLContext,
    ) =>
      agentControlService.claimSigningSecretTransfer(
        requireAgent(context),
        transferId,
      ),
    appendAgentJobLogs: (
      _root: unknown,
      { jobId, logs }: { jobId: string; logs: never[] },
      context: GraphQLContext,
    ) => agentControlService.appendLogs(requireAgent(context), jobId, logs),
    completeAgentJob: (
      _root: unknown,
      args: {
        jobId: string;
        status: string;
        result?: unknown;
        error?: string | null;
      },
      context: GraphQLContext,
    ) =>
      agentControlService.completeJob(
        requireAgent(context),
        args.jobId,
        args.status,
        args.result,
        args.error ?? null,
      ),
    cancelAgentJob: (
      _root: unknown,
      { jobId }: { jobId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.cancelJob(jobId);
    },
    requestAgentCodebaseReconcile: async (
      _root: unknown,
      { agentId }: { agentId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return (
        (await agentControlService.requestCodebaseReconcile([agentId])) === 1
      );
    },
    updateAgentBaseRepoDirectory: (
      _root: unknown,
      {
        agentId,
        baseRepoDirectory,
      }: { agentId: string; baseRepoDirectory?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.updateBaseRepoDirectory(
        agentId,
        baseRepoDirectory ?? null,
      );
    },
    updateAgentBuildsDirectory: (
      _root: unknown,
      {
        agentId,
        buildsDirectory,
      }: { agentId: string; buildsDirectory?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.updateBuildsDirectory(
        agentId,
        buildsDirectory ?? null,
      );
    },
    updateAgentDerivedDataSettings: (
      _root: unknown,
      {
        agentId,
        input,
      }: {
        agentId: string;
        input: { mode: string; path?: string | null };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.updateDerivedDataSettings(
        agentId,
        input.mode,
        input.path ?? null,
      );
    },
    updateAgentCadenceSettings: (
      _root: unknown,
      {
        agentId,
        input,
      }: {
        agentId: string;
        input: {
          codebaseScanIntervalSeconds: number;
          jobReconciliationIntervalSeconds: number;
          gitFetchIntervalSeconds: number;
          heartbeatIntervalSeconds: number;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.updateCadenceSettings(agentId, input);
    },
    deleteAgent: (
      _root: unknown,
      { agentId }: { agentId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return agentControlService.deleteAgent(agentId);
    },
  },
  Subscription: {
    agentEvents: {
      subscribe: (
        _root: unknown,
        { agentId }: { agentId: string },
        context: GraphQLContext,
      ) => {
        if (requireAgent(context) !== agentId) {
          throw new Error("An agent may only subscribe to its own events");
        }
        return agentEventBus.iterate(agentEventsTopic(agentId));
      },
    },
    agentChanged: {
      subscribe: (
        _root: unknown,
        { agentId }: { agentId?: string },
        context: GraphQLContext,
      ) => {
        if (agentId) requireOwnedAgent(context, agentId);
        else requireControlPlane(context);
        return agentEventBus.iterate<{ agentChanged: { id: string } }>(
          AGENT_CHANGED_TOPIC,
          agentId ? (event) => event.agentChanged.id === agentId : undefined,
        );
      },
    },
    agentJobChanged: {
      subscribe: async (
        _root: unknown,
        { jobId }: { jobId: string },
        context: GraphQLContext,
      ) => {
        await requireOwnedJob(context, agentControlService, jobId);
        return agentEventBus.iterate(agentJobChangedTopic(jobId));
      },
    },
    agentJobLogAdded: {
      subscribe: async (
        _root: unknown,
        { jobId }: { jobId: string },
        context: GraphQLContext,
      ) => {
        await requireOwnedJob(context, agentControlService, jobId);
        return agentEventBus.iterate(agentJobLogTopic(jobId));
      },
    },
  },
});
