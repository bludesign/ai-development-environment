// @vitest-environment node
import { createServer } from "node:net";
import { createRequire } from "node:module";
import WebSocket, { type WebSocketServer } from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";

// Exercise the adapter's real ping/pong timeout without a 24-second test wait.
vi.mock("graphql-ws/use/ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("graphql-ws/use/ws")>();
  return {
    useServer: (...args: Parameters<typeof actual.useServer>) =>
      actual.useServer(args[0], args[1], 100),
  };
});

import { startAgentWebSocketServer } from "./instrumentation-node";
import { createAgentResolvers } from "@/graphql/resolvers/agents";
import type { AgentControlService } from "@/services/agent-control";
import { agentWebSocketRegistry } from "@/services/agent-control/websocket-registry";
import {
  SharedGraphQLServerService,
  type GraphQLContext,
} from "@/services/graphql-server/graphql-server.service";

const globals = globalThis as typeof globalThis & {
  agentWebSocketServer?: WebSocketServer;
  agentWebSocketStartPromise?: Promise<void>;
};
// The external graphql-ws adapter must share the same GraphQL module instance.
const { buildSchema } = createRequire(import.meta.url)(
  "graphql",
) as typeof import("graphql");

afterEach(async () => {
  const server = globals.agentWebSocketServer;
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  delete globals.agentWebSocketServer;
  delete globals.agentWebSocketStartPromise;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function connect(agentId: string, autoPong = true) {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  vi.stubEnv("AGENT_WS_HOSTNAME", "127.0.0.1");
  vi.stubEnv("AGENT_WS_PORT", String(address.port));
  const schema = buildSchema(`
    type Query { health: Boolean! }
    type Event { type: String! }
    type Subscription { agentEvents(agentId: ID!): Event! }
  `);
  schema.getSubscriptionType()!.getFields().agentEvents!.subscribe =
    createAgentResolvers(
      {} as AgentControlService,
    ).Subscription.agentEvents.subscribe;
  vi.spyOn(SharedGraphQLServerService, "getSchema").mockResolvedValue(schema);
  vi.spyOn(SharedGraphQLServerService, "createContext").mockResolvedValue({
    agentId,
    principal: { kind: "agent", agentId },
  } as GraphQLContext);
  await startAgentWebSocketServer();
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/graphql`,
    "graphql-transport-ws",
    { autoPong },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const acknowledged = new Promise<void>((resolve) =>
    socket.once("message", () => resolve()),
  );
  socket.send(JSON.stringify({ type: "connection_init" }));
  await acknowledged;
  return socket;
}

function subscribe(socket: WebSocket, agentId: string) {
  socket.send(
    JSON.stringify({
      id: "events",
      type: "subscribe",
      payload: {
        query:
          "subscription($agentId:ID!){agentEvents(agentId:$agentId){type}}",
        variables: { agentId },
      },
    }),
  );
}

describe("live agent notification sockets", () => {
  test("transport alone is not present; completing a subscription clears presence", async () => {
    const socket = await connect("socket-agent");
    expect(agentWebSocketRegistry.snapshot("socket-agent").status).toBe(
      "DISCONNECTED",
    );
    subscribe(socket, "socket-agent");
    await vi.waitFor(
      () =>
        expect(agentWebSocketRegistry.snapshot("socket-agent").status).toBe(
          "CONNECTED",
        ),
      { interval: 10 },
    );
    socket.send(JSON.stringify({ id: "events", type: "complete" }));
    await vi.waitFor(
      () =>
        expect(agentWebSocketRegistry.snapshot("socket-agent").status).toBe(
          "DISCONNECTED",
        ),
      { interval: 10 },
    );
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  test("a missed pong terminates the socket and clears agent presence", async () => {
    const socket = await connect("silent-agent", false);
    subscribe(socket, "silent-agent");
    await vi.waitFor(
      () =>
        expect(agentWebSocketRegistry.snapshot("silent-agent").status).toBe(
          "CONNECTED",
        ),
      { interval: 10 },
    );
    await vi.waitFor(
      () =>
        expect(agentWebSocketRegistry.snapshot("silent-agent").status).toBe(
          "DISCONNECTED",
        ),
      { interval: 10 },
    );
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  test("rejected subscriptions never establish agent presence", async () => {
    const socket = await connect("authorized-agent");
    const error = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(String(data))),
    );
    subscribe(socket, "other-agent");
    expect(JSON.parse(await error).payload.errors[0].message).toContain(
      "only subscribe to its own events",
    );
    expect(agentWebSocketRegistry.snapshot("other-agent").status).toBe(
      "DISCONNECTED",
    );
    expect(agentWebSocketRegistry.snapshot("authorized-agent").status).toBe(
      "DISCONNECTED",
    );
  });
});
