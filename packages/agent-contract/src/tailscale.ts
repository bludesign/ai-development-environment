import { createHash } from "node:crypto";

export const TAILSCALE_SERVE_INSPECT_JOB_KIND = "tailscale.serve.inspect.v1";
export const TAILSCALE_SERVE_UPSERT_JOB_KIND = "tailscale.serve.upsert.v1";
export const TAILSCALE_SERVE_REMOVE_JOB_KIND = "tailscale.serve.remove.v1";

export const TAILSCALE_SERVE_JOB_KINDS = [
  TAILSCALE_SERVE_INSPECT_JOB_KIND,
  TAILSCALE_SERVE_UPSERT_JOB_KIND,
  TAILSCALE_SERVE_REMOVE_JOB_KIND,
] as const;

export const TAILSCALE_SERVE_PROTOCOLS = [
  "HTTP",
  "HTTPS",
  "TCP",
  "TLS_TERMINATED_TCP",
] as const;
export type TailscaleServeProtocol = (typeof TAILSCALE_SERVE_PROTOCOLS)[number];

export const TAILSCALE_DESTINATION_PROTOCOLS = [
  "HTTP",
  "HTTPS",
  "HTTPS_INSECURE",
  "TCP",
] as const;
export type TailscaleDestinationProtocol =
  (typeof TAILSCALE_DESTINATION_PROTOCOLS)[number];

export const TAILSCALE_PROXY_PROTOCOLS = ["NONE", "V1", "V2"] as const;
export type TailscaleProxyProtocol = (typeof TAILSCALE_PROXY_PROTOCOLS)[number];

export type TailscaleServeDestination = {
  protocol: TailscaleDestinationProtocol;
  port: number;
  path: string;
};

export type TailscaleServeRoute = {
  protocol: TailscaleServeProtocol;
  listenPort: number;
  mountPath: string;
  destination: TailscaleServeDestination;
  funnel: boolean;
  appCapabilities: string[];
  proxyProtocol: TailscaleProxyProtocol;
};

export type TailscaleIdentity = {
  dnsHostname: string | null;
  ipv4: string[];
  ipv6: string[];
  backendState: string;
};

export type TailscaleServeSnapshot = {
  identity: TailscaleIdentity;
  routes: TailscaleServeRoute[];
  inspectedAt: string;
};

export type TailscaleServeInspectPayload = {
  operationId: string;
};

export type TailscaleServeMutationPayload = {
  operationId: string;
  templateId: string;
  revision: number;
  route: TailscaleServeRoute;
};

export type TailscaleServeUpsertPayload = TailscaleServeMutationPayload & {
  previousRoute: TailscaleServeRoute | null;
};

