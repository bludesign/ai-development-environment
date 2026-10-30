export type WebSocketStatus =
  "UNKNOWN" | "CONNECTING" | "CONNECTED" | "RECONNECTING" | "DISCONNECTED";

export type WebSocketSnapshot = {
  status: WebSocketStatus;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  disconnectedAt: string | null;
  changedAt: string | null;
};

export const UNKNOWN_WEBSOCKET_SNAPSHOT: WebSocketSnapshot = {
  status: "UNKNOWN",
  connectedAt: null,
  lastVerifiedAt: null,
  disconnectedAt: null,
  changedAt: null,
};

let snapshot = UNKNOWN_WEBSOCKET_SNAPSHOT;
const listeners = new Set<() => void>();

export const getBrowserWebSocketSnapshot = () => snapshot;
export const getServerWebSocketSnapshot = () => UNKNOWN_WEBSOCKET_SNAPSHOT;

export function subscribeBrowserWebSocketStatus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateBrowserWebSocketStatus(status: WebSocketStatus): void {
  const now = new Date().toISOString();
  const changed = snapshot.status !== status;
  snapshot = {
    ...snapshot,
    status,
    changedAt: changed ? now : snapshot.changedAt,
    connectedAt: changed && status === "CONNECTED" ? now : snapshot.connectedAt,
    lastVerifiedAt: status === "CONNECTED" ? now : snapshot.lastVerifiedAt,
    disconnectedAt:
      changed && (status === "DISCONNECTED" || status === "RECONNECTING")
        ? now
        : snapshot.disconnectedAt,
  };
  for (const listener of [...listeners]) listener();
}
