"use client";

import { useEffect, useState } from "react";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import {
  getBrowserWebSocketSnapshot,
  subscribeBrowserWebSocketStatus,
  type WebSocketSnapshot,
} from "@/lib/websocket-status";

export const WEBSOCKET_CONNECTION_FIELDS =
  "agentId status connectedAt lastVerifiedAt disconnectedAt changedAt";
type AgentConnection = WebSocketSnapshot & { agentId: string };
type Observation = { snapshot: AgentConnection; receivedAt: number };

export function useAgentWebSocketConnections(agentIds: string[]) {
  const idsKey = JSON.stringify([...new Set(agentIds)].sort());
  const [observations, setObservations] = useState(
    new Map<string, Observation>(),
  );

  useEffect(() => {
    const ids = JSON.parse(idsKey) as string[];
    if (!ids.length) return;
    const wanted = new Set(ids);
    const revisions = new Map<string, number>();
    const receivedAt = new Map<string, number>();
    let stopped = false;
    let controller: AbortController | null = null;
    let subscriptionFailed = false;
    const accept = (values: AgentConnection[]) => {
      if (stopped) return;
      for (const value of values) {
        if (wanted.has(value.agentId))
          receivedAt.set(value.agentId, Date.now());
      }
      setObservations((current) => {
        const next = new Map(current);
        for (const value of values) {
          if (wanted.has(value.agentId))
            next.set(value.agentId, {
              snapshot: value,
              receivedAt: Date.now(),
            });
        }
        return next;
      });
    };
    const refresh = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const before = new Map(revisions);
      try {
        const data = await controlPlaneRequest<{
          agent?: { webSocketConnection: AgentConnection } | null;
          agents?: Array<{ webSocketConnection: AgentConnection }>;
        }>(
          ids.length === 1
            ? `query AgentWebSocketStatus($id: ID!) { agent(id: $id) { webSocketConnection { ${WEBSOCKET_CONNECTION_FIELDS} } } }`
            : `query AgentWebSocketStatuses { agents { webSocketConnection { ${WEBSOCKET_CONNECTION_FIELDS} } } }`,
          ids.length === 1 ? { id: ids[0] } : undefined,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        const values = data.agent
          ? [data.agent.webSocketConnection]
          : (data.agents ?? []).map((agent) => agent.webSocketConnection);
        accept(
          values.filter(
            (value) =>
              value &&
              (before.get(value.agentId) ?? 0) ===
                (revisions.get(value.agentId) ?? 0),
          ),
        );
      } catch {
        // The freshness deadline below prevents a failed read retaining green status.
      }
    };
    const initial = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      agentWebSocketConnectionChanged: AgentConnection;
    }>(
      {
        query: `subscription AgentWebSocketConnectionChanged($agentId: ID) {
          agentWebSocketConnectionChanged(agentId: $agentId) { ${WEBSOCKET_CONNECTION_FIELDS} }
        }`,
        variables: ids.length === 1 ? { agentId: ids[0] } : {},
      },
      {
        next: (result) => {
          const value = result.data?.agentWebSocketConnectionChanged;
          if (!value || !wanted.has(value.agentId)) return;
          subscriptionFailed = false;
          revisions.set(value.agentId, (revisions.get(value.agentId) ?? 0) + 1);
          accept([value]);
        },
        error: () => {
          subscriptionFailed = true;
          void refresh();
        },
        complete: () => {
          subscriptionFailed = true;
          void refresh();
        },
      },
    );
    const recovery = onControlPlaneRecovery(() => void refresh());
    const browserChanged = subscribeBrowserWebSocketStatus(() => {
      if (getBrowserWebSocketSnapshot().status !== "CONNECTED") void refresh();
    });
    const fallback = window.setInterval(() => {
      if (
        subscriptionFailed ||
        getBrowserWebSocketSnapshot().status !== "CONNECTED" ||
        ids.some((id) => Date.now() - (receivedAt.get(id) ?? 0) >= 20_000)
      )
        void refresh();
    }, 10_000);
    const freshness = window.setInterval(() => {
      setObservations((current) => {
        let next = current;
        for (const [id, observation] of current) {
          if (
            observation.snapshot.status !== "UNKNOWN" &&
            Date.now() - observation.receivedAt >= 30_000
          ) {
            if (next === current) next = new Map(current);
            next.set(id, {
              ...observation,
              snapshot: { ...observation.snapshot, status: "UNKNOWN" },
            });
          }
        }
        return next;
      });
    }, 1_000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(initial);
      window.clearInterval(fallback);
      window.clearInterval(freshness);
      document.removeEventListener("visibilitychange", visible);
      unsubscribe();
      recovery();
      browserChanged();
    };
  }, [idsKey]);

  return new Map([...observations].map(([id, value]) => [id, value.snapshot]));
}
