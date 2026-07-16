import {
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
  type CodebaseStatusReport,
} from "@ai-development-environment/agent-contract/codebases";

import type { CodebasesService } from "@/services/codebases";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

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

const iso = (value: Date | null) => value?.toISOString() ?? null;

export const createCodebaseResolvers = (service: CodebasesService) => ({
  CodebaseOverview: {
    repositories: (value: { repositories?: unknown[] } | unknown[]) =>
      Array.isArray(value) ? value : (value.repositories ?? []),
  },
  CodebaseRepository: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  CodebaseSettings: {
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  Codebase: {
    lastCheckedAt: (value: { lastCheckedAt: Date | null }) =>
      iso(value.lastCheckedAt),
    lastFetchedAt: (value: { lastFetchedAt: Date | null }) =>
      iso(value.lastFetchedAt),
    lastFetchAttemptAt: (value: { lastFetchAttemptAt: Date | null }) =>
      iso(value.lastFetchAttemptAt),
    remoteBranches: (value: { remoteBranchesJson: string }) => {
      try {
        const parsed: unknown = JSON.parse(value.remoteBranchesJson);
        return Array.isArray(parsed)
          ? parsed.filter((item): item is string => typeof item === "string")
          : [];
      } catch {
        return [];
      }
    },
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
    activeJob: (value: { jobs?: unknown[] }) => value.jobs?.[0] ?? null,
  },
  AgentCodebaseRegistration: {
    canonicalOrigin: (value: { repository: { canonicalOrigin: string } }) =>
      value.repository.canonicalOrigin,
    worktrees: (value: { worktrees?: unknown[] }) => value.worktrees ?? [],
    lastFetchedAt: (value: { lastFetchedAt: Date | null }) =>
      iso(value.lastFetchedAt),
    lastFetchAttemptAt: (value: { lastFetchAttemptAt: Date | null }) =>
      iso(value.lastFetchAttemptAt),
  },
  Query: {
    codebaseOverview: async (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.overview();
    },
    codebaseSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.settings();
    },
    agentCodebases: (_root: unknown, _args: unknown, context: GraphQLContext) =>
      service.agentCodebases(requireAgent(context)),
    agentCodebaseConfiguration: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => service.agentConfiguration(requireAgent(context)),
  },
  Mutation: {
    browseAgentDirectory: (
      _root: unknown,
      {
        input,
      }: {
        input: { agentId: string; path?: string | null; requestId: string };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.browse(input.agentId, input.path ?? null, input.requestId);
    },
    inspectAgentCodebase: (
      _root: unknown,
      {
        input,
      }: { input: { agentId: string; folder: string; requestId: string } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.inspect(input.agentId, input.folder, input.requestId);
    },
    confirmCodebase: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          inspectionJobId: string;
          name?: string | null;
          description?: string | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.confirm(input);
    },
    updateCodebaseRepository: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          id: string;
          name: string;
          description: string;
          jiraBranchRegex?: string | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateRepository(
        input.id,
        input.name,
        input.description,
        input.jiraBranchRegex,
      );
    },
    updateCodebaseSettings: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          refreshIntervalSeconds: number;
          fetchIntervalSeconds: number;
          defaultJiraBranchRegex: string;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.updateSettings(input);
    },
    removeCodebase: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.removeCodebase(id);
    },
    refreshCodebases: (
      _root: unknown,
      { input }: { input: { codebaseIds: string[]; requestId: string } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runOperation(
        CODEBASE_REFRESH_JOB_KIND,
        input.codebaseIds,
        input.requestId,
      );
    },
    fetchCodebases: (
      _root: unknown,
      { input }: { input: { codebaseIds: string[]; requestId: string } },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.runOperation(
        CODEBASE_FETCH_JOB_KIND,
        input.codebaseIds,
        input.requestId,
      );
    },
    reportCodebaseStatuses: (
      _root: unknown,
      { reports }: { reports: CodebaseStatusReport[] },
      context: GraphQLContext,
    ) => service.report(requireAgent(context), reports),
  },
  Subscription: {
    codebaseOverviewChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
    },
  },
});
