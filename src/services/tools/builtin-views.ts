import { effectiveBuildsDirectory } from "@/services/builds/build-directory";
import { AGENT_ONLINE_WINDOW_MS } from "@/services/agent-control";

function parsedJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

export function agentConnectionStatus(value: {
  lastSeenAt?: Date | string | null;
  disconnectedAt?: Date | string | null;
}): "ONLINE" | "OFFLINE" {
  const lastSeen = iso(value.lastSeenAt);
  return lastSeen !== null &&
    Date.now() - Date.parse(lastSeen) <= AGENT_ONLINE_WINDOW_MS &&
    !value.disconnectedAt
    ? "ONLINE"
    : "OFFLINE";
}

export function agentView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    name: String(value.name),
    hostname: String(value.hostname),
    version: String(value.version),
    osVersion: String(value.osVersion),
    architecture: String(value.architecture),
    cpuModel: typeof value.cpuModel === "string" ? value.cpuModel : null,
    memoryTotalBytes:
      typeof value.memoryTotalBytes === "number"
        ? value.memoryTotalBytes
        : null,
    memoryFreeBytes:
      typeof value.memoryFreeBytes === "number" ? value.memoryFreeBytes : null,
    diskTotalBytes:
      typeof value.diskTotalBytes === "number" ? value.diskTotalBytes : null,
    diskFreeBytes:
      typeof value.diskFreeBytes === "number" ? value.diskFreeBytes : null,
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities
      : (parsedJson(value.capabilitiesJson) ?? []),
    baseRepoDirectory:
      typeof value.baseRepoDirectory === "string"
        ? value.baseRepoDirectory
        : null,
    derivedDataLocationMode: String(value.derivedDataLocationMode),
    derivedDataPath:
      typeof value.derivedDataPath === "string" ? value.derivedDataPath : null,
    buildsDirectory:
      typeof value.buildsDirectory === "string" ? value.buildsDirectory : null,
    defaultBuildsDirectory:
      typeof value.defaultBuildsDirectory === "string"
        ? value.defaultBuildsDirectory
        : null,
    effectiveBuildsDirectory: effectiveBuildsDirectory(
      value as {
        baseRepoDirectory: string | null;
        buildsDirectory: string | null;
        defaultBuildsDirectory?: string | null;
      },
    ),
    connectionStatus: agentConnectionStatus(value),
    ipAddress: typeof value.ipAddress === "string" ? value.ipAddress : null,
    lastSeenAt: iso(value.lastSeenAt),
    disconnectedAt: iso(value.disconnectedAt),
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

export function agentSettingsView(value: Record<string, unknown>) {
  const agent = agentView(value);
  return {
    agentId: agent.id,
    baseRepoDirectory: agent.baseRepoDirectory,
    buildsDirectory: agent.buildsDirectory,
    defaultBuildsDirectory: agent.defaultBuildsDirectory,
    effectiveBuildsDirectory: agent.effectiveBuildsDirectory,
    derivedDataLocationMode: agent.derivedDataLocationMode,
    derivedDataPath: agent.derivedDataPath,
    updatedAt: agent.updatedAt,
  };
}

export function agentJobView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    agentId: String(value.agentId),
    worktreeId: typeof value.worktreeId === "string" ? value.worktreeId : null,
    codebaseId: typeof value.codebaseId === "string" ? value.codebaseId : null,
    kind: String(value.kind),
    payload: parsedJson(value.payload ?? value.payloadJson),
    status: String(value.status),
    idempotencyKey: String(value.idempotencyKey),
    result: parsedJson(value.result ?? value.resultJson),
    error: typeof value.error === "string" ? value.error : null,
    timeoutSeconds: Number(value.timeoutSeconds),
    createdAt: iso(value.createdAt),
    startedAt: iso(value.startedAt),
    finishedAt: iso(value.finishedAt),
    updatedAt: iso(value.updatedAt),
  };
}

export function agentJobLogView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    jobId: String(value.jobId),
    sequence: Number(value.sequence),
    stream: String(value.stream),
    message: String(value.message),
    createdAt: iso(value.createdAt),
  };
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