export type TailscaleServeJobResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  snapshot: TailscaleServeSnapshot;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], name: string) {
  const unexpected = Object.keys(value).find((key) => !keys.includes(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
}

function requiredString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function integerPort(value: unknown, name: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 65_535
  ) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${name} is invalid`);
  }
  return value as T;
}

export function normalizeTailscaleMountPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.includes("?")
  ) {
    throw new Error("Tailscale mount path is invalid");
  }
  const path = value.trim() || "/";
  const prefixed = path.startsWith("/") ? path : `/${path}`;
  return prefixed === "/" ? prefixed : prefixed.replace(/\/+$/, "");
}

function normalizeDestinationPath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Tailscale destination path is invalid");
  }
  const path = value.trim();
  if (!path) return "";
  return path.startsWith("/") ? path : `/${path}`;
}

function appCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Tailscale app capabilities must be an array");
  }
  const pattern =
    /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+\/[\p{L}\p{N}-]+(?:\/[\p{L}\p{N}-]+)*$/u;
  return [
    ...new Set(
      value.map((item, index) => {
        const capability = requiredString(
          item,
          `Tailscale app capabilities[${index}]`,
        );
        if (!pattern.test(capability)) {
          throw new Error(
            `Tailscale app capabilities[${index}] must use domain/name format`,
          );
        }
        return capability;
      }),
    ),
  ].sort();
}

export function parseTailscaleServeRoute(value: unknown): TailscaleServeRoute {
  const route = objectValue(value, "Tailscale Serve route");
  exactKeys(
    route,
    [
      "protocol",
      "listenPort",
      "mountPath",
      "destination",
      "funnel",
      "appCapabilities",
      "proxyProtocol",
    ],
    "Tailscale Serve route",
  );
  const protocol = enumValue(
    route.protocol,
    TAILSCALE_SERVE_PROTOCOLS,
    "Tailscale Serve protocol",
  );
  const listenPort = integerPort(route.listenPort, "Tailscale listen port");
  const destination = objectValue(
    route.destination,
    "Tailscale Serve destination",
  );
  exactKeys(
    destination,
    ["protocol", "port", "path"],
    "Tailscale Serve destination",
  );
  const destinationProtocol = enumValue(
    destination.protocol,
    TAILSCALE_DESTINATION_PROTOCOLS,
    "Tailscale destination protocol",
  );
  const funnel = route.funnel;
  if (typeof funnel !== "boolean")
    throw new Error("Tailscale Funnel must be a boolean");
  const proxyProtocol = enumValue(
    route.proxyProtocol,
    TAILSCALE_PROXY_PROTOCOLS,
    "Tailscale PROXY protocol",
  );
  const capabilities = appCapabilities(route.appCapabilities);
  const isWeb = protocol === "HTTP" || protocol === "HTTPS";
  if (isWeb && destinationProtocol === "TCP") {
    throw new Error("Web listeners require an HTTP(S) destination");
  }
  if (!isWeb && destinationProtocol !== "TCP") {
    throw new Error("TCP listeners require a TCP destination");
  }
  if (!isWeb && normalizeTailscaleMountPath(route.mountPath) !== "/") {
    throw new Error("TCP listeners do not support mount paths");
  }
  if (
    funnel &&
    (protocol === "HTTP" || ![443, 8443, 10_000].includes(listenPort))
  ) {
    throw new Error(
      "Funnel requires HTTPS or TLS TCP on port 443, 8443, or 10000",
    );
  }
  if (capabilities.length && (!isWeb || funnel)) {
    throw new Error(
      "App capabilities are supported only by private HTTP(S) listeners",
    );
  }
  if (proxyProtocol !== "NONE" && protocol !== "TCP") {
    throw new Error("PROXY protocol is supported only by TCP listeners");
  }
  return {
    protocol,
    listenPort,
    mountPath: isWeb ? normalizeTailscaleMountPath(route.mountPath) : "/",
    destination: {
      protocol: destinationProtocol,
      port: integerPort(destination.port, "Tailscale destination port"),
      path: isWeb ? normalizeDestinationPath(destination.path) : "",
    },
    funnel,
    appCapabilities: capabilities,
    proxyProtocol,
  };
}

export function tailscaleServeInspectPayload(
  value: unknown,
): TailscaleServeInspectPayload {
  const payload = objectValue(value, "Tailscale Serve inspect payload");
  exactKeys(payload, ["operationId"], "Tailscale Serve inspect payload");
  return { operationId: requiredString(payload.operationId, "operationId") };
}

function mutationPayload(value: unknown, allowPrevious: boolean) {
  const payload = objectValue(value, "Tailscale Serve mutation payload");
  exactKeys(
    payload,
    [
      "operationId",
      "templateId",
      "revision",
      "route",
      ...(allowPrevious ? ["previousRoute"] : []),
    ],
    "Tailscale Serve mutation payload",
  );
  if (!Number.isInteger(payload.revision) || (payload.revision as number) < 1) {
    throw new Error("Tailscale template revision must be a positive integer");
  }
  return {
    operationId: requiredString(payload.operationId, "operationId"),
    templateId: requiredString(payload.templateId, "templateId"),
    revision: payload.revision as number,
    route: parseTailscaleServeRoute(payload.route),
  };
}

export function tailscaleServeUpsertPayload(
  value: unknown,
): TailscaleServeUpsertPayload {
  const base = mutationPayload(value, true);
  const payload = value as JsonObject;
  return {
    ...base,
    previousRoute:
      payload.previousRoute === null
        ? null
        : parseTailscaleServeRoute(payload.previousRoute),
  };
}

export function tailscaleServeRemovePayload(
  value: unknown,
): TailscaleServeMutationPayload {
  return mutationPayload(value, false);
}

export function tailscaleServeFingerprint(value: TailscaleServeRoute): string {
  const route = parseTailscaleServeRoute(value);
  return createHash("sha256").update(JSON.stringify(route)).digest("hex");
}

export function tailscaleListenerKey(route: TailscaleServeRoute): string {
  const normalized = parseTailscaleServeRoute(route);
  return `${normalized.protocol}:${normalized.listenPort}:${normalized.mountPath}`;
}
