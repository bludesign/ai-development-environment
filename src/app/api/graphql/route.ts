import { startServerAndCreateNextHandler } from "@as-integrations/next";
import { NextRequest } from "next/server";

import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

let handler: ((request: NextRequest) => Promise<Response>) | null = null;

async function getHandler(): Promise<
  (request: NextRequest) => Promise<Response>
> {
  if (handler === null) {
    const server = await SharedGraphQLServerService.getServer();
    handler = startServerAndCreateNextHandler(server, {
      context: () => SharedGraphQLServerService.createContext(),
    });
  }

  return handler;
}

async function handleRequest(request: NextRequest): Promise<Response> {
  try {
    const handlerFn = await getHandler();
    return await handlerFn(request);
  } catch (error) {
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
