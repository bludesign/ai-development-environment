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
import { createJiraResolvers } from "./resolvers/jira";
import { createGitHubResolvers } from "./resolvers/github";
import { GitHubService } from "@/services/github";
import { JiraService } from "@/services/jira";

// Pre-generated SDL strings (see scripts/prebuild-schema.ts) → DocumentNodes for the subgraph.
const typeDefs = schemaDefinitions.map((schema) => gql(schema));

// Builds the Apollo Federation subgraph schema. Resolver factories receive their services
// here and are merged into one resolver map.
export const createSchema = (
  prismaService: PrismaService,
  agentControlService: AgentControlService,
  jiraService: JiraService,
  gitHubService: GitHubService,
): GraphQLSchema => {
  const resolvers = mergeResolvers([
    createHealthResolvers(prismaService),
    createAgentResolvers(agentControlService),
    createJiraResolvers(jiraService),
    createGitHubResolvers(gitHubService),
  ]);

  return buildSubgraphSchema({
    typeDefs,
    resolvers: resolvers as GraphQLResolverMap<unknown>,
  });
};
