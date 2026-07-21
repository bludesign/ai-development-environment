import { buildSubgraphSchema } from "@apollo/subgraph";
import type { GraphQLResolverMap } from "@apollo/subgraph/dist/schema-helper";
import { mergeResolvers } from "@graphql-tools/merge";
import type { GraphQLSchema } from "graphql";
import { gql } from "graphql-tag";

import { schemaDefinitions } from "@/generated/schema-definitions";
import { PrismaService } from "@/services/prisma";
import { AgentControlService } from "@/services/agent-control";

import { createAgentResolvers } from "./resolvers/agents";
import { createHealthResolvers } from "./resolvers/health";
import { createCcusageResolvers } from "./resolvers/ccusage";
import { createBuildDataResolvers } from "./resolvers/build-data";
import { createJiraResolvers } from "./resolvers/jira";
import { createGitHubResolvers } from "./resolvers/github";
import { createCacheServerResolvers } from "./resolvers/cache-server";
import { GitHubService } from "@/services/github";
import type { CacheServerService } from "@/services/cache-server";
import { JiraService } from "@/services/jira";
import { CcusageService } from "@/services/ccusage";
import { BuildDataService } from "@/services/build-data";
import { CodebasesService } from "@/services/codebases";
import { createCodebaseResolvers } from "./resolvers/codebases";
import { createToolsResolvers } from "./resolvers/tools";
import type { ToolsService } from "@/services/tools";
import type { WorktreesService } from "@/services/worktrees";
import { createWorktreeResolvers } from "./resolvers/worktrees";
import { createSkillResolvers } from "./resolvers/skills";
import type { SkillsService } from "@/services/skills";
import type { BuildsService } from "@/services/builds";
import { createBuildResolvers } from "./resolvers/builds";
import { createIosDeviceResolvers } from "./resolvers/devices";
import type { IosDevicesService } from "@/services/ios-devices";
import type { TelemetryService } from "@/services/telemetry";
import { createTelemetryResolvers } from "./resolvers/telemetry";
import { createSigningAssetsResolvers } from "./resolvers/signing-assets";
import type { SigningAssetsService } from "@/services/signing-assets";
import { createPushNotificationsResolvers } from "./resolvers/push-notifications";
import type { PushNotificationsService } from "@/services/push-notifications";

// Pre-generated SDL strings (see scripts/prebuild-schema.ts) → DocumentNodes for the subgraph.
const typeDefs = schemaDefinitions.map((schema) => gql(schema));

// Builds the Apollo Federation subgraph schema. Resolver factories receive their services
// here and are merged into one resolver map.
export const createSchema = (
  prismaService: PrismaService,
  agentControlService: AgentControlService,
  jiraService: JiraService,
  gitHubService: GitHubService,
  ccusageService: CcusageService,
  codebasesService: CodebasesService,
  toolsService: ToolsService,
  worktreesService: WorktreesService,
  buildDataService: BuildDataService,
  skillsService: SkillsService,
  buildsService: BuildsService,
  iosDevicesService: IosDevicesService,
  telemetryService: TelemetryService,
  signingAssetsService: SigningAssetsService,
  pushNotificationsService: PushNotificationsService,
  cacheServerService: CacheServerService,
): GraphQLSchema => {
  const resolvers = mergeResolvers([
    createHealthResolvers(prismaService),
    createAgentResolvers(agentControlService),
    createJiraResolvers(jiraService),
    createGitHubResolvers(gitHubService, worktreesService),
    createCcusageResolvers(ccusageService),
    createBuildDataResolvers(buildDataService),
    createCodebaseResolvers(codebasesService),
    createToolsResolvers(toolsService),
    createWorktreeResolvers(worktreesService),
    createSkillResolvers(skillsService),
    createBuildResolvers(buildsService),
    createIosDeviceResolvers(iosDevicesService),
    createTelemetryResolvers(telemetryService),
    createSigningAssetsResolvers(signingAssetsService),
    createPushNotificationsResolvers(pushNotificationsService),
    createCacheServerResolvers(cacheServerService),
  ]);

  return buildSubgraphSchema({
    typeDefs,
    resolvers: resolvers as GraphQLResolverMap<unknown>,
  });
};
