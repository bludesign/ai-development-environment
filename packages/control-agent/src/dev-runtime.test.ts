import { describe, expect, test, vi } from "vitest";

import type { AgentConfig } from "./config.js";
import {
  assertLoopbackServer,
  prepareDevelopmentAgent,
} from "./dev-runtime.js";
import type { AgentInventory } from "./inventory.js";

const inventory: AgentInventory = {
  hostname: "test-mac.local",
  version: "0.1.0",
  osVersion: "macOS test",
  architecture: "arm64",
  cpuModel: "M4 Pro",
  memoryTotalBytes: 24 * 1024 ** 3,
  memoryFreeBytes: 12 * 1024 ** 3,
  diskTotalBytes: 512 * 1024 ** 3,
  diskFreeBytes: 256 * 1024 ** 3,
  capabilities: ["cloudflared.runTunnel"],
};

const enrolledConfig: AgentConfig = {
  server: "http://127.0.0.1:3000",
  websocketServer: "ws://127.0.0.1:3092/graphql",
  agentId: "agent-development",
  credential: "credential-development",
  name: "test-mac.local-dev",
};

function agentApi() {
  return {
    health: vi.fn().mockResolvedValue({ health: "ok" }),
    self: vi.fn().mockResolvedValue({ agentSelf: null }),
    createEnrollmentToken: vi.fn().mockResolvedValue({
      createAgentEnrollmentToken: {
        token: "enroll-development",
        expiresAt: new Date().toISOString(),
      },
    }),
    enroll: vi.fn().mockResolvedValue({
      enrollAgent: {
        agent: { id: enrolledConfig.agentId },
        credential: enrolledConfig.credential,
      },
    }),
  };
}

describe("development agent preparation", () => {
  test("waits for the server and automatically enrolls on first run", async () => {
    const anonymous = agentApi();
    anonymous.health.mockRejectedValueOnce(new Error("connection refused"));
    const save = vi.fn().mockResolvedValue(undefined);
    const wait = vi.fn().mockResolvedValue(undefined);

    const config = await prepareDevelopmentAgent(
      {
        server: enrolledConfig.server,
        websocketServer: enrolledConfig.websocketServer,
        configFile: "/tmp/control-agent-dev-test.json",
      },
      new AbortController().signal,
      {
        createClient: () => anonymous,
        inventory: () => inventory,
        load: vi.fn().mockRejectedValue(new Error("missing")),
        save,
        wait,
      },
    );

    expect(wait).toHaveBeenCalledOnce();
    expect(anonymous.createEnrollmentToken).toHaveBeenCalledOnce();
    expect(anonymous.enroll).toHaveBeenCalledWith({
      ...inventory,
      enrollmentToken: "enroll-development",
      name: "test-mac.local-dev",
    });
    expect(save).toHaveBeenCalledWith(
      enrolledConfig,
      "/tmp/control-agent-dev-test.json",
    );
    expect(config).toEqual(enrolledConfig);
  });

  test("reuses a valid development identity", async () => {
    const anonymous = agentApi();
    const authenticated = agentApi();
    authenticated.self.mockResolvedValue({
      agentSelf: { id: enrolledConfig.agentId },
    });
    const save = vi.fn();

    const config = await prepareDevelopmentAgent(
      {
        server: enrolledConfig.server,
        websocketServer: enrolledConfig.websocketServer,
      },
      new AbortController().signal,
      {
        createClient: (_server, credential) =>
          credential ? authenticated : anonymous,
        inventory: () => inventory,
        load: vi.fn().mockResolvedValue(enrolledConfig),
        save,
        wait: vi.fn(),
      },
    );

    expect(config).toEqual(enrolledConfig);
    expect(authenticated.self).toHaveBeenCalledOnce();
    expect(anonymous.createEnrollmentToken).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  test("re-enrolls when saved credentials are stale", async () => {
    const anonymous = agentApi();
    const authenticated = agentApi();
    authenticated.self.mockRejectedValue(new Error("invalid credential"));
    const save = vi.fn().mockResolvedValue(undefined);

    const config = await prepareDevelopmentAgent(
      {
        server: enrolledConfig.server,
        websocketServer: enrolledConfig.websocketServer,
      },
      new AbortController().signal,
      {
        createClient: (_server, credential) =>
          credential ? authenticated : anonymous,
        inventory: () => inventory,
        load: vi.fn().mockResolvedValue(enrolledConfig),
        save,
        wait: vi.fn(),
      },
    );

    expect(anonymous.createEnrollmentToken).toHaveBeenCalledOnce();
    expect(anonymous.enroll).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(config.agentId).toBe(enrolledConfig.agentId);
  });

  test.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.42.1.9:3000",
    "http://[::1]:3000",
  ])("allows loopback server %s", (server) => {
    expect(() => assertLoopbackServer(server)).not.toThrow();
  });

  test.each([
    "https://control-plane.example.com",
    "http://10.0.0.5:3000",
    "http://192.168.1.20:3000",
  ])("rejects non-loopback server %s", (server) => {
    expect(() => assertLoopbackServer(server)).toThrow(
      "Development auto-enrollment is restricted to loopback servers",
    );
  });
});
