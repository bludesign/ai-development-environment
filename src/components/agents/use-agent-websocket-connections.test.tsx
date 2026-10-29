import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { updateBrowserWebSocketStatus } from "@/lib/websocket-status";
import { useAgentWebSocketConnections } from "./use-agent-websocket-connections";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneRecovery: () => () => undefined,
}));
const request = vi.mocked(controlPlaneRequest);
let receive: (value: unknown) => void;
const connection = {
  agentId: "agent-1",
  status: "CONNECTED",
  connectedAt: "2026-10-29T12:00:00Z",
  lastVerifiedAt: "2026-10-29T12:00:00Z",
  disconnectedAt: null,
  changedAt: "2026-10-29T12:00:00Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  updateBrowserWebSocketStatus("CONNECTED");
  request.mockResolvedValue({
    agent: { webSocketConnection: connection },
  } as never);
  vi.mocked(controlPlaneSubscriptions).mockReturnValue({
    subscribe: vi.fn((_operation, sink) => {
      receive = (value) => sink.next(value as never);
      return vi.fn();
    }),
  } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("agent WebSocket snapshots", () => {
  test("pauses HTTP reads in hidden tabs and refreshes when visible", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    renderHook(() => useAgentWebSocketConnections(["agent-1"]));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(request).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(request).toHaveBeenCalledOnce();
  });
  test("loads status and applies live disconnects independently of heartbeat status", async () => {
    const { result } = renderHook(() =>
      useAgentWebSocketConnections(["agent-1"]),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.get("agent-1")?.status).toBe("CONNECTED");
    act(() =>
      receive({
        data: {
          agentWebSocketConnectionChanged: {
            ...connection,
            status: "DISCONNECTED",
          },
        },
      }),
    );
    expect(result.current.get("agent-1")?.status).toBe("DISCONNECTED");
  });

  test("expires unavailable snapshots and recovers through HTTP while browser WebSocket is down", async () => {
    const { result, unmount } = renderHook(() =>
      useAgentWebSocketConnections(["agent-1"]),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    request.mockRejectedValue(new Error("unavailable"));
    act(() => updateBrowserWebSocketStatus("DISCONNECTED"));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(result.current.get("agent-1")?.status).toBe("UNKNOWN");
    request.mockResolvedValue({
      agent: { webSocketConnection: { ...connection, status: "DISCONNECTED" } },
    } as never);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(result.current.get("agent-1")?.status).toBe("DISCONNECTED");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not overwrite a live event with an older HTTP snapshot", async () => {
    const pending = Promise.withResolvers<unknown>();
    request.mockReturnValue(pending.promise as never);
    const { result } = renderHook(() =>
      useAgentWebSocketConnections(["agent-1"]),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() =>
      receive({
        data: {
          agentWebSocketConnectionChanged: {
            ...connection,
            status: "DISCONNECTED",
          },
        },
      }),
    );
    await act(async () =>
      pending.resolve({ agent: { webSocketConnection: connection } }),
    );
    expect(result.current.get("agent-1")?.status).toBe("DISCONNECTED");
  });

  test("rechecks quiet disconnected agents even when browser transport is connected", async () => {
    request.mockResolvedValue({
      agent: { webSocketConnection: { ...connection, status: "DISCONNECTED" } },
    } as never);
    const { result } = renderHook(() =>
      useAgentWebSocketConnections(["agent-1"]),
    );
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.get("agent-1")?.status).toBe("DISCONNECTED");
  });
});
