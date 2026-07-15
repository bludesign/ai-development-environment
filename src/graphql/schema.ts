import { buildSubgraphSchema } from "@apollo/subgraph";
import type { GraphQLResolverMap } from "@apollo/subgraph/dist/schema-helper";
import { mergeResolvers } from "@graphql-tools/merge";
import type { GraphQLSchema } from "graphql";
import { gql } from "graphql-tag";

import { schemaDefinitions } from "@/generated/schema-definitions";
import { PrismaService } from "@/services/prisma";

import { createHealthResolvers } from "./resolvers/health";

// Pre-generated SDL strings (see scripts/prebuild-schema.ts) → DocumentNodes for the subgraph.
const typeDefs = schemaDefinitions.map((schema) => gql(schema));

// Builds the Apollo Federation subgraph schema. Resolver factories receive their services
// here and are merged into one resolver map.
export const createSchema = (prismaService: PrismaService): GraphQLSchema => {
  const resolvers = mergeResolvers([createHealthResolvers(prismaService)]);

  return buildSubgraphSchema({
    typeDefs,
    resolvers: resolvers as GraphQLResolverMap<unknown>,
  });
};
