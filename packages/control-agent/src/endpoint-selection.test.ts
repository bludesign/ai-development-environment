import { describe, expect, test, vi } from "vitest";

import {
  agentEndpoints,
  configForEndpoint,
  type AgentConfig,
} from "./config.js";
import {
  findHealthyAlternate,
  selectAgentEndpoint,
} from "./endpoint-selection.js";

const config: AgentConfig = {
  server: "http://127.0.0.1:3090",
  websocketServer: "ws://127.0.0.1:3090/graphql",
  remoteServer: "https://control.example.com",
  agentId: "agent-1",
  credential: "credential-1",
  name: "laptop",
};

describe("agent endpoints", () => {
  test("derives the remote websocket address when it is not stored", () => {
    expect(agentEndpoints(config)).toEqual([
      {
        kind: "local",
        server: "http://127.0.0.1:3090",
        websocketServer: "ws://127.0.0.1:3090/graphql",
      },
      {
        kind: "remote",
        server: "https://control.example.com",
        websocketServer: "wss://control.example.com/graphql",
      },
    ]);
  });

  test("omits the remote endpoint when only a local address is configured", () => {
    expect(agentEndpoints({ ...config, remoteServer: null })).toHaveLength(1);
  });

  test("pins a configuration to one endpoint without leaving alternates behind", () => {
    const pinned = configForEndpoint(config, agentEndpoints(config)[1]);
    expect(pinned.server).toBe("https://control.example.com");
    expect(pinned.websocketServer).toBe("wss://control.example.com/graphql");
    expect(agentEndpoints(pinned)).toHaveLength(1);
  });
});

describe("selectAgentEndpoint", () => {
  test("prefers the local endpoint when it answers", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const endpoint = await selectAgentEndpoint(
      config,
      new AbortController().signal,
      probe,
    );
    expect(endpoint.kind).toBe("local");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  test("falls back to the remote endpoint when the local one is silent", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const endpoint = await selectAgentEndpoint(
      config,
      new AbortController().signal,
      probe,
    );
    expect(endpoint.kind).toBe("remote");
  });

  test("returns the local endpoint when nothing answers so the session can retry", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const endpoint = await selectAgentEndpoint(
      config,
      new AbortController().signal,
      probe,
    );
    expect(endpoint.kind).toBe("local");
  });

  test("skips probing entirely when only one endpoint is configured", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const endpoint = await selectAgentEndpoint(
      { ...config, remoteServer: null },
      new AbortController().signal,
      probe,
    );
    expect(endpoint.kind).toBe("local");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("findHealthyAlternate", () => {
  const [local, remote] = agentEndpoints(config);

  test("returns the other endpoint when it answers", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    await expect(
      findHealthyAlternate(config, local, new AbortController().signal, probe),
    ).resolves.toEqual(remote);
    // The active endpoint is never probed; only the alternates are.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0]).toEqual(remote);
  });

  test("returns nothing when the whole control plane is down", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    await expect(
      findHealthyAlternate(config, local, new AbortController().signal, probe),
    ).resolves.toBeUndefined();
  });

  test("returns nothing when there is no other endpoint to move to", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    await expect(
      findHealthyAlternate(
        { ...config, remoteServer: null },
        local,
        new AbortController().signal,
        probe,
      ),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  test("treats a duplicated address as no alternate at all", async () => {
    const duplicated = { ...config, remoteServer: config.server };
    const probe = vi.fn().mockResolvedValue(true);
    await expect(
      findHealthyAlternate(
        duplicated,
        agentEndpoints(duplicated)[0],
        new AbortController().signal,
        probe,
      ),
    ).resolves.toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });
});
