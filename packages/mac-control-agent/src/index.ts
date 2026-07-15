import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  defaultWebSocketServer,
  loadConfig,
  normalizeServer,
  saveConfig,
} from "./config.js";
import { runAgent } from "./agent-runtime.js";
import { AgentGraphQLClient } from "./graphql-client.js";
import { collectInventory } from "./inventory.js";

const execFileAsync = promisify(execFile);

function flags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${argument}`);
    result[argument.slice(2)] = value;
    index += 1;
  }
  return result;
}

function usage(): void {
  console.log(`mac-control-agent <command>

Commands:
  enroll --enrollment-token <token> [--server http://127.0.0.1:3090] [--websocket-server ws://127.0.0.1:3091/graphql] [--name <name>]
  run
  status
  doctor`);
}

async function enroll(args: string[]): Promise<void> {
  const options = flags(args);
  const enrollmentToken = options["enrollment-token"];
  if (!enrollmentToken) throw new Error("--enrollment-token is required");
  const server = normalizeServer(options.server ?? "http://127.0.0.1:3090");
  const websocketServer =
    options["websocket-server"] ?? defaultWebSocketServer(server);
  const inventory = collectInventory();
  const name = options.name ?? inventory.hostname;
  const client = new AgentGraphQLClient(server);
  const response = await client.enroll({ ...inventory, enrollmentToken, name });
  await saveConfig({
    server,
    websocketServer,
    agentId: response.enrollAgent.agent.id,
    credential: response.enrollAgent.credential,
    name,
  });
  console.log(`Enrolled agent ${name} (${response.enrollAgent.agent.id})`);
}

async function status(): Promise<void> {
  const config = await loadConfig();
  const response = await new AgentGraphQLClient(
    config.server,
    config.credential,
  ).self();
  console.log(
    JSON.stringify(
      {
        config: { ...config, credential: "[redacted]" },
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
    const health = await new AgentGraphQLClient(server).health();
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
  if (command === "run") {
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    return runAgent(await loadConfig(), controller.signal);
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
