import { accessSync, constants } from "node:fs";

import {
  parseTailscaleServeRoute,
  tailscaleServeInspectPayload,
  tailscaleServeRemovePayload,
  tailscaleServeUpsertPayload,
  type TailscaleServeJobResult,
  type TailscaleServeRoute,
  type TailscaleServeSnapshot,
} from "@ai-development-environment/agent-contract/tailscale";

import { captureCommand, type CaptureResult } from "../capture-command.js";
import { findExecutable } from "../executable-lookup.js";
import type { AgentJobHandler } from "./index.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const mutationQueues = new Map<string, Promise<void>>();

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function resolveTailscaleExecutable(
  platform = process.platform,
  resolve = findExecutable,
  isExecutable = (path: string) => {
    accessSync(path, constants.X_OK);
    return true;
  },
): string {
  const resolved = resolve("tailscale", {
    overrideVariable: "CONTROL_AGENT_TAILSCALE_EXECUTABLE",
  });
  if (resolved) return resolved;
  if (platform === "darwin") {
    for (const path of [
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/Applications/Tailscale.app/Contents/MacOS/tailscale",
    ]) {
      try {
        if (isExecutable(path)) return path;
      } catch {
        // Continue to the actionable error below.
      }
    }
  }
  throw new Error(
    "Tailscale CLI was not found. Install Tailscale or set CONTROL_AGENT_TAILSCALE_EXECUTABLE.",
  );
}

