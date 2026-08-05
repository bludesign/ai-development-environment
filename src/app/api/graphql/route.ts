import { startServerAndCreateNextHandler } from "@as-integrations/next";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest } from "next/server";

import {
  SharedGraphQLServerService,
  type GraphQLContext,
} from "@/services/graphql-server/graphql-server.service";
import { isAnonymousAgentEnrollment } from "@/services/graphql-server/graphql-auth";
import {
  crossOriginError,
  PrincipalResolutionError,
  principalErrorResponse,
} from "@/services/auth";

export const runtime = "nodejs";
export const maxDuration = 180;

let handler: ((request: NextRequest) => Promise<Response>) | null = null;
const requestContext = new AsyncLocalStorage<GraphQLContext>();

async function getHandler(): Promise<
  (request: NextRequest) => Promise<Response>
> {
  if (handler === null) {
    const server = await SharedGraphQLServerService.getServer();
    handler = startServerAndCreateNextHandler(server, {
      context: async (request) =>
        requestContext.getStore() ??
        (await SharedGraphQLServerService.createContext(request.headers)),
    });
  }

  return handler;
}

async function handleRequest(request: NextRequest): Promise<Response> {
  // Apollo's own CSRF prevention already demands a preflight-inducing request, so
  // this is belt and braces — but the dashboard reaches GraphQL on the session
  // cookie alone, and that deserves the same stated rule as every other route
  // that does.
  const crossOrigin = crossOriginError(request);
  if (crossOrigin) return crossOrigin;
  try {
    const context = await SharedGraphQLServerService.createContext(
      request.headers,
    );
    if (context.principal?.kind === "anonymous") {
      let query: unknown;
      if (request.method === "POST") {
        const body = await request
          .clone()
          .json()
          .catch(() => null);
        if (body && !Array.isArray(body) && typeof body === "object") {
          query = (body as { query?: unknown }).query;
        }
      }
      if (!isAnonymousAgentEnrollment(query)) {
        return principalErrorResponse(
          new PrincipalResolutionError(
            "Authentication is required for this GraphQL operation.",
          ),
        );
      }
    }
    const handlerFn = await getHandler();
    return await requestContext.run(context, () => handlerFn(request));
  } catch (error) {
    if (error instanceof PrincipalResolutionError) {
      return principalErrorResponse(error);
    }
    console.error("GraphQL request error:", error);
    return new Response(
      JSON.stringify({ errors: [{ message: "Internal server error" }] }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleRequest(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleRequest(request);
}
