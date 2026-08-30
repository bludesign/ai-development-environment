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
import { reapOrphanedCommandProcesses } from "./command-processes.js";

const DEFAULT_SERVER_WAIT_MS = 120_000;
const SERVER_RETRY_MS = 500;

type DevelopmentAgentApi = {
  ready: () => Promise<{ mode: string }>;
  self: () => Promise<{ agentSelf: Record<string, unknown> | null }>;
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
  enrollmentToken?: string;
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
      await client.ready();
      return;
    } catch (error) {
      lastError = error;
      await dependencies.wait(SERVER_RETRY_MS, signal);
    }
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `Timed out waiting for the development control plane${detail}`,
  );
}

export async function prepareDevelopmentAgent(
  options: DevelopmentAgentOptions,
  signal: AbortSignal,
  dependencies: DevelopmentAgentDependencies = defaultDependencies,
): Promise<AgentConfig> {
  const server = normalizeServer(options.server);
  const websocketServer =
    options.websocketServer ?? defaultWebSocketServer(server);
  const configFile = options.configFile ?? developmentConfigPath();
  const inventory = dependencies.inventory();
  const name = options.name ?? `${inventory.hostname}-dev`;
  const anonymousClient = dependencies.createClient(server);

  console.log(`Waiting for development control plane at ${server} ...`);
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

  const enrollmentToken = options.enrollmentToken?.trim();
  if (!enrollmentToken) {
    throw new Error(
      "The development agent needs a one-time enrollment token. Create one on the Agents page and set CONTROL_AGENT_DEV_ENROLLMENT_TOKEN.",
    );
  }
  const response = await anonymousClient.enroll({
    ...inventory,
    enrollmentToken,
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
  await reapOrphanedCommandProcesses(config.agentId, signal);
  await runAgent(config, signal);
}
