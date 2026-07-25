import { effectiveBuildsDirectory } from "@/services/builds/build-directory";
import { agentOnlineWindowMs } from "@/services/agent-control";

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
  heartbeatIntervalSeconds?: number | null;
}): "ONLINE" | "OFFLINE" {
  const lastSeen = iso(value.lastSeenAt);
  return lastSeen !== null &&
    Date.now() - Date.parse(lastSeen) <= agentOnlineWindowMs(value) &&
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

/**
 * Workflow rows arrive as Prisma records: `Date` columns and JSON blobs kept as
 * `*Json` strings. These project them the way the GraphQL resolvers in
 * `src/graphql/resolvers/workflows.ts` do, so an MCP caller sees the same shape
 * the UI does — parsed JSON, ISO timestamps — rather than raw storage.
 */
export function workflowView(value: Record<string, unknown>) {
  const counts = value._count as
    { versions?: number; runs?: number } | undefined;
  const versions = value.versions as unknown[] | undefined;
  return {
    id: String(value.id),
    name: String(value.name),
    description: String(value.description ?? ""),
    enabled: value.enabled === true,
    overlapPolicy: String(value.overlapPolicy),
    maxConcurrentRuns: Number(value.maxConcurrentRuns),
    activeVersionId:
      typeof value.activeVersionId === "string" ? value.activeVersionId : null,
    draftSchemaVersion: Number(value.draftSchemaVersion),
    quickActionKind: String(value.quickActionKind ?? "NONE"),
    archivedAt: iso(value.archivedAt),
    versionCount: counts?.versions ?? versions?.length ?? 0,
    runCount: counts?.runs ?? 0,
    createdAt: iso(value.createdAt),
    updatedAt: iso(value.updatedAt),
  };
}

export function workflowVersionView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    workflowId: String(value.workflowId),
    version: Number(value.version),
    name: String(value.name),
    description: String(value.description ?? ""),
    schemaVersion: Number(value.schemaVersion),
    contentHash: String(value.contentHash),
    definition: parsedJson(value.definitionJson),
    publishedAt: iso(value.publishedAt),
  };
}

export function workflowRunView(value: Record<string, unknown>) {
  const counts = value._count as
    { attempts?: number; events?: number } | undefined;
  return {
    id: String(value.id),
    displayNumber: Number(value.displayNumber),
    workflowId: String(value.workflowId),
    versionId: String(value.versionId),
    parentRunId:
      typeof value.parentRunId === "string" ? value.parentRunId : null,
    triggerKind: String(value.triggerKind),
    triggerSubjectKey: String(value.triggerSubjectKey ?? ""),
    triggerPayload: parsedJson(value.triggerPayloadJson),
    status: String(value.status),
    phase: String(value.phase),
    generation: Number(value.generation),
    sessionData: parsedJson(value.sessionDataJson),
    blockedReason:
      typeof value.blockedReason === "string" ? value.blockedReason : null,
    error: typeof value.error === "string" ? value.error : null,
    attemptCount:
      counts?.attempts ??
      (value.attempts as unknown[] | undefined)?.length ??
      0,
    eventCount:
      counts?.events ?? (value.events as unknown[] | undefined)?.length ?? 0,
    queuedAt: iso(value.queuedAt),
    startedAt: iso(value.startedAt),
    pausedAt: iso(value.pausedAt),
    finishedAt: iso(value.finishedAt),
    updatedAt: iso(value.updatedAt),
  };
}

export function workflowAttemptView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    nodeId: String(value.nodeId),
    kind: String(value.kind),
    generation: Number(value.generation),
    iterationKey: String(value.iterationKey ?? ""),
    attempt: Number(value.attempt),
    status: String(value.status),
    phase: String(value.phase),
    input: parsedJson(value.inputJson),
    output: parsedJson(value.outputJson),
    error: typeof value.error === "string" ? value.error : null,
    startedAt: iso(value.startedAt),
    finishedAt: iso(value.finishedAt),
  };
}

export function workflowRunEventView(value: Record<string, unknown>) {
  return {
    id: String(value.id),
    runId: String(value.runId),
    attemptId: typeof value.attemptId === "string" ? value.attemptId : null,
    sequence: Number(value.sequence),
    type: String(value.type),
    message: String(value.message ?? ""),
    detail: parsedJson(value.detailJson),
    createdAt: iso(value.createdAt),
  };
}

/**
 * A pending question batch flattened to what an answer needs: the batch id to
 * respond to, and each question's id, prompt, and selectable options.
 */
export function workflowQuestionBatchView(value: Record<string, unknown>) {
  const questions = Array.isArray(value.questions) ? value.questions : [];
  return {
    batchId: String(value.id),
    runId: typeof value.runId === "string" ? value.runId : null,
    status: String(value.status),
    createdAt: iso(value.createdAt),
    questions: questions.map((entry) => {
      const question = entry as Record<string, unknown>;
      const options = Array.isArray(question.options) ? question.options : [];
      return {
        id: String(question.id),
        header: typeof question.header === "string" ? question.header : null,
        prompt: String(question.prompt ?? ""),
        multiSelect: question.multiSelect === true,
        allowCustom: question.allowCustom === true,
        options: options.map((option) => {
          const row = option as Record<string, unknown>;
          return {
            label: String(row.label ?? ""),
            description:
              typeof row.description === "string" ? row.description : null,
          };
        }),
      };
    }),
  };
}
