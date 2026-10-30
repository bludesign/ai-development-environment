import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentWebSocketRegistry } from "./websocket-registry";

afterEach(() => vi.useRealTimers());

describe("agent WebSocket presence", () => {
  test("requires a notification subscription and verifies it on pong", () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const registry = new AgentWebSocketRegistry(publish);
    registry.open("socket");
    registry.verify("socket");
    expect(registry.snapshot("agent").status).toBe("DISCONNECTED");
    expect(publish).not.toHaveBeenCalled();
    const release = registry.subscribe("socket", "agent");
    const connected = registry.snapshot("agent");
    expect(connected.status).toBe("CONNECTED");
    vi.advanceTimersByTime(12_000);
    registry.verify("socket");
    expect(registry.snapshot("agent")).toMatchObject({
      connectedAt: connected.connectedAt,
      changedAt: connected.changedAt,
      lastVerifiedAt: new Date().toISOString(),
    });
    release();
    expect(registry.snapshot("agent")).toMatchObject({
      status: "DISCONNECTED",
      disconnectedAt: new Date().toISOString(),
    });
  });

  test("keeps overlapping sessions and duplicate subscriptions independent", () => {
    const registry = new AgentWebSocketRegistry(vi.fn());
    registry.open("old");
    registry.open("new");
    const releaseOld = registry.subscribe("old", "agent");
    const releaseFirst = registry.subscribe("new", "agent");
    const releaseLast = registry.subscribe("new", "agent");
    registry.close("old");
    releaseOld();
    releaseFirst();
    expect(registry.snapshot("agent").status).toBe("CONNECTED");
    releaseLast();
    expect(registry.snapshot("agent").status).toBe("DISCONNECTED");
  });

  test("socket closure clears all subscriptions and a new registry starts fresh", () => {
    const registry = new AgentWebSocketRegistry(vi.fn());
    registry.open("socket");
    registry.subscribe("socket", "agent");
    registry.close("socket");
    registry.verify("socket");
    expect(registry.snapshot("agent").status).toBe("DISCONNECTED");
    expect(new AgentWebSocketRegistry(vi.fn()).snapshot("agent")).toMatchObject(
      {
        status: "DISCONNECTED",
        connectedAt: null,
        lastVerifiedAt: null,
      },
    );
  });
});
