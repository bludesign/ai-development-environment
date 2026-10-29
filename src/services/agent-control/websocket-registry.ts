import { agentEventBus } from "./event-bus";

export const AGENT_WEBSOCKET_CHANGED_TOPIC = "agent.websocket.changed";

export type AgentWebSocketConnection = {
  agentId: string;
  status: "CONNECTED" | "DISCONNECTED";
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  disconnectedAt: string | null;
  changedAt: string | null;
};

type Connection = {
  lastVerifiedAt: string;
  subscriptions: Map<string, Set<symbol>>;
};

/** Live process-local presence; HTTP heartbeats never establish WebSocket presence. */
export class AgentWebSocketRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly agents = new Map<string, AgentWebSocketConnection>();

  constructor(
    private readonly publish: (value: AgentWebSocketConnection) => void,
  ) {}

  open(connectionId: string): void {
    this.connections.set(connectionId, {
      lastVerifiedAt: new Date().toISOString(),
      subscriptions: new Map(),
    });
  }

  snapshot(agentId: string): AgentWebSocketConnection {
    return {
      ...(this.agents.get(agentId) ?? {
        agentId,
        status: "DISCONNECTED",
        connectedAt: null,
        lastVerifiedAt: null,
        disconnectedAt: null,
        changedAt: null,
      }),
    };
  }

  subscribe(connectionId: string, agentId: string): () => void {
    const connection = this.connections.get(connectionId);
    if (!connection) return () => undefined;
    const token = Symbol();
    const subscriptions = connection.subscriptions.get(agentId) ?? new Set();
    connection.subscriptions.set(agentId, subscriptions);
    subscriptions.add(token);
    // The authenticated subscription request itself verifies this connection.
    connection.lastVerifiedAt = new Date().toISOString();
    this.update(agentId);
    return () => {
      if (!subscriptions.delete(token)) return;
      if (!subscriptions.size) connection.subscriptions.delete(agentId);
      this.update(agentId);
    };
  }

  verify(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.lastVerifiedAt = new Date().toISOString();
    for (const agentId of connection.subscriptions.keys()) this.update(agentId);
  }

  close(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    for (const agentId of connection.subscriptions.keys()) this.update(agentId);
    connection.subscriptions.clear();
  }

  private update(agentId: string): void {
    const previous = this.snapshot(agentId);
    const active = [...this.connections.values()].filter((connection) =>
      connection.subscriptions.has(agentId),
    );
    const now = new Date().toISOString();
    const status = active.length ? "CONNECTED" : "DISCONNECTED";
    const changed = previous.status !== status;
    const value: AgentWebSocketConnection = {
      agentId,
      status,
      connectedAt:
        changed && status === "CONNECTED" ? now : previous.connectedAt,
      lastVerifiedAt: active.length
        ? active
            .map((connection) => connection.lastVerifiedAt)
            .sort()
            .at(-1)!
        : previous.lastVerifiedAt,
      disconnectedAt:
        changed && status === "DISCONNECTED" ? now : previous.disconnectedAt,
      changedAt: changed ? now : previous.changedAt,
    };
    this.agents.set(agentId, value);
    this.publish({ ...value });
  }
}

const registryGlobal = globalThis as typeof globalThis & {
  agentWebSocketRegistry?: AgentWebSocketRegistry;
};

// Instrumentation and HTTP resolvers are separate Next.js bundles in one process.
export const agentWebSocketRegistry = (registryGlobal.agentWebSocketRegistry ??=
  new AgentWebSocketRegistry((value) =>
    agentEventBus.publish(AGENT_WEBSOCKET_CHANGED_TOPIC, {
      agentWebSocketConnectionChanged: value,
    }),
  ));
