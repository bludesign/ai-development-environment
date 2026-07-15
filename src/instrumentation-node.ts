import type { IncomingHttpHeaders } from "node:http";

import { useServer as createGraphQLWebSocketServer } from "graphql-ws/use/ws";
import { WebSocketServer } from "ws";

import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

const globalForAgentWebSocket = globalThis as typeof globalThis & {
  agentWebSocketServer?: WebSocketServer;
};

function toHeaders(incoming: IncomingHttpHeaders, ipAddress?: string): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) headers.set(name, value.join(", "));
    else if (value !== undefined) headers.set(name, value);
  }
  if (!headers.has("x-forwarded-for") && ipAddress) {
    headers.set("x-forwarded-for", ipAddress);
  }
  return headers;
}

function authorizationFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as Record<string, unknown>;
  const authorization = value.authorization ?? value.Authorization;
  return typeof authorization === "string" ? authorization : null;
}

export async function startAgentWebSocketServer(): Promise<void> {
  if (globalForAgentWebSocket.agentWebSocketServer) return;

  const port = Number(process.env.AGENT_WS_PORT ?? "3091");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid AGENT_WS_PORT: ${process.env.AGENT_WS_PORT}`);
  }
  const host =
    process.env.AGENT_WS_HOSTNAME ?? process.env.HOSTNAME ?? "127.0.0.1";
  const schema = await SharedGraphQLServerService.getSchema();
  const webSocketServer = new WebSocketServer({ host, port, path: "/graphql" });
  globalForAgentWebSocket.agentWebSocketServer = webSocketServer;

  createGraphQLWebSocketServer(
    {
      schema,
      context: async (context) => {
        const headers = toHeaders(
          context.extra.request.headers,
          context.extra.request.socket.remoteAddress,
        );
        const authorization = authorizationFromParams(context.connectionParams);
        if (authorization) headers.set("authorization", authorization);
        return SharedGraphQLServerService.createContext(headers);
      },
      onDisconnect: async (context) => {
        const authorization = authorizationFromParams(context.connectionParams);
        if (!authorization?.startsWith("Bearer ")) return;
        const serviceContext = await SharedGraphQLServerService.createContext(
          new Headers({ authorization }),
        );
        if (serviceContext.agentId) {
          await serviceContext.agentControlService.markDisconnected(
            serviceContext.agentId,
          );
        }
      },
    },
    webSocketServer,
  );

  webSocketServer.on("listening", () => {
    console.log(
      `Agent GraphQL WebSocket listening on ws://${host}:${port}/graphql`,
    );
  });
  webSocketServer.on("error", (error) => {
    console.error("Agent GraphQL WebSocket server error:", error);
  });
}
