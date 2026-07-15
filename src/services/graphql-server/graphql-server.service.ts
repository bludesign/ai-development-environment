import { ApolloServer } from "@apollo/server";
import {
  ApolloServerPluginLandingPageLocalDefault,
  ApolloServerPluginLandingPageProductionDefault,
} from "@apollo/server/plugin/landingPage/default";

import { createSchema } from "@/graphql/schema";
import { PrismaService } from "@/services/prisma";

export interface GraphQLContext {
  prismaService: PrismaService;
}

// Owns the single ApolloServer instance and the services injected into resolvers. The route
// handler initializes it lazily on the first GraphQL request and reuses it thereafter.
class GraphQLServerService {
  private server: ApolloServer<GraphQLContext> | null = null;
  private prismaService: PrismaService | null = null;
  private initPromise: Promise<void> | null = null;

  private async initializeServer(): Promise<void> {
    if (this.server !== null) return;

    if (!this.initPromise) {
      this.initPromise = this.buildServer().finally(() => {
        this.initPromise = null;
      });
    }

    return this.initPromise;
  }

  private async buildServer(): Promise<void> {
    this.prismaService = new PrismaService();
    const schema = createSchema(this.prismaService);

    // Introspection + the local Apollo sandbox are enabled outside production, or when
    // APOLLO_SANDBOX=true is set explicitly (e.g. to inspect the brew service).
    const showIntrospection =
      process.env.NODE_ENV !== "production" ||
      process.env.APOLLO_SANDBOX === "true";

    this.server = new ApolloServer<GraphQLContext>({
      schema,
      introspection: showIntrospection,
      plugins: showIntrospection
        ? [ApolloServerPluginLandingPageLocalDefault({ footer: false })]
        : [ApolloServerPluginLandingPageProductionDefault({ footer: false })],
    });
  }

  async createContext(): Promise<GraphQLContext> {
    await this.initializeServer();

    if (!this.prismaService) {
      throw new Error("PrismaService not initialized");
    }

    return { prismaService: this.prismaService };
  }

  async getServer(): Promise<ApolloServer<GraphQLContext>> {
    await this.initializeServer();

    if (!this.server) {
      throw new Error("GraphQL server not properly initialized");
    }

    return this.server;
  }
}

export const SharedGraphQLServerService = new GraphQLServerService();
