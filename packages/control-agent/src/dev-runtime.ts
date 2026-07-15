import type { AgentConfig } from "./config.js";
import {
  defaultWebSocketServer,
  developmentConfigPath,
  loadConfig,
  normalizeServer,
  saveConfig,
} from "./config.js";
import { AgentGraphQLClient } from "./graphql-client.js";
import { collectInventory, type AgentInventory } from "./inventory.js";
import { runAgent } from "./agent-runtime.js";

const DEFAULT_SERVER_WAIT_MS = 120_000;
const SERVER_RETRY_MS = 500;

type DevelopmentAgentApi = {
  health: () => Promise<{ health: string }>;
  self: () => Promise<{ agentSelf: Record<string, unknown> | null }>;
  createEnrollmentToken: () => Promise<{
    createAgentEnrollmentToken: { token: string; expiresAt: string };
  }>;
  enroll: (
    input: AgentInventory & { enrollmentToken: string; name: string },
  ) => Promise<{
    enrollAgent: { agent: { id: string }; credential: string };
  }>;
};

export type DevelopmentAgentOptions = {
  server: string;
  websocketServer?: string;
  name?: string;
  configFile?: string;
  waitTimeoutMs?: number;
};

type DevelopmentAgentDependencies = {
  createClient: (server: string, credential?: string) => DevelopmentAgentApi;
  inventory: () => AgentInventory;
  load: (path: string) => Promise<AgentConfig>;
  save: (config: AgentConfig, path: string) => Promise<void>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

const defaultDependencies: DevelopmentAgentDependencies = {
  createClient: (server, credential) =>
    new AgentGraphQLClient(server, credential ?? null),
  inventory: collectInventory,
  load: loadConfig,
  save: saveConfig,
  wait: (milliseconds, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Development agent startup was cancelled"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Development agent startup was cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

export function assertLoopbackServer(server: string): void {
  const hostname = new URL(server).hostname.toLowerCase();
  const isIpv4Loopback = /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (hostname !== "localhost" && hostname !== "[::1]" && !isIpv4Loopback) {
    throw new Error(
      `Development auto-enrollment is restricted to loopback servers; received ${hostname}`,
    );
  }
}

async function waitForServer(
  client: DevelopmentAgentApi,
  timeoutMs: number,
  signal: AbortSignal,
  dependencies: DevelopmentAgentDependencies,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (!signal.aborted && Date.now() < deadline) {
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
      await dependencies.wait(SERVER_RETRY_MS, signal);
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for the local control plane${detail}`);
}

export async function prepareDevelopmentAgent(
  options: DevelopmentAgentOptions,
  signal: AbortSignal,
  dependencies: DevelopmentAgentDependencies = defaultDependencies,
): Promise<AgentConfig> {
  const server = normalizeServer(options.server);
  assertLoopbackServer(server);
  const websocketServer =
    options.websocketServer ?? defaultWebSocketServer(server);
  const configFile = options.configFile ?? developmentConfigPath();
  const inventory = dependencies.inventory();
  const name = options.name ?? `${inventory.hostname}-dev`;
  const anonymousClient = dependencies.createClient(server);

  console.log(`Waiting for local control plane at ${server} ...`);
  await waitForServer(
    anonymousClient,
    options.waitTimeoutMs ?? DEFAULT_SERVER_WAIT_MS,
    signal,
    dependencies,
  );

  try {
    const existing = await dependencies.load(configFile);
    if (
      existing.server === server &&
      existing.websocketServer === websocketServer
    ) {
      const authenticated = dependencies.createClient(
        server,
        existing.credential,
      );
      const response = await authenticated.self();
      if (response.agentSelf?.id === existing.agentId) {
        console.log(
          `Reusing development agent ${existing.name} (${existing.agentId})`,
        );
        return existing;
      }
    }
  } catch {
    // A missing, invalid, or stale development config is replaced below.
  }

  const enrollment = await anonymousClient.createEnrollmentToken();
  const response = await anonymousClient.enroll({
    ...inventory,
    enrollmentToken: enrollment.createAgentEnrollmentToken.token,
    name,
  });
  const config: AgentConfig = {
    server,
    websocketServer,
    agentId: response.enrollAgent.agent.id,
    credential: response.enrollAgent.credential,
    name,
  };
  await dependencies.save(config, configFile);
  console.log(`Enrolled development agent ${name} (${config.agentId})`);
  return config;
}

export async function runDevelopmentAgent(
  options: DevelopmentAgentOptions,
  signal: AbortSignal,
): Promise<void> {
  const config = await prepareDevelopmentAgent(options, signal);
  await runAgent(config, signal);
}
