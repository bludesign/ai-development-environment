import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentConfig = {
  server: string;
  websocketServer: string;
  // The same control plane reachable from outside the local network. It is the
  // fallback the agent falls back to when the local address stops answering.
  remoteServer?: string | null;
  remoteWebSocketServer?: string | null;
  agentId: string;
  credential: string;
  name: string;
  headers?: Record<string, string>;
};

export type AgentEndpointKind = "local" | "remote";

export type AgentEndpoint = {
  kind: AgentEndpointKind;
  server: string;
  websocketServer: string;
};

export const configPath = () =>
  process.env.CONTROL_AGENT_CONFIG ??
  join(homedir(), ".config", "control-agent", "config.json");

export const developmentConfigPath = () =>
  process.env.CONTROL_AGENT_DEV_CONFIG ??
  join(homedir(), ".config", "control-agent-dev", "config.json");

export function normalizeServer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Server URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

export function defaultWebSocketServer(server: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/graphql";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The addresses this agent may use, most preferred first. The local address is
 * tried before the remote one so an agent sitting on the same network as the
 * control plane never routes through the public entry point.
 */
export function agentEndpoints(config: AgentConfig): AgentEndpoint[] {
  const endpoints: AgentEndpoint[] = [
    {
      kind: "local",
      server: config.server,
      websocketServer: config.websocketServer,
    },
  ];
  if (config.remoteServer) {
    endpoints.push({
      kind: "remote",
      server: config.remoteServer,
      websocketServer:
        config.remoteWebSocketServer ??
        defaultWebSocketServer(config.remoteServer),
    });
  }
  return endpoints;
}

/**
 * Pins a configuration to one endpoint. The alternates are dropped so nothing
 * downstream mistakes the active address for the configured local one.
 */
export function configForEndpoint(
  config: AgentConfig,
  endpoint: AgentEndpoint,
): AgentConfig {
  return {
    ...config,
    server: endpoint.server,
    websocketServer: endpoint.websocketServer,
    remoteServer: null,
    remoteWebSocketServer: null,
  };
}

export async function loadConfig(path = configPath()): Promise<AgentConfig> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as AgentConfig;
    if (
      !value.server ||
      !value.websocketServer ||
      !value.agentId ||
      !value.credential
    ) {
      throw new Error("configuration is incomplete");
    }
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent is not enrolled (${path}): ${detail}`);
  }
}

export async function saveConfig(
  config: AgentConfig,
  path = configPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}
