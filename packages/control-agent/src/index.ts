import { rm } from "node:fs/promises";

import {
  agentEndpoints,
  configPath,
  defaultWebSocketServer,
  loadConfig,
  normalizeServer,
  saveConfig,
  type AgentConfig,
} from "./config.js";
import { runAgent } from "./agent-runtime.js";
import { runDevelopmentAgent } from "./dev-runtime.js";
import { probeEndpoint } from "./endpoint-selection.js";
import { repairToolPath } from "./executable-lookup.js";
import { AgentGraphQLClient } from "./graphql-client.js";
import { collectInventory } from "./inventory.js";
import { redactedRequestHeaders, requestHeaders } from "./request-headers.js";

// Flags that stand alone; every other flag consumes the argument after it.
const BOOLEAN_FLAGS = new Set(["clear-remote"]);

function flags(args: string[]): {
  values: Record<string, string>;
  headers: Record<string, string>;
} {
  const result: Record<string, string> = {};
  const headerValues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    if (BOOLEAN_FLAGS.has(argument.slice(2))) {
      result[argument.slice(2)] = "true";
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${argument}`);
    if (argument === "--header") headerValues.push(value);
    else result[argument.slice(2)] = value;
    index += 1;
  }
  return { values: result, headers: requestHeaders(headerValues) };
}

function usage(): void {
  console.log(`control-agent <command>

Commands:
  enroll --enrollment-token <token> [--server http://127.0.0.1:3090] [--websocket-server ws://127.0.0.1:3090/graphql] [--remote-server https://control.example.com] [--remote-websocket-server wss://control.example.com/graphql] [--name <name>] [--header "Name: value"]...
  endpoints [--server <url>] [--websocket-server <url>] [--remote-server <url>] [--remote-websocket-server <url>] [--clear-remote]
  enrollment
  unenroll
  dev [--server http://127.0.0.1:3000] [--websocket-server ws://127.0.0.1:3092/graphql] [--name <name>]
  run
  status
  doctor`);
}

/**
 * Reads the local and remote addresses out of parsed flags. `fallback` keeps
 * the values already stored so `endpoints` can change one address at a time.
 */
function endpointOptions(
  options: Record<string, string>,
  fallback?: AgentConfig,
): Pick<
  AgentConfig,
  "server" | "websocketServer" | "remoteServer" | "remoteWebSocketServer"
> {
  const server = normalizeServer(
    options.server ?? fallback?.server ?? "http://127.0.0.1:3090",
  );
  const websocketServer =
    options["websocket-server"] ??
    // A new local address invalidates a websocket address derived from the old
    // one, so only an explicitly stored value survives a server change.
    (options.server ? undefined : fallback?.websocketServer) ??
    defaultWebSocketServer(server);
  const clearRemote = options["clear-remote"] === "true";
  const remote = options["remote-server"] ?? (clearRemote ? null : undefined);
  const remoteServer =
    remote === undefined
      ? (fallback?.remoteServer ?? null)
      : remote && normalizeServer(remote);
  const remoteWebSocketServer = !remoteServer
    ? null
    : (options["remote-websocket-server"] ??
      (options["remote-server"]
        ? undefined
        : fallback?.remoteWebSocketServer) ??
      defaultWebSocketServer(remoteServer));
  return {
    server,
    websocketServer,
    remoteServer,
    remoteWebSocketServer,
  };
}

async function enroll(args: string[]): Promise<void> {
  const parsed = flags(args);
  const options = parsed.values;
  const enrollmentToken = options["enrollment-token"];
  if (!enrollmentToken) throw new Error("--enrollment-token is required");
  const addresses = endpointOptions(options);
  const inventory = collectInventory();
  const name = options.name ?? inventory.hostname;
  const client = new AgentGraphQLClient(
    addresses.server,
    null,
    10_000,
    parsed.headers,
  );
  const response = await client.enroll({ ...inventory, enrollmentToken, name });
  await saveConfig({
    ...addresses,
    agentId: response.enrollAgent.agent.id,
    credential: response.enrollAgent.credential,
    name,
    headers: parsed.headers,
  });
  console.log(`Enrolled agent ${name} (${response.enrollAgent.agent.id})`);
}

async function endpoints(args: string[]): Promise<void> {
  const options = flags(args).values;
  const config = await loadConfig();
  const changing = [
    "server",
    "websocket-server",
    "remote-server",
    "remote-websocket-server",
    "clear-remote",
  ].some((flag) => flag in options);
  const updated = changing
    ? { ...config, ...endpointOptions(options, config) }
    : config;
  if (changing) await saveConfig(updated);
  for (const endpoint of agentEndpoints(updated)) {
    console.log(
      `${endpoint.kind}: ${endpoint.server} (${endpoint.websocketServer})`,
    );
  }
  if (!updated.remoteServer) console.log("remote: not configured");
}

async function enrollment(): Promise<void> {
  let config: AgentConfig;
  try {
    config = await loadConfig();
  } catch (error) {
    console.log("Enrolled: no");
    console.log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  console.log("Enrolled: yes");
  console.log(`Agent: ${config.name} (${config.agentId})`);
  console.log(`Configuration: ${configPath()}`);
  let reachable = false;
  for (const endpoint of agentEndpoints(config)) {
    const ok = await probeEndpoint(endpoint, config);
    reachable ||= ok;
    console.log(
      `${endpoint.kind}: ${endpoint.server} — ${ok ? "reachable" : "unreachable"}`,
    );
  }
  if (!reachable) process.exitCode = 1;
}

async function unenroll(): Promise<void> {
  const path = configPath();
  let config: AgentConfig | null = null;
  try {
    config = await loadConfig(path);
  } catch {
    // A missing or unreadable configuration still leaves the file to remove.
  }
  await rm(path, { force: true });
  console.log(
    config
      ? `Removed the enrollment for ${config.name} (${config.agentId}) from ${path}`
      : `Removed ${path}`,
  );
  console.log(
    "The control plane still lists this agent; delete it there to finish removing it.",
  );
}

async function status(): Promise<void> {
  const config = await loadConfig();
  const response = await new AgentGraphQLClient(
    config.server,
    config.credential,
    10_000,
    config.headers,
  ).self();
  console.log(
    JSON.stringify(
      {
        config: {
          ...config,
          credential: "[redacted]",
          headers: redactedRequestHeaders(config.headers),
        },
        agent: response.agentSelf,
      },
      null,
      2,
    ),
  );
}

async function doctor(): Promise<void> {
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  let config: AgentConfig | undefined;
  try {
    config = await loadConfig();
    checks.push({ check: "configuration", ok: true, detail: "loaded" });
  } catch (error) {
    checks.push({
      check: "configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const reachable = config
    ? agentEndpoints(config)
    : [
        {
          kind: "local" as const,
          server: "http://127.0.0.1:3090",
          websocketServer: "ws://127.0.0.1:3090/graphql",
        },
      ];
  // Only one endpoint has to answer: a laptop away from the local network
  // reaches the same control plane through its remote address.
  const results = await Promise.all(
    reachable.map(async (endpoint) => {
      try {
        const health = await new AgentGraphQLClient(
          endpoint.server,
          null,
          10_000,
          config?.headers,
        ).health();
        return {
          ok: health.health === "ok",
          detail: `${endpoint.kind} ${endpoint.server}: ${health.health}`,
        };
      } catch (error) {
        return {
          ok: false,
          detail: `${endpoint.kind} ${endpoint.server}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
  checks.push({
    check: "control plane",
    ok: results.some((result) => result.ok),
    detail: results.map((result) => result.detail).join("; "),
  });
  for (const check of checks)
    console.log(
      `${check.ok ? "PASS" : "FAIL"} ${check.check}: ${check.detail}`,
    );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  // Runs before any command so every child process — ours and the ones third
  // party SDKs spawn by bare name — inherits a PATH that includes the usual
  // tool directories, which the launchd service PATH omits.
  repairToolPath();
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }
  if (command === "enroll") return enroll(args);
  if (command === "endpoints") return endpoints(args);
  if (command === "enrollment") return enrollment();
  if (command === "unenroll") return unenroll();
  if (command === "status") return status();
  if (command === "doctor") return doctor();
  if (command === "run" || command === "dev") {
    const controller = new AbortController();
    const stop = () => controller.abort();
    const shutdownSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of shutdownSignals) process.once(signal, stop);
    try {
      if (command === "dev") {
        const options = flags(args).values;
        const server =
          options.server ??
          process.env.CONTROL_AGENT_DEV_SERVER ??
          `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
        return await runDevelopmentAgent(
          {
            server,
            websocketServer:
              options["websocket-server"] ??
              process.env.CONTROL_AGENT_DEV_WEBSOCKET_SERVER ??
              process.env.NEXT_PUBLIC_AGENT_WS_URL,
            name: options.name,
          },
          controller.signal,
        );
      }
      return await runAgent(await loadConfig(), controller.signal);
    } finally {
      for (const signal of shutdownSignals) process.off(signal, stop);
    }
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
