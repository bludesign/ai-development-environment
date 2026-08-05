import { useServer as createGraphQLWebSocketServer } from "graphql-ws/use/ws";
import { WebSocketServer } from "ws";
import { GraphQLError } from "graphql";

import { isTrustedWebSocketOrigin, resolveAppOrigins } from "@/lib/app-origins";
import {
  type GraphQLContext,
  normalizeHeaders,
  SharedGraphQLServerService,
} from "@/services/graphql-server/graphql-server.service";
import { isAnonymousAgentEnrollment } from "@/services/graphql-server/graphql-auth";

const globalForAgentWebSocket = globalThis as typeof globalThis & {
  agentWebSocketServer?: WebSocketServer;
  agentWebSocketStartPromise?: Promise<void>;
};
const operationContexts = new WeakMap<object, GraphQLContext>();

function authorizationFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as Record<string, unknown>;
  const authorization = value.authorization ?? value.Authorization;
  return typeof authorization === "string" ? authorization : null;
}

function apiKeyFromParams(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as Record<string, unknown>;
  const apiKey = value["x-api-key"] ?? value["X-API-Key"];
  return typeof apiKey === "string" ? apiKey : null;
}

export function mergeWebSocketCredential(
  headers: Headers,
  name: "authorization" | "x-api-key",
  value: string | null,
): void {
  if (!value) return;
  const existing = headers.get(name);
  if (existing && existing !== value) {
    throw new Error(`Conflicting ${name} credentials were supplied.`);
  }
  headers.set(name, value);
}

function connectionHeaders(context: {
  extra: { request: { headers: unknown; socket: { remoteAddress?: string } } };
  connectionParams?: Readonly<Record<string, unknown>>;
}): Headers {
  const headers = normalizeHeaders(
    context.extra.request.headers as Record<
      string,
      string | string[] | undefined
    >,
  );
  const ipAddress = context.extra.request.socket.remoteAddress;
  if (!headers.has("x-forwarded-for") && ipAddress) {
    headers.set("x-forwarded-for", ipAddress);
  }
  const authorization = authorizationFromParams(context.connectionParams);
  mergeWebSocketCredential(headers, "authorization", authorization);
  const apiKey = apiKeyFromParams(context.connectionParams);
  mergeWebSocketCredential(headers, "x-api-key", apiKey);
  return headers;
}

/**
 * Errors to answer an operation with, or `null` to let it run.
 *
 * The socket carries an anonymous principal until a credential resolves, and the
 * one thing an unauthenticated caller legitimately needs is enrolling itself —
 * the agent has no credential yet at that point. Everything else needs one.
 *
 * `principal` is optional on the context type, so an absent one is treated as
 * anonymous rather than waved through: a context that never resolved a principal
 * has proven nothing about its caller.
 */
export function deniedWebSocketOperation(
  principal: GraphQLContext["principal"],
  query: string | undefined,
): GraphQLError[] | null {
  if (principal && principal.kind !== "anonymous") return null;
  if (isAnonymousAgentEnrollment(query)) return null;
  return [
    new GraphQLError("Authentication is required for this GraphQL operation."),
  ];
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
    const origins = resolveAppOrigins();
    const webSocketServer = new WebSocketServer({
      host,
      port,
      path: "/graphql",
      // Rejected at the handshake, before graphql-ws sees the connection, so a
      // cross-site page never gets far enough to send an operation on a socket
      // carrying the visitor's cookies.
      verifyClient: ({ origin, req }, done) => {
        if (isTrustedWebSocketOrigin(origins, origin, req.headers.host)) {
          done(true);
          return;
        }
        console.warn(
          `Agent GraphQL WebSocket rejected a handshake from origin ${origin}.`,
        );
        done(false, 403, "Forbidden origin");
      },
    });
    const disposable = createGraphQLWebSocketServer(
      {
        schema,
        onSubscribe: async (context, _id, payload) => {
          try {
            const graphQLContext =
              await SharedGraphQLServerService.createContext(
                connectionHeaders(context),
              );
            operationContexts.set(context, graphQLContext);
            const denied = deniedWebSocketOperation(
              graphQLContext.principal,
              payload.query,
            );
            if (denied) return denied;
          } catch {
            return [new GraphQLError("The supplied credential is invalid.")];
          }
        },
        context: async (context) => {
          return (
            operationContexts.get(context) ??
            SharedGraphQLServerService.createContext(connectionHeaders(context))
          );
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