export function parseTailscaleJson(value: string, label: string): JsonObject {
  try {
    const parsed = JSON.parse(value);
    const object = objectValue(parsed);
    if (!object) throw new Error("expected an object");
    return object;
  } catch (error) {
    throw new Error(
      `${label} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function tailscaleCommandFailure(
  command: string,
  result: CaptureResult,
): Error {
  const reason = result.timedOut
    ? "timed out"
    : result.cancelled
      ? "was cancelled"
      : result.stderr.trim() || `exited with status ${result.exitCode}`;
  return new Error(`${command} failed: ${reason}`);
}

async function captureTailscale(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CaptureResult> {
  const result = await captureCommand({
    command: executable,
    args,
    timeoutMs,
    signal,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (result.outputTruncated) {
    throw new Error(`tailscale ${args.join(" ")} exceeded the output limit`);
  }
  if (result.exitCode !== 0) {
    throw tailscaleCommandFailure(`tailscale ${args.join(" ")}`, result);
  }
  return result;
}

function backendIdentity(status: JsonObject) {
  const self = objectValue(status.Self);
  const rawAddresses = Array.isArray(self?.TailscaleIPs)
    ? self.TailscaleIPs
    : status.TailscaleIPs;
  const addresses = Array.isArray(rawAddresses)
    ? rawAddresses.filter((value): value is string => typeof value === "string")
    : [];
  const dnsName = typeof self?.DNSName === "string" ? self.DNSName : null;
  return {
    dnsHostname: dnsName?.replace(/\.$/, "") ?? null,
    ipv4: addresses.filter((value) => value.includes(".")),
    ipv6: addresses.filter((value) => value.includes(":")),
    backendState:
      typeof status.BackendState === "string" ? status.BackendState : "Unknown",
  };
}

function destinationFromProxy(proxy: string) {
  const parsed = new URL(proxy);
  if (parsed.hostname !== "127.0.0.1") {
    throw new Error("Only 127.0.0.1 Tailscale Serve targets are managed");
  }
  const rawProtocol = parsed.protocol.replace(/:$/, "");
  const protocol =
    rawProtocol === "https+insecure"
      ? "HTTPS_INSECURE"
      : rawProtocol === "https"
        ? "HTTPS"
        : rawProtocol === "tcp"
          ? "TCP"
          : "HTTP";
  return {
    protocol,
    port: Number(parsed.port),
    path:
      protocol === "TCP" ? "" : parsed.pathname === "/" ? "" : parsed.pathname,
  } as const;
}

function portFromListener(value: string): number | null {
  const match = value.match(/:(\d+)$/) ?? value.match(/^(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function normalizeTailscaleServeSnapshot(
  status: JsonObject,
  serve: JsonObject,
  inspectedAt = new Date().toISOString(),
): TailscaleServeSnapshot {
  const routes: TailscaleServeRoute[] = [];
  const tcp = objectValue(serve.TCP) ?? {};
  const web = objectValue(serve.Web) ?? {};
  const funnel = objectValue(serve.AllowFunnel) ?? {};

  for (const [listener, rawWeb] of Object.entries(web)) {
    const listenPort = portFromListener(listener);
    const webConfig = objectValue(rawWeb);
    const handlers = objectValue(webConfig?.Handlers);
    if (!listenPort || !handlers) continue;
    const tcpConfig = objectValue(tcp[String(listenPort)]);
    const protocol = tcpConfig?.HTTPS === true ? "HTTPS" : "HTTP";
    const isFunnel = Object.entries(funnel).some(
      ([key, enabled]) =>
        enabled === true && portFromListener(key) === listenPort,
    );
    for (const [mountPath, rawHandler] of Object.entries(handlers)) {
      const handler = objectValue(rawHandler);
      if (!handler || typeof handler.Proxy !== "string") continue;
      const capabilities = Array.isArray(handler.AppCapabilities)
        ? handler.AppCapabilities.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      try {
        routes.push(
          parseTailscaleServeRoute({
            protocol,
            listenPort,
            mountPath,
            destination: destinationFromProxy(handler.Proxy),
            funnel: isFunnel,
            appCapabilities: capabilities,
            proxyProtocol: "NONE",
          }),
        );
      } catch {
        // Unsupported handler shapes are intentionally not imported.
      }
    }
  }

  for (const [listener, rawTcp] of Object.entries(tcp)) {
    const listenPort = portFromListener(listener);
    const config = objectValue(rawTcp);
    if (!listenPort || !config || typeof config.TCPForward !== "string")
      continue;
    const destination = config.TCPForward.startsWith("tcp://")
      ? config.TCPForward
      : `tcp://${config.TCPForward}`;
    const proxy = config.ProxyProtocol;
    try {
      routes.push(
        parseTailscaleServeRoute({
          protocol: config.TerminateTLS ? "TLS_TERMINATED_TCP" : "TCP",
          listenPort,
          mountPath: "/",
          destination: destinationFromProxy(destination),
          funnel: Object.entries(funnel).some(
            ([key, enabled]) =>
              enabled === true && portFromListener(key) === listenPort,
          ),
          appCapabilities: [],
          proxyProtocol:
            proxy === 1 || proxy === "1" || proxy === "V1"
              ? "V1"
              : proxy === 2 || proxy === "2" || proxy === "V2"
                ? "V2"
                : "NONE",
        }),
      );
    } catch {
      // Unsupported targets (including non-loopback/file handlers) stay unmanaged.
    }
  }

  return {
    identity: backendIdentity(status),
    routes: routes.sort((first, second) =>
      `${first.listenPort}:${first.mountPath}`.localeCompare(
        `${second.listenPort}:${second.mountPath}`,
      ),
    ),
    inspectedAt,
  };
}

async function inspect(
  executable: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TailscaleServeSnapshot> {
  const status = await captureTailscale(
    executable,
    ["status", "--json"],
    timeoutMs,
    signal,
  );
  const serve = await captureTailscale(
    executable,
    ["serve", "status", "--json"],
    timeoutMs,
    signal,
  );
  return normalizeTailscaleServeSnapshot(
    parseTailscaleJson(status.stdout, "tailscale status --json"),
    parseTailscaleJson(serve.stdout, "tailscale serve status --json"),
  );
}

function listenerArguments(route: TailscaleServeRoute): string[] {
  const flag =
    route.protocol === "TLS_TERMINATED_TCP"
      ? "tls-terminated-tcp"
      : route.protocol.toLowerCase();
  return [
    `--${flag}=${route.listenPort}`,
    ...(route.protocol === "HTTP" || route.protocol === "HTTPS"
      ? [`--set-path=${route.mountPath}`]
      : []),
  ];
}

function routeTarget(route: TailscaleServeRoute): string {
  const scheme =
    route.destination.protocol === "HTTPS_INSECURE"
      ? "https+insecure"
      : route.destination.protocol.toLowerCase();
  return `${scheme}://127.0.0.1:${route.destination.port}${route.destination.path}`;
}

export function tailscaleUpsertArguments(route: TailscaleServeRoute): string[] {
  const normalized = parseTailscaleServeRoute(route);
  return [
    normalized.funnel ? "funnel" : "serve",
    "--bg",
    "--yes",
    ...listenerArguments(normalized),
    ...(normalized.appCapabilities.length
      ? [`--accept-app-caps=${normalized.appCapabilities.join(",")}`]
      : []),
    ...(normalized.proxyProtocol === "NONE"
      ? []
      : [`--proxy-protocol=${normalized.proxyProtocol === "V1" ? "1" : "2"}`]),
    routeTarget(normalized),
  ];
}

export function tailscaleRemoveArguments(route: TailscaleServeRoute): string[] {
  const normalized = parseTailscaleServeRoute(route);
  return [
    normalized.funnel ? "funnel" : "serve",
    ...listenerArguments(normalized),
    "off",
  ];
}

export function tailscaleUpsertCommandSequence(
  route: TailscaleServeRoute,
  previousRoute?: TailscaleServeRoute | null,
): string[][] {
  return [
    ...(previousRoute && JSON.stringify(previousRoute) !== JSON.stringify(route)
      ? [tailscaleRemoveArguments(previousRoute)]
      : []),
    tailscaleUpsertArguments(route),
  ];
}

async function serialized<T>(
  agentId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueues.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  mutationQueues.set(agentId, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (mutationQueues.get(agentId) === tail) mutationQueues.delete(agentId);
  }
}

function success(snapshot: TailscaleServeSnapshot): TailscaleServeJobResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    snapshot,
  };
}

export const inspectTailscaleServe: AgentJobHandler = async (
  rawPayload,
  timeoutMs,
  signal,
) => {
  tailscaleServeInspectPayload(rawPayload);
  const executable = resolveTailscaleExecutable();
  return success(await inspect(executable, timeoutMs, signal));
};

export const upsertTailscaleServe: AgentJobHandler = async (
  rawPayload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const payload = tailscaleServeUpsertPayload(rawPayload);
  const executable = resolveTailscaleExecutable();
  return serialized(context?.agentId ?? "default", async () => {
    for (const args of tailscaleUpsertCommandSequence(
      payload.route,
      payload.previousRoute,
    )) {
      await captureTailscale(executable, args, timeoutMs, signal);
    }
    return success(await inspect(executable, timeoutMs, signal));
  });
};

export const removeTailscaleServe: AgentJobHandler = async (
  rawPayload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const payload = tailscaleServeRemovePayload(rawPayload);
  const executable = resolveTailscaleExecutable();
  return serialized(context?.agentId ?? "default", async () => {
    await captureTailscale(
      executable,
      tailscaleRemoveArguments(payload.route),
      timeoutMs,
      signal,
    );
    return success(await inspect(executable, timeoutMs, signal));
  });
};
