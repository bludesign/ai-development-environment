import { ApolloServer } from "@apollo/server";
import {
  ApolloServerPluginLandingPageLocalDefault,
  ApolloServerPluginLandingPageProductionDefault,
} from "@apollo/server/plugin/landingPage/default";

import { createSchema } from "@/graphql/schema";
import { AgentControlService } from "@/services/agent-control";
import { PrismaService } from "@/services/prisma";
import type { GraphQLSchema } from "graphql";

export interface GraphQLContext {
  prismaService: PrismaService;
  agentControlService: AgentControlService;
  agentId: string | null;
  ipAddress: string | null;
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function normalizeHeaders(source: HeaderSource): Headers {
  if (source instanceof Headers) return source;
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

export function bearerCredential(headers: Headers): string | null {
  const authorization = headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

export function requestIpAddress(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

// Owns the single ApolloServer instance and the services injected into resolvers. The route
// handler initializes it lazily on the first GraphQL request and reuses it thereafter.
class GraphQLServerService {
  private server: ApolloServer<GraphQLContext> | null = null;
  private prismaService: PrismaService | null = null;
  private agentControlService: AgentControlService | null = null;
  private schema: GraphQLSchema | null = null;
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
    this.agentControlService = new AgentControlService();
    this.schema = createSchema(this.prismaService, this.agentControlService);

    // Introspection + the local Apollo sandbox are enabled outside production, or when
    // APOLLO_SANDBOX=true is set explicitly (e.g. to inspect the brew service).
    const showIntrospection =
      process.env.NODE_ENV !== "production" ||
      process.env.APOLLO_SANDBOX === "true";

    this.server = new ApolloServer<GraphQLContext>({
      schema: this.schema,
      introspection: showIntrospection,
      plugins: showIntrospection
        ? [ApolloServerPluginLandingPageLocalDefault({ footer: false })]
        : [ApolloServerPluginLandingPageProductionDefault({ footer: false })],
    });
  }

  async createContext(
    source: HeaderSource = new Headers(),
  ): Promise<GraphQLContext> {
    await this.initializeServer();

    if (!this.prismaService || !this.agentControlService) {
      throw new Error("GraphQL services not initialized");
    }

    const headers = normalizeHeaders(source);
    const agentId = await this.agentControlService.authenticate(
      bearerCredential(headers),
    );
    return {
      prismaService: this.prismaService,
      agentControlService: this.agentControlService,
      agentId,
      ipAddress: requestIpAddress(headers),
    };
  }

  async getSchema(): Promise<GraphQLSchema> {
    await this.initializeServer();
    if (!this.schema)
      throw new Error("GraphQL schema not properly initialized");
    return this.schema;
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
