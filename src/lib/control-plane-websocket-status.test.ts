import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  options: null as unknown as {
    keepAlive: number;
    on: {
      connecting(retrying: boolean): void;
      connected(): void;
      ping(received: boolean): void;
      pong(received: boolean): void;
      closed(event: { code: number }): void;
      error(): void;
    };
  },
  terminate: vi.fn(),
}));
vi.mock("graphql-ws", () => ({
  createClient: (options: typeof mocks.options) => {
    mocks.options = options;
    return { subscribe: () => () => undefined, terminate: mocks.terminate };
  },
}));

import { controlPlaneSubscriptions } from "./control-plane-client";
import { getBrowserWebSocketSnapshot } from "./websocket-status";

afterEach(() => {
  mocks.options.on.closed({ code: 1000 });
  vi.useRealTimers();
  mocks.terminate.mockClear();
});

describe("browser WebSocket status", () => {
  test("tracks connection lifecycle on the shared client", () => {
    const dispose = controlPlaneSubscriptions().subscribe(
      { query: "subscription Status { changed }" },
      { next() {}, error() {}, complete() {} },
    );
    mocks.options.on.connecting(false);
    expect(getBrowserWebSocketSnapshot().status).toBe("CONNECTING");
    mocks.options.on.connected();
    expect(getBrowserWebSocketSnapshot().status).toBe("CONNECTED");
    expect(getBrowserWebSocketSnapshot().lastVerifiedAt).not.toBeNull();
    mocks.options.on.closed({ code: 1006 });
    expect(getBrowserWebSocketSnapshot().status).toBe("RECONNECTING");
    mocks.options.on.connected();
    expect(getBrowserWebSocketSnapshot().status).toBe("CONNECTED");
    dispose();
  });

  test("terminates an unresponsive socket and clears the timer on recovery", () => {
    vi.useFakeTimers();
    expect(mocks.options.keepAlive).toBe(10_000);
    mocks.options.on.connected();
    mocks.options.on.ping(false);
    vi.advanceTimersByTime(5_000);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(getBrowserWebSocketSnapshot().status).toBe("RECONNECTING");
    mocks.options.on.connecting(true);
    mocks.options.on.connected();
    mocks.options.on.ping(false);
    vi.advanceTimersByTime(4_000);
    mocks.options.on.pong(true);
    vi.advanceTimersByTime(1_000);
    expect(mocks.terminate).toHaveBeenCalledOnce();
    expect(getBrowserWebSocketSnapshot().status).toBe("CONNECTED");
  });

  test("cleans up pending timeouts when a socket closes", () => {
    vi.useFakeTimers();
    mocks.options.on.connected();
    mocks.options.on.ping(false);
    mocks.options.on.closed({ code: 1000 });
    vi.advanceTimersByTime(5_000);
    expect(mocks.terminate).not.toHaveBeenCalled();
    expect(getBrowserWebSocketSnapshot().status).toBe("DISCONNECTED");
  });

  test("an old pong cannot mark a closed socket connected", () => {
    mocks.options.on.connected();
    mocks.options.on.closed({ code: 1006 });
    mocks.options.on.pong(true);
    expect(getBrowserWebSocketSnapshot().status).toBe("RECONNECTING");
  });
});
