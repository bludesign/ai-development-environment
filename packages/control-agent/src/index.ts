import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  defaultWebSocketServer,
  loadConfig,
  normalizeServer,
  saveConfig,
} from "./config.js";
import { runAgent } from "./agent-runtime.js";
import { runDevelopmentAgent } from "./dev-runtime.js";
import { AgentGraphQLClient } from "./graphql-client.js";
import { collectInventory } from "./inventory.js";
import { redactedRequestHeaders, requestHeaders } from "./request-headers.js";

const execFileAsync = promisify(execFile);

function flags(args: string[]): {
  values: Record<string, string>;
  headers: Record<string, string>;
} {
  const result: Record<string, string> = {};
  const headerValues: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
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
  enroll --enrollment-token <token> [--server http://127.0.0.1:3090] [--websocket-server ws://127.0.0.1:3090/graphql] [--name <name>] [--header "Name: value"]...
  dev [--server http://127.0.0.1:3000] [--websocket-server ws://127.0.0.1:3092/graphql] [--name <name>]
  run
  status
  doctor`);
}

async function enroll(args: string[]): Promise<void> {
  const parsed = flags(args);
  const options = parsed.values;
  const enrollmentToken = options["enrollment-token"];
  if (!enrollmentToken) throw new Error("--enrollment-token is required");
  const server = normalizeServer(options.server ?? "http://127.0.0.1:3090");
  const websocketServer =
    options["websocket-server"] ?? defaultWebSocketServer(server);
  const inventory = collectInventory();
  const name = options.name ?? inventory.hostname;
  const client = new AgentGraphQLClient(server, null, 10_000, parsed.headers);
  const response = await client.enroll({ ...inventory, enrollmentToken, name });
  await saveConfig({
    server,
    websocketServer,
    agentId: response.enrollAgent.agent.id,
    credential: response.enrollAgent.credential,
    name,
    headers: parsed.headers,
  });
  console.log(`Enrolled agent ${name} (${response.enrollAgent.agent.id})`);
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
  let config;
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
  try {
    const server = config?.server ?? "http://127.0.0.1:3090";
    const health = await new AgentGraphQLClient(
      server,
      null,
      10_000,
      config?.headers,
    ).health();
    checks.push({
      check: "control plane",
      ok: health.health === "ok",
      detail: health.health,
    });
  } catch (error) {
    checks.push({
      check: "control plane",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const { stdout, stderr } = await execFileAsync("cloudflared", [
      "--version",
    ]);
    checks.push({
      check: "cloudflared",
      ok: true,
      detail: (stdout || stderr).trim(),
    });
  } catch (error) {
    checks.push({
      check: "cloudflared",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  for (const check of checks)
    console.log(
      `${check.ok ? "PASS" : "FAIL"} ${check.check}: ${check.detail}`,
    );
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }
  if (command === "enroll") return enroll(args);
  if (command === "status") return status();
  if (command === "doctor") return doctor();
  if (command === "run" || command === "dev") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    if (command === "dev") {
      const options = flags(args).values;
      const server =
        options.server ??
        process.env.CONTROL_AGENT_DEV_SERVER ??
        `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
      return runDevelopmentAgent(
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
    return runAgent(await loadConfig(), controller.signal);
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
