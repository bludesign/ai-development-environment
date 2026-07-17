import {
  hashSkillFiles,
  parseSkillPackage,
  type SkillPackage,
} from "@ai-development-environment/agent-contract/skills";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { SkillsService } from "@/services/skills";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

function packageValue(input: {
  name: string;
  description: string;
  packageHash?: string | null;
  files: Array<{ path: string; contentsBase64: string; executable: boolean }>;
}): SkillPackage {
  return parseSkillPackage({
    ...input,
    packageHash: input.packageHash || hashSkillFiles(input.files),
  });
}

export const createSkillResolvers = (service: SkillsService) => ({
  CodebaseRepository: {
    skillGroups: (value: { id: string }) =>
      service.groupsForRepository(value.id),
  },
  Skill: {
    groups: (value: { groups?: Array<{ group: unknown }> }) =>
      value.groups?.map((membership) => membership.group) ?? [],
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  SkillFile: {
    contentsBase64: (value: { contents: Uint8Array }) =>
      Buffer.from(value.contents).toString("base64"),
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  SkillGroup: {
    skills: (value: { skills?: Array<{ skill: unknown }> }) =>
      value.skills?.map((membership) => membership.skill) ?? [],
    repositories: (value: { repositories?: Array<{ repository: unknown }> }) =>
      value.repositories?.map((assignment) => assignment.repository) ?? [],
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  SkillSettings: {
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  SkillToolObservation: {
    checkedAt: (value: { checkedAt: Date }) => value.checkedAt.toISOString(),
  },
  SkillInstallation: {
    consumers: (value: { consumersJson: string }) => {
      try {
        return JSON.parse(value.consumersJson) as string[];
      } catch {
        return [];
      }
    },
    lastSeenAt: (value: { lastSeenAt: Date }) => value.lastSeenAt.toISOString(),
  },
  SkillSyncItem: {
    candidatePackage: (value: { candidatePackageJson: string | null }) => {
      try {
        return value.candidatePackageJson
          ? (JSON.parse(value.candidatePackageJson) as unknown)
          : null;
      } catch {
        return null;
      }
    },
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
  },
  SkillSyncRun: {
    createdAt: (value: { createdAt: Date }) => value.createdAt.toISOString(),
    updatedAt: (value: { updatedAt: Date }) => value.updatedAt.toISOString(),
    finishedAt: (value: { finishedAt: Date | null }) => iso(value.finishedAt),
  },
  Query: {
    skillsOverview: (
      _root: unknown,
      { search }: { search?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.overview(search ?? "");
    },
    skill: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getSkill(id);
    },
    skillSyncRun: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.getRun(id);
    },
  },
  Mutation: {
    saveSkill: (
      _root: unknown,
      { input }: { input: Parameters<SkillsService["saveSkill"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSkill(input);
    },
    deleteSkill: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteSkill(id);
    },
    saveSkillGroup: (
      _root: unknown,
      { input }: { input: Parameters<SkillsService["saveGroup"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveGroup(input);
    },
    deleteSkillGroup: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.deleteGroup(id);
    },
    saveSkillSettings: (
      _root: unknown,
      { input }: { input: Parameters<SkillsService["saveSettings"]>[0] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(input);
    },
    prepareSkillSync: (
      _root: unknown,
      { kind, groupId }: { kind: "ALL" | "GROUP"; groupId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.prepareSync(kind, groupId ?? null);
    },
    skipPendingSkillSync: (
      _root: unknown,
      { runId }: { runId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.skipPending(runId);
    },
    resolveSkillSyncItem: (
      _root: unknown,
      {
        input,
      }: {
        input: {
          itemId: string;
          resolution: "DATABASE" | "TARGET" | "MANUAL" | "SKIP";
          groupId?: string | null;
          package?: Parameters<typeof packageValue>[0] | null;
        };
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.resolveItem({
        ...input,
        package: input.package ? packageValue(input.package) : null,
      });
    },
    applySkillSync: (
      _root: unknown,
      { runId }: { runId: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.applyRun(runId);
    },
  },
  Subscription: {
    skillsChanged: {
      subscribe: (_root: unknown, _args: unknown, context: GraphQLContext) => {
        requireControlPlane(context);
        return service.subscribe();
      },
      resolve: () => service.overview(),
    },
    skillSyncRunChanged: {
      subscribe: (
        _root: unknown,
        { runId }: { runId: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        return service.subscribeRun(runId);
      },
      resolve: (_value: unknown, { runId }: { runId: string }) =>
        service.getRun(runId),
    },
  },
});
