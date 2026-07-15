import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentConfig = {
  server: string;
  websocketServer: string;
  agentId: string;
  credential: string;
  name: string;
};

export const configPath = () =>
  process.env.MAC_CONTROL_AGENT_CONFIG ??
  join(
    homedir(),
    "Library",
    "Application Support",
    "mac-control-agent",
    "config.json",
  );

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
  url.port = process.env.AGENT_WS_PORT ?? "3091";
  url.pathname = "/graphql";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function loadConfig(): Promise<AgentConfig> {
  try {
    const value = JSON.parse(
      await readFile(configPath(), "utf8"),
    ) as AgentConfig;
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
    throw new Error(`Agent is not enrolled (${configPath()}): ${detail}`);
  }
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}
