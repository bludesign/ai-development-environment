import { useServer as createGraphQLWebSocketServer } from "graphql-ws/use/ws";
import { WebSocketServer } from "ws";

import {
  normalizeHeaders,
  SharedGraphQLServerService,
} from "@/services/graphql-server/graphql-server.service";

const globalForAgentWebSocket = globalThis as typeof globalThis & {
  agentWebSocketServer?: WebSocketServer;
  agentWebSocketStartPromise?: Promise<void>;
};

function authorizationFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as Record<string, unknown>;
  const authorization = value.authorization ?? value.Authorization;
  return typeof authorization === "string" ? authorization : null;
}

export function parseAgentWebSocketPort(value: string | undefined): number {
  const port = Number(value?.trim() || "3091");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid AGENT_WS_PORT: ${value}`);
  }
  return port;
}

export async function startAgentWebSocketServer(): Promise<void> {
  if (globalForAgentWebSocket.agentWebSocketServer) return;
  if (globalForAgentWebSocket.agentWebSocketStartPromise) {
    return globalForAgentWebSocket.agentWebSocketStartPromise;
  }

  const port = parseAgentWebSocketPort(process.env.AGENT_WS_PORT);
  const host =
    process.env.AGENT_WS_HOSTNAME ?? process.env.HOSTNAME ?? "127.0.0.1";
  const startPromise = (async () => {
    const schema = await SharedGraphQLServerService.getSchema();
    const webSocketServer = new WebSocketServer({
      host,
      port,
      path: "/graphql",
    });
    const disposable = createGraphQLWebSocketServer(
      {
        schema,
        context: async (context) => {
          const headers = normalizeHeaders(context.extra.request.headers);
          const ipAddress = context.extra.request.socket.remoteAddress;
          if (!headers.has("x-forwarded-for") && ipAddress) {
            headers.set("x-forwarded-for", ipAddress);
          }
          const authorization = authorizationFromParams(
            context.connectionParams,
          );
          if (authorization) headers.set("authorization", authorization);
          return SharedGraphQLServerService.createContext(headers);
        },
      },
      webSocketServer,
    );

    try {
      await new Promise<void>((resolve, reject) => {
        webSocketServer.once("listening", resolve);
        webSocketServer.once("error", reject);
      });
    } catch (error) {
      await disposable.dispose();
      throw error;
    }

    globalForAgentWebSocket.agentWebSocketServer = webSocketServer;
    webSocketServer.on("error", (error) => {
      console.error("Agent GraphQL WebSocket server error:", error);
    });
    console.log(
      `Agent GraphQL WebSocket listening on ws://${host}:${port}/graphql`,
    );
  })();
  globalForAgentWebSocket.agentWebSocketStartPromise = startPromise;
  try {
    await startPromise;
  } finally {
    globalForAgentWebSocket.agentWebSocketStartPromise = undefined;
  }
}
