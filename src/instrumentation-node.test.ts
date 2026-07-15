// @vitest-environment node
import { createServer } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocketServer } from "ws";

import {
  parseAgentWebSocketPort,
  startAgentWebSocketServer,
} from "./instrumentation-node";

const websocketGlobal = globalThis as typeof globalThis & {
  agentWebSocketServer?: WebSocketServer;
  agentWebSocketStartPromise?: Promise<void>;
};

afterEach(() => {
  delete websocketGlobal.agentWebSocketServer;
  delete websocketGlobal.agentWebSocketStartPromise;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("agent WebSocket startup", () => {
  test("uses the default port for an empty environment value", () => {
    expect(parseAgentWebSocketPort("")).toBe(3091);
  });

  test("does not cache a server whose bind failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not bind a TCP port");
    }
    vi.stubEnv("AGENT_WS_HOSTNAME", "127.0.0.1");
    vi.stubEnv("AGENT_WS_PORT", String(address.port));

    await expect(startAgentWebSocketServer()).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
    expect(websocketGlobal.agentWebSocketServer).toBeUndefined();

    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
    await startAgentWebSocketServer();
    expect(websocketGlobal.agentWebSocketServer).toBeDefined();

    await new Promise<void>((resolve, reject) =>
      websocketGlobal.agentWebSocketServer?.close((error) =>
        error ? reject(error) : resolve(),
      ),
    );
  });
});
