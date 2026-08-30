import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import {
  SSE_BREAKPOINTS_CHANGED_TOPIC,
  SSE_ENDPOINTS_CHANGED_TOPIC,
  SSE_EVENT_HISTORY_CHANGED_TOPIC,
  SSE_HISTORY_CHANGED_TOPIC,
  SSE_REQUEST_HISTORY_CHANGED_TOPIC,
  SSE_STORAGE_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control/event-bus";
import type { WorkflowEventsService } from "@/services/workflows";

import {
  runSseScript,
  type SseScriptStorage,
  type SseStoredValue,
} from "./script-runner";
import {
  SSE_BUFFER_MODES,
  SSE_DEFAULTS,
  SSE_ENDPOINT_MODES,
  SSE_HISTORY_VIEWS,
  SSE_MOCK_BLOCK_KINDS,
  SSE_MOCK_COMPLETIONS,
  type SseBreakpointResolutionInput,
  type SseEndpointInput,
  type SseEndpointMode,
  type SseEndpointSnapshot,
  type SseHeader,
  type SseHistoryQueryInput,
  type SseMockCompositionInput,
  type SseResolvedComposition,
} from "./types";

const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_BYTES = 2 * 1024 * 1024;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;

function cleanName(value: string, label = "Name"): string {
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || name.includes("\0")) {
    throw new Error(`${label} must contain 1–${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function cleanDescription(value?: string | null): string {
  const description = value?.trim() ?? "";
  if (
    description.length > MAX_DESCRIPTION_LENGTH ||
    description.includes("\0")
  ) {
    throw new Error(
      `Description must contain at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }
  return description;
}

function validateHttpUrl(value: string, label = "Forward URL"): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return url.toString();
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function jsonString(value: unknown): string {
  const output = JSON.stringify(value);
  if (output === undefined) throw new Error("Value must be JSON serializable");
  return output;
}

function numberInRange(
  value: number | null | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

function oneOf<T extends string>(
  value: string | null | undefined,
  values: readonly T[],
  fallback: T,
  label: string,
): T {
  const resolved = (value ?? fallback) as T;
  if (!values.includes(resolved)) throw new Error(`${label} is not supported`);
  return resolved;
}

type CursorPageInput = {
  first?: number | null;
  after?: string | null;
};

function cursorOffset(value?: string | null): number {
  if (!value) return 0;
  const offset = Number(Buffer.from(value, "base64url").toString("utf8"));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("Invalid SSE cursor");
  }
  return offset;
}

function cursorPage<T>(values: T[], input: CursorPageInput = {}) {
  const first = numberInRange(input.first, 100, 1, 500, "Page size");
  const offset = cursorOffset(input.after);
  const nodes = values.slice(offset, offset + first);
  return {
    nodes,
    nextCursor:
      offset + first < values.length
        ? Buffer.from(String(offset + first)).toString("base64url")
        : null,
    totalCount: values.length,
  };
}

function normalizeHeaders(values?: SseHeader[] | null): SseHeader[] {
  const result: SseHeader[] = [];
  for (const value of values ?? []) {
    const name = value.name.trim();
    if (!name) throw new Error("Header name is required");
    try {
      new Headers([[name, value.value]]);
    } catch {
      throw new Error(`Invalid HTTP header: ${name}`);
    }
    result.push({ name, value: value.value });
  }
  return result;
}

function normalizeCustomEvent(
  value: SseMockCompositionInput["blocks"][number]["customEvent"],
) {
  if (!value) return null;
  if (Buffer.byteLength(value.data) > 10 * 1024 * 1024) {
    throw new Error("Custom event data is too large");
  }
  return {
    eventName: value.eventName?.trim() || null,
    data: value.data,
    eventId: value.eventId ?? null,
    retryMs:
      value.retryMs == null
        ? null
        : numberInRange(value.retryMs, 0, 0, 86_400_000, "Retry"),
  };
}

function endpointData(input: SseEndpointInput, current?: SseEndpointSnapshot) {
  const mode = oneOf(
    input.mode,
    SSE_ENDPOINT_MODES,
    current?.mode ?? "FORWARD",
    "SSE mode",
  );
  return {
    name: cleanName(input.name, "Endpoint name"),
    description: cleanDescription(input.description),
    forwardUrl: validateHttpUrl(input.forwardUrl),
    mode,
    requestScript: input.requestScript ?? current?.requestScript ?? "",
    responseScript: input.responseScript ?? current?.responseScript ?? "",
    activeMockCompositionId:
      input.activeMockCompositionId === undefined
        ? (current?.activeMockCompositionId ?? null)
        : input.activeMockCompositionId,
    deliveryBufferMode: oneOf(
      input.deliveryBufferMode,
      SSE_BUFFER_MODES,
      current?.deliveryBufferMode ?? "STANDARD",
      "Delivery buffer mode",
    ),
    historyBufferMode: oneOf(
      input.historyBufferMode,
      SSE_BUFFER_MODES,
      current?.historyBufferMode ?? "CONCATENATE",
      "History buffer mode",
    ),
    breakpointTimeoutMs: numberInRange(
      input.breakpointTimeoutMs,
      current?.breakpointTimeoutMs ?? SSE_DEFAULTS.breakpointTimeoutMs,
      1_000,
      24 * 60 * 60 * 1_000,
      "Breakpoint timeout",
    ),
    heartbeatEnabled:
      input.heartbeatEnabled ?? current?.heartbeatEnabled ?? true,
    heartbeatIntervalMs: numberInRange(
      input.heartbeatIntervalMs,
      current?.heartbeatIntervalMs ?? SSE_DEFAULTS.heartbeatIntervalMs,
      1_000,
      10 * 60 * 1_000,
      "Heartbeat interval",
    ),
    mockCompletion: oneOf(
      input.mockCompletion,
      SSE_MOCK_COMPLETIONS,
      current?.mockCompletion ?? "CLOSE",
      "Mock completion",
    ),
    requestScriptTimeoutMs: numberInRange(
      input.requestScriptTimeoutMs,
      current?.requestScriptTimeoutMs ?? SSE_DEFAULTS.requestScriptTimeoutMs,
      10,
      120_000,
      "Request script timeout",
    ),
    mockScriptTimeoutMs: numberInRange(
      input.mockScriptTimeoutMs,
      current?.mockScriptTimeoutMs ?? SSE_DEFAULTS.mockScriptTimeoutMs,
      10,
      120_000,
      "Mock script timeout",
    ),
    responseScriptTimeoutMs: numberInRange(
      input.responseScriptTimeoutMs,
      current?.responseScriptTimeoutMs ?? SSE_DEFAULTS.responseScriptTimeoutMs,
      10,
      120_000,
      "Response script timeout",
    ),
    scriptMemoryLimitMb: numberInRange(
      input.scriptMemoryLimitMb,
      current?.scriptMemoryLimitMb ?? SSE_DEFAULTS.scriptMemoryLimitMb,
      8,
      256,
      "Script memory limit",
    ),
    fetchTimeoutMs: numberInRange(
      input.fetchTimeoutMs,
      current?.fetchTimeoutMs ?? SSE_DEFAULTS.fetchTimeoutMs,
      100,
      120_000,
      "Fetch timeout",
    ),
    requestBodyLimitBytes: numberInRange(
      input.requestBodyLimitBytes,
      current?.requestBodyLimitBytes ?? SSE_DEFAULTS.requestBodyLimitBytes,
      1_024,
      100 * 1024 * 1024,
      "Request body limit",
    ),
    eventDataLimitBytes: numberInRange(
      input.eventDataLimitBytes,
      current?.eventDataLimitBytes ?? SSE_DEFAULTS.eventDataLimitBytes,
      1_024,
      10 * 1024 * 1024,
      "Event data limit",
    ),
    streamHistoryLimitBytes: numberInRange(
      input.streamHistoryLimitBytes,
      current?.streamHistoryLimitBytes ?? SSE_DEFAULTS.streamHistoryLimitBytes,
      1_024,
      1024 * 1024 * 1024,
      "Stream history limit",
    ),
    retentionDays: numberInRange(
      input.retentionDays,
      current?.retentionDays ?? SSE_DEFAULTS.retentionDays,
      1,
      3_650,
      "Retention days",
    ),
    retentionEventLimit: numberInRange(
      input.retentionEventLimit,
      current?.retentionEventLimit ?? SSE_DEFAULTS.retentionEventLimit,
      100,
      10_000_000,
      "Retention event limit",
    ),
  };
}

type EndpointRecord = Prisma.SseEndpointGetPayload<{
  include: {
    activeMockComposition: {
      include: { blocks: { include: { template: true } } };
    };
  };
}>;

function resolvedComposition(
  value: EndpointRecord["activeMockComposition"],
): SseResolvedComposition | null {
  if (!value) return null;
  return {
    id: value.id,
    name: value.name,
    statusCode: value.statusCode,
    headers: json<SseHeader[]>(value.headersJson, []),
    blocks: [...value.blocks]
      .sort((first, second) => first.position - second.position)
      .map((block) => ({
        id: block.id,
        kind: oneOf(
          block.kind,
          SSE_MOCK_BLOCK_KINDS,
          "DELAY",
          "Mock block kind",
        ),
        delayMs: block.delayMs,
        script: block.script,
        customEvent:
          block.eventData === null
            ? null
            : {
                eventName: block.eventName,
                data: block.eventData,
                eventId: block.eventId,
                retryMs: block.retryMs,
              },
        template: block.template
          ? {
              id: block.template.id,
              endpointId: block.template.endpointId,
              name: block.template.name,
              eventName: block.template.eventName,
              data: block.template.data,
              eventId: block.template.eventId,
              retryMs: block.template.retryMs,
            }
          : null,
      })),
  };
}

function snapshot(value: EndpointRecord): SseEndpointSnapshot {
  return {
    id: value.id,
    token: value.token,
    name: value.name,
    description: value.description,
    mode: oneOf(value.mode, SSE_ENDPOINT_MODES, "FORWARD", "SSE mode"),
    forwardUrl: value.forwardUrl,
    requestScript: value.requestScript,
    responseScript: value.responseScript,
    activeMockCompositionId: value.activeMockCompositionId,
    deliveryBufferMode: oneOf(
      value.deliveryBufferMode,
      SSE_BUFFER_MODES,
      "STANDARD",
      "Delivery buffer mode",
    ),
    historyBufferMode: oneOf(
      value.historyBufferMode,
      SSE_BUFFER_MODES,
      "CONCATENATE",
      "History buffer mode",
    ),
    breakpointTimeoutMs: value.breakpointTimeoutMs,
    heartbeatEnabled: value.heartbeatEnabled,
    heartbeatIntervalMs: value.heartbeatIntervalMs,
    mockCompletion: oneOf(
      value.mockCompletion,
      SSE_MOCK_COMPLETIONS,
      "CLOSE",
      "Mock completion",
    ),
    requestScriptTimeoutMs: value.requestScriptTimeoutMs,
    mockScriptTimeoutMs: value.mockScriptTimeoutMs,
    responseScriptTimeoutMs: value.responseScriptTimeoutMs,
    scriptMemoryLimitMb: value.scriptMemoryLimitMb,
    fetchTimeoutMs: value.fetchTimeoutMs,
    requestBodyLimitBytes: value.requestBodyLimitBytes,
    eventDataLimitBytes: value.eventDataLimitBytes,
    streamHistoryLimitBytes: value.streamHistoryLimitBytes,
    retentionDays: value.retentionDays,
    retentionEventLimit: value.retentionEventLimit,
    activeMockComposition: resolvedComposition(value.activeMockComposition),
  };
}

function endpointView(value: EndpointRecord, origin?: string | null) {
  const result = snapshot(value);
  return {
    ...result,
    publicUrl: origin
      ? `${origin}/api/public/sse/${value.token}`
      : `/api/public/sse/${value.token}`,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

function storageKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > MAX_STORAGE_KEY_LENGTH || key.includes("\0")) {
    throw new Error(
      `Storage key must contain 1–${MAX_STORAGE_KEY_LENGTH} characters`,
    );
  }
  return key;
}

function storageValue(value: unknown): string {
  const output = jsonString(value);
  if (Buffer.byteLength(output) > MAX_STORAGE_VALUE_BYTES) {
    throw new Error("Storage value must be 2 MiB or smaller");
  }
  return output;
}

function storedValue(
  value: { key: string; valueJson: string; version: number } | null,
): SseStoredValue {
  return value
    ? {
        key: value.key,
        value: json(value.valueJson, null),
        version: value.version,
      }
    : null;
}

export class SseService {
  private nextMaintenanceAt = 0;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly workflowEvents?: WorkflowEventsService) {}

  startRuntime(): void {
    if (this.maintenanceTimer) return;
    void this.maintain().catch((error) =>
      console.error("Failed to maintain SSE history", error),
    );
    this.maintenanceTimer = setInterval(() => {
      void this.maintain().catch((error) =>
        console.error("Failed to maintain SSE history", error),
      );
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref?.();
  }

  private changed(topic: string, reason: string, ids: string[]): void {
    agentEventBus.publish(topic, { reason, ids });
  }

  private async workflow(
    kind: string,
    subjectKey: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.workflowEvents?.record({
        kind,
        subjectKey,
        dedupeKey,
        payload,
      });
    } catch (error) {
      console.error(`Failed to record ${kind} workflow event`, error);
    }
  }

  private async endpointRecord(id: string): Promise<EndpointRecord> {
    const prisma = await getPrismaClient();
    const endpoint = await prisma.sseEndpoint.findUnique({
      where: { id },
      include: {
        activeMockComposition: {
          include: { blocks: { include: { template: true } } },
        },
      },
    });
    if (!endpoint) throw new Error("SSE endpoint not found");
    return endpoint;
  }

  async endpoints(origin?: string | null) {
    const prisma = await getPrismaClient();
    const values = await prisma.sseEndpoint.findMany({
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      include: {
        activeMockComposition: {
          include: { blocks: { include: { template: true } } },
        },
      },
    });
    return values.map((value) => endpointView(value, origin));
  }

  async endpoint(id: string, origin?: string | null) {
    return endpointView(await this.endpointRecord(id), origin);
  }

  async endpointsPage(input: CursorPageInput = {}, origin?: string | null) {
    return cursorPage(await this.endpoints(origin), input);
  }

  async eventTemplatesPage(endpointId: string, input: CursorPageInput = {}) {
    return cursorPage(await this.eventTemplates(endpointId), input);
  }

  async compositionsPage(endpointId: string, input: CursorPageInput = {}) {
    return cursorPage(await this.compositions(endpointId), input);
  }

  async storageEntriesPage(input: CursorPageInput = {}) {
    return cursorPage(await this.storageEntries(), input);
  }

  async breakpointsPage(status?: string | null, input: CursorPageInput = {}) {
    return cursorPage(await this.breakpoints(status), input);
  }

  async historyColumnPresetsPage(view: string, input: CursorPageInput = {}) {
    return cursorPage(await this.historyColumnPresets(view), input);
  }

  async historySavedFiltersPage(view: string, input: CursorPageInput = {}) {
    return cursorPage(await this.historySavedFilters(view), input);
  }

  async snapshotForToken(value: string): Promise<SseEndpointSnapshot | null> {
    const prisma = await getPrismaClient();
    const endpoint = await prisma.sseEndpoint.findUnique({
      where: { token: value },
      include: {
        activeMockComposition: {
          include: { blocks: { include: { template: true } } },
        },
      },
    });
    return endpoint ? snapshot(endpoint) : null;
  }

  async createEndpoint(input: SseEndpointInput, origin?: string | null) {
    const data = endpointData(input);
    if (data.mode === "MOCK" && !data.activeMockCompositionId) {
      throw new Error(
        "Select an active mock composition before enabling Mock mode",
      );
    }
    const prisma = await getPrismaClient();
    const value = await prisma.sseEndpoint.create({
      data: { id: randomUUID(), token: token(), ...data },
      include: {
        activeMockComposition: {
          include: { blocks: { include: { template: true } } },
        },
      },
    });
    this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "CREATED", [value.id]);
    return endpointView(value, origin);
  }

  async updateEndpoint(
    id: string,
    input: SseEndpointInput,
    origin?: string | null,
  ) {
    const current = snapshot(await this.endpointRecord(id));
    const data = endpointData(input, current);
    const prisma = await getPrismaClient();
    if (data.activeMockCompositionId) {
      const composition = await prisma.sseMockComposition.findFirst({
        where: { id: data.activeMockCompositionId, endpointId: id },
      });
      if (!composition)
        throw new Error(
          "Active mock composition does not belong to this endpoint",
        );
    }
    if (data.mode === "MOCK" && !data.activeMockCompositionId) {
      throw new Error(
        "Select an active mock composition before enabling Mock mode",
      );
    }
    const value = await prisma.sseEndpoint.update({
      where: { id },
      data,
      include: {
        activeMockComposition: {
          include: { blocks: { include: { template: true } } },
        },
      },
    });
    this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "UPDATED", [id]);
    return endpointView(value, origin);
  }

  async setMode(id: string, mode: SseEndpointMode, origin?: string | null) {
    const current = await this.endpoint(id, origin);
    return this.updateEndpoint(id, { ...current, mode }, origin);
  }

  async rotateToken(id: string, origin?: string | null) {
    const prisma = await getPrismaClient();
    await prisma.sseEndpoint.update({
      where: { id },
      data: { token: token() },
    });
    this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "TOKEN_ROTATED", [id]);
    return this.endpoint(id, origin);
  }

  async deleteEndpoint(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const result = await prisma.sseEndpoint.deleteMany({ where: { id } });
    if (result.count)
      this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "DELETED", [id]);
    return result.count > 0;
  }

  async eventTemplates(endpointId: string) {
    const prisma = await getPrismaClient();
    const values = await prisma.sseMockEventTemplate.findMany({
      where: { endpointId },
      orderBy: { name: "asc" },
    });
    return values.map((value) => ({
      ...value,
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    }));
  }

  async saveEventTemplate(
    endpointId: string,
    input: {
      id?: string | null;
      name: string;
      eventName?: string | null;
      data: string;
      eventId?: string | null;
      retryMs?: number | null;
    },
  ) {
    await this.endpointRecord(endpointId);
    if (Buffer.byteLength(input.data) > 10 * 1024 * 1024)
      throw new Error("Template data is too large");
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    if (input.id) {
      const existing = await prisma.sseMockEventTemplate.findUnique({
        where: { id },
        select: { endpointId: true },
      });
      if (existing && existing.endpointId !== endpointId) {
        throw new Error("Mock template does not belong to this endpoint");
      }
    }
    const value = await prisma.sseMockEventTemplate.upsert({
      where: { id },
      create: {
        id,
        endpointId,
        name: cleanName(input.name, "Template name"),
        eventName: input.eventName?.trim() || null,
        data: input.data,
        eventId: input.eventId ?? null,
        retryMs:
          input.retryMs == null
            ? null
            : numberInRange(input.retryMs, 0, 0, 86_400_000, "Retry"),
      },
      update: {
        name: cleanName(input.name, "Template name"),
        eventName: input.eventName?.trim() || null,
        data: input.data,
        eventId: input.eventId ?? null,
        retryMs:
          input.retryMs == null
            ? null
            : numberInRange(input.retryMs, 0, 0, 86_400_000, "Retry"),
      },
    });
    this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "MOCK_TEMPLATE_SAVED", [
      endpointId,
    ]);
    return {
      ...value,
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    };
  }

  async deleteEventTemplate(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const current = await prisma.sseMockEventTemplate.findUnique({
      where: { id },
    });
    const result = await prisma.sseMockEventTemplate.deleteMany({
      where: { id },
    });
    if (current && result.count)
      this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "MOCK_TEMPLATE_DELETED", [
        current.endpointId,
      ]);
    return result.count > 0;
  }

  async compositions(endpointId: string) {
    const prisma = await getPrismaClient();
    const values = await prisma.sseMockComposition.findMany({
      where: { endpointId },
      orderBy: { name: "asc" },
      include: { blocks: { include: { template: true } } },
    });
    return values.map((value) => ({
      ...resolvedComposition(value)!,
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    }));
  }

  async resolveCompositionInput(
    endpointId: string,
    input: SseMockCompositionInput,
  ): Promise<SseResolvedComposition> {
    const prisma = await getPrismaClient();
    const templateIds = input.blocks.flatMap((block) =>
      block.templateId ? [block.templateId] : [],
    );
    const templates = templateIds.length
      ? await prisma.sseMockEventTemplate.findMany({
          where: { endpointId, id: { in: templateIds } },
        })
      : [];
    const byId = new Map(templates.map((template) => [template.id, template]));
    return {
      id: `ad-hoc:${randomUUID()}`,
      name: cleanName(input.name || "Ad hoc response", "Composition name"),
      statusCode: numberInRange(
        input.statusCode,
        200,
        100,
        599,
        "Mock status code",
      ),
      headers: normalizeHeaders(input.headers),
      blocks: input.blocks.map((block) => {
        const kind = oneOf(
          block.kind,
          SSE_MOCK_BLOCK_KINDS,
          "DELAY",
          "Mock block kind",
        );
        const template = block.templateId
          ? byId.get(block.templateId)
          : undefined;
        const customEvent =
          kind === "EVENT" ? normalizeCustomEvent(block.customEvent) : null;
        if (kind === "EVENT" && block.templateId && !template) {
          throw new Error(
            "Mock event template does not belong to this endpoint",
          );
        }
        if (kind === "EVENT" && Boolean(template) === Boolean(customEvent)) {
          throw new Error(
            "Event blocks require exactly one template or custom event",
          );
        }
        return {
          id: block.id ?? randomUUID(),
          kind,
          delayMs:
            kind === "DELAY"
              ? numberInRange(block.delayMs, 0, 0, 86_400_000, "Mock delay")
              : null,
          script: kind === "SCRIPT" ? (block.script ?? "") : null,
          customEvent,
          template: template
            ? {
                id: template.id,
                endpointId: template.endpointId,
                name: template.name,
                eventName: template.eventName,
                data: template.data,
                eventId: template.eventId,
                retryMs: template.retryMs,
              }
            : null,
        };
      }),
    };
  }

  async saveComposition(
    endpointId: string,
    input: SseMockCompositionInput,
    id?: string | null,
  ) {
    await this.endpointRecord(endpointId);
    const headers = normalizeHeaders(input.headers);
    const statusCode = numberInRange(
      input.statusCode,
      200,
      100,
      599,
      "Mock status code",
    );
    if (input.blocks.length > 1_000)
      throw new Error("A composition may contain at most 1,000 blocks");
    const prisma = await getPrismaClient();
    if (id) {
      const existing = await prisma.sseMockComposition.findUnique({
        where: { id },
        select: { endpointId: true },
      });
      if (existing && existing.endpointId !== endpointId) {
        throw new Error("Mock composition does not belong to this endpoint");
      }
    }
    const templateIds = input.blocks.flatMap((block) =>
      block.templateId ? [block.templateId] : [],
    );
    if (templateIds.length) {
      const count = await prisma.sseMockEventTemplate.count({
        where: { endpointId, id: { in: templateIds } },
      });
      if (count !== new Set(templateIds).size)
        throw new Error(
          "Every referenced template must belong to this endpoint",
        );
    }
    const compositionId = id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
      await transaction.sseMockComposition.upsert({
        where: { id: compositionId },
        create: {
          id: compositionId,
          endpointId,
          name: cleanName(input.name, "Composition name"),
          statusCode,
          headersJson: jsonString(headers),
        },
        update: {
          name: cleanName(input.name, "Composition name"),
          statusCode,
          headersJson: jsonString(headers),
        },
      });
      await transaction.sseMockBlock.deleteMany({ where: { compositionId } });
      if (input.blocks.length) {
        await transaction.sseMockBlock.createMany({
          data: input.blocks.map((block, position) => {
            const kind = oneOf(
              block.kind,
              SSE_MOCK_BLOCK_KINDS,
              "DELAY",
              "Mock block kind",
            );
            const customEvent =
              kind === "EVENT" ? normalizeCustomEvent(block.customEvent) : null;
            if (
              kind === "EVENT" &&
              Boolean(block.templateId) === Boolean(customEvent)
            ) {
              throw new Error(
                "Event blocks require exactly one template or custom event",
              );
            }
            if (kind === "SCRIPT" && !block.script?.trim())
              throw new Error("Script blocks require JavaScript");
            return {
              id: block.id ?? randomUUID(),
              compositionId,
              position,
              kind,
              templateId: kind === "EVENT" ? block.templateId : null,
              eventName: customEvent?.eventName ?? null,
              eventData: customEvent?.data ?? null,
              eventId: customEvent?.eventId ?? null,
              retryMs: customEvent?.retryMs ?? null,
              delayMs:
                kind === "DELAY"
                  ? numberInRange(block.delayMs, 0, 0, 86_400_000, "Mock delay")
                  : null,
              script: kind === "SCRIPT" ? block.script : null,
            };
          }),
        });
      }
    });
    this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "MOCK_COMPOSITION_SAVED", [
      endpointId,
    ]);
    return (await this.compositions(endpointId)).find(
      (value) => value.id === compositionId,
    )!;
  }

  async deleteComposition(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const value = await prisma.sseMockComposition.findUnique({ where: { id } });
    const result = await prisma.sseMockComposition.deleteMany({
      where: { id },
    });
    if (value && result.count)
      this.changed(SSE_ENDPOINTS_CHANGED_TOPIC, "MOCK_COMPOSITION_DELETED", [
        value.endpointId,
      ]);
    return result.count > 0;
  }

  async activateComposition(
    endpointId: string,
    compositionId: string | null,
    origin?: string | null,
  ) {
    const endpoint = await this.endpoint(endpointId, origin);
    return this.updateEndpoint(
      endpointId,
      { ...endpoint, activeMockCompositionId: compositionId },
      origin,
    );
  }

  private storage(updatedBy?: string | null): SseScriptStorage {
    return {
      get: (key) => this.storageGet(key),
      set: (key, value) => this.storageSet(key, value, updatedBy),
      delete: (key) => this.storageDelete(key),
      compareAndSet: (key, version, value) =>
        this.storageCompareAndSet(key, version, value, updatedBy),
      increment: (key, delta) => this.storageIncrement(key, delta, updatedBy),
    };
  }

  async storageEntries() {
    const prisma = await getPrismaClient();
    const entries = await prisma.sseScriptStorageEntry.findMany({
      orderBy: { key: "asc" },
    });
    return entries.map((entry) => ({
      ...storedValue(entry)!,
      updatedBy: entry.updatedBy,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    }));
  }

  async storageGet(keyValue: string): Promise<SseStoredValue> {
    const prisma = await getPrismaClient();
    return storedValue(
      await prisma.sseScriptStorageEntry.findUnique({
        where: { key: storageKey(keyValue) },
      }),
    );
  }

  async storageSet(
    keyValue: string,
    value: unknown,
    updatedBy?: string | null,
  ): Promise<SseStoredValue> {
    const key = storageKey(keyValue);
    const valueJson = storageValue(value);
    const prisma = await getPrismaClient();
    const entry = await prisma.sseScriptStorageEntry.upsert({
      where: { key },
      create: { key, valueJson, updatedBy: updatedBy ?? null },
      update: {
        valueJson,
        updatedBy: updatedBy ?? null,
        version: { increment: 1 },
      },
    });
    this.changed(SSE_STORAGE_CHANGED_TOPIC, "SET", [key]);
    return storedValue(entry);
  }

  async storageDelete(keyValue: string): Promise<boolean> {
    const key = storageKey(keyValue);
    const prisma = await getPrismaClient();
    const result = await prisma.sseScriptStorageEntry.deleteMany({
      where: { key },
    });
    if (result.count) this.changed(SSE_STORAGE_CHANGED_TOPIC, "DELETED", [key]);
    return result.count > 0;
  }

  async storageCompareAndSet(
    keyValue: string,
    expectedVersion: number | null,
    value: unknown,
    updatedBy?: string | null,
  ): Promise<SseStoredValue> {
    const key = storageKey(keyValue);
    const valueJson = storageValue(value);
    const prisma = await getPrismaClient();
    const entry = await prisma.$transaction(async (transaction) => {
      const current = await transaction.sseScriptStorageEntry.findUnique({
        where: { key },
      });
      if ((current?.version ?? null) !== expectedVersion)
        throw new Error("SSE storage version conflict");
      if (!current)
        return transaction.sseScriptStorageEntry.create({
          data: { key, valueJson, updatedBy: updatedBy ?? null },
        });
      const updated = await transaction.sseScriptStorageEntry.updateMany({
        where: { key, version: expectedVersion! },
        data: {
          valueJson,
          updatedBy: updatedBy ?? null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new Error("SSE storage version conflict");
      return transaction.sseScriptStorageEntry.findUniqueOrThrow({
        where: { key },
      });
    });
    this.changed(SSE_STORAGE_CHANGED_TOPIC, "COMPARE_AND_SET", [key]);
    return storedValue(entry);
  }

  async storageIncrement(
    keyValue: string,
    delta: number,
    updatedBy?: string | null,
  ): Promise<SseStoredValue> {
    if (!Number.isFinite(delta))
      throw new Error("Storage increment must be finite");
    const key = storageKey(keyValue);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await this.storageGet(key);
      const prior = current?.value ?? 0;
      if (typeof prior !== "number" || !Number.isFinite(prior))
        throw new Error("Storage value is not a number");
      try {
        return await this.storageCompareAndSet(
          key,
          current?.version ?? null,
          prior + delta,
          updatedBy,
        );
      } catch (error) {
        if (attempt === 7 || !errorMessage(error).includes("version conflict"))
          throw error;
      }
    }
    throw new Error("SSE storage version conflict");
  }

  async testScript(input: {
    source: string;
    context?: Record<string, unknown> | null;
    timeoutMs?: number | null;
    memoryLimitMb?: number | null;
    fetchTimeoutMs?: number | null;
  }) {
    const initial = new Map(
      (await this.storageEntries()).map((entry) => [
        entry.key,
        { value: entry.value, version: entry.version },
      ]),
    );
    const writes = new Map<string, unknown>();
    const dryStorage: SseScriptStorage = {
      get: async (key) => {
        const value = initial.get(storageKey(key));
        return value ? { key, ...value } : null;
      },
      set: async (key, value) => {
        const normalized = storageKey(key);
        const current = initial.get(normalized);
        const next = { value, version: (current?.version ?? 0) + 1 };
        initial.set(normalized, next);
        writes.set(normalized, value);
        return { key: normalized, ...next };
      },
      delete: async (key) => {
        const normalized = storageKey(key);
        const existed = initial.delete(normalized);
        writes.set(normalized, undefined);
        return existed;
      },
      compareAndSet: async (key, expected, value) => {
        const normalized = storageKey(key);
        const current = initial.get(normalized);
        if ((current?.version ?? null) !== expected)
          throw new Error("SSE storage version conflict");
        return dryStorage.set(normalized, value);
      },
      increment: async (key, delta) => {
        const current = await dryStorage.get(key);
        if (current && typeof current.value !== "number")
          throw new Error("Storage value is not a number");
        return dryStorage.set(key, Number(current?.value ?? 0) + delta);
      },
    };
    const result = await runSseScript({
      source: input.source,
      context: input.context ?? {},
      timeoutMs: numberInRange(
        input.timeoutMs,
        SSE_DEFAULTS.requestScriptTimeoutMs,
        10,
        120_000,
        "Script timeout",
      ),
      memoryLimitMb: numberInRange(
        input.memoryLimitMb,
        SSE_DEFAULTS.scriptMemoryLimitMb,
        8,
        256,
        "Script memory limit",
      ),
      fetchTimeoutMs: numberInRange(
        input.fetchTimeoutMs,
        SSE_DEFAULTS.fetchTimeoutMs,
        100,
        120_000,
        "Fetch timeout",
      ),
      storage: dryStorage,
    });
    return {
      ...result,
      storageWrites: [...writes].map(([key, value]) => ({
        key,
        deleted: value === undefined,
        value,
      })),
    };
  }

  scriptStorage(updatedBy: string): SseScriptStorage {
    return this.storage(updatedBy);
  }

  async openRequest(input: {
    endpoint: SseEndpointSnapshot;
    method: string;
    url: string;
    headers: SseHeader[];
    body: string | null;
  }) {
    const prisma = await getPrismaClient();
    const request = await prisma.sseRequestHistory.create({
      data: {
        id: randomUUID(),
        endpointId: input.endpoint.id,
        endpointName: input.endpoint.name,
        endpointToken: input.endpoint.token,
        mode: input.endpoint.mode,
        method: input.method,
        requestUrl: input.url,
        requestHeadersJson: jsonString(input.headers),
        requestBody: input.body,
        configSnapshotJson: jsonString(input.endpoint),
      },
    });
    this.changed(SSE_HISTORY_CHANGED_TOPIC, "OPENED", [request.id]);
    this.changed(SSE_REQUEST_HISTORY_CHANGED_TOPIC, "OPENED", [request.id]);
    await this.workflow(
      "SSE_REQUEST_OPENED",
      input.endpoint.id,
      `sse-request:${request.id}:opened`,
      {
        endpoint: { id: input.endpoint.id, name: input.endpoint.name },
        request: {
          id: request.id,
          method: input.method,
          url: input.url,
          mode: input.endpoint.mode,
        },
        sessionData: {
          sse: {
            endpoint: { id: input.endpoint.id },
            request: { id: request.id },
          },
        },
      },
    );
    return request;
  }

  async updateEffectiveRequest(
    id: string,
    input: {
      url: string;
      method: string;
      headers: SseHeader[];
      body: string | null;
    },
  ) {
    const prisma = await getPrismaClient();
    return prisma.sseRequestHistory.update({
      where: { id },
      data: {
        effectiveUrl: input.url,
        effectiveMethod: input.method,
        effectiveHeadersJson: jsonString(input.headers),
        effectiveBody: input.body,
      },
    });
  }

  async updateUpstream(id: string, status: number, headers: SseHeader[]) {
    const prisma = await getPrismaClient();
    return prisma.sseRequestHistory.update({
      where: { id },
      data: {
        upstreamStatus: status,
        upstreamHeadersJson: jsonString(headers),
      },
    });
  }

  async updateResponse(id: string, status: number, headers: SseHeader[]) {
    const prisma = await getPrismaClient();
    return prisma.sseRequestHistory.update({
      where: { id },
      data: {
        responseStatus: status,
        responseHeadersJson: jsonString(headers),
      },
    });
  }

  async appendHistoryEvent(input: {
    requestId: string;
    sequence: number;
    logicalIndex: number;
    stage: "SOURCE" | "EMITTED" | "DROPPED";
    correlationId: string;
    eventName: string;
    data: string;
    eventId?: string | null;
    retryMs?: number | null;
    dropped?: boolean;
    split?: boolean;
    fanOutIndex?: number | null;
    limitBytes: number;
    endpointId: string;
    mode: string;
  }) {
    const bytes = Buffer.byteLength(input.data);
    const prisma = await getPrismaClient();
    const event = await prisma.$transaction(async (transaction) => {
      const request = await transaction.sseRequestHistory.findUniqueOrThrow({
        where: { id: input.requestId },
      });
      const truncated = request.storedBytes + bytes > input.limitBytes;
      const created = await transaction.sseHistoryEvent.create({
        data: {
          id: randomUUID(),
          requestId: input.requestId,
          sequence: input.sequence,
          logicalIndex: input.logicalIndex,
          stage: input.stage,
          correlationId: input.correlationId,
          eventName: input.eventName || "text",
          data: truncated ? "" : input.data,
          eventId: input.eventId ?? null,
          retryMs: input.retryMs ?? null,
          dropped: input.dropped ?? false,
          split: input.split ?? false,
          fanOutIndex: input.fanOutIndex ?? null,
          truncated,
        },
      });
      await transaction.sseRequestHistory.update({
        where: { id: input.requestId },
        data: {
          storedBytes: truncated ? undefined : { increment: bytes },
          truncated: truncated || request.truncated,
          firstEventAt: request.firstEventAt ?? new Date(),
        },
      });
      return created;
    });
    if (event) {
      this.changed(SSE_HISTORY_CHANGED_TOPIC, "EVENT", [
        input.requestId,
        event.id,
      ]);
      this.changed(SSE_EVENT_HISTORY_CHANGED_TOPIC, "EVENT", [
        input.requestId,
        event.id,
      ]);
      if (input.stage === "EMITTED") {
        await this.workflow(
          "SSE_EVENT_EMITTED",
          input.endpointId,
          `sse-event:${event.id}`,
          {
            endpoint: { id: input.endpointId },
            request: { id: input.requestId, mode: input.mode },
            event: {
              id: event.id,
              name: event.eventName,
              data: input.data,
              sseId: event.eventId,
              truncated: event.truncated,
            },
            sessionData: {
              sse: {
                endpoint: { id: input.endpointId },
                request: { id: input.requestId },
                event: { id: event.id },
              },
            },
          },
        );
      }
    }
    return event;
  }

  async backfillEventId(requestId: string, eventId: string): Promise<number> {
    const prisma = await getPrismaClient();
    const count = (
      await prisma.sseHistoryEvent.updateMany({
        where: { requestId, eventId: null },
        data: { eventId },
      })
    ).count;
    if (count) {
      this.changed(SSE_HISTORY_CHANGED_TOPIC, "EVENT_IDS_BACKFILLED", [
        requestId,
      ]);
      this.changed(SSE_EVENT_HISTORY_CHANGED_TOPIC, "IDS_BACKFILLED", [
        requestId,
      ]);
    }
    return count;
  }

  async completeRequest(
    id: string,
    outcome = "COMPLETED",
    error?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const current = await prisma.sseRequestHistory.findUniqueOrThrow({
      where: { id },
    });
    const finishedAt = new Date();
    const value = await prisma.sseRequestHistory.update({
      where: { id },
      data: {
        status: error ? "FAILED" : "COMPLETED",
        outcome,
        error: error ?? null,
        finishedAt,
        durationMs: Math.max(
          0,
          finishedAt.getTime() - current.startedAt.getTime(),
        ),
      },
    });
    this.changed(SSE_HISTORY_CHANGED_TOPIC, error ? "FAILED" : "COMPLETED", [
      id,
    ]);
    this.changed(
      SSE_REQUEST_HISTORY_CHANGED_TOPIC,
      error ? "FAILED" : "COMPLETED",
      [id],
    );
    await this.workflow(
      error ? "SSE_STREAM_FAILED" : "SSE_STREAM_COMPLETED",
      current.endpointId ?? current.endpointToken,
      `sse-request:${id}:${error ? "failed" : "completed"}`,
      {
        endpoint: { id: current.endpointId, name: current.endpointName },
        request: { id, mode: current.mode, outcome, error: error ?? null },
        sessionData: {
          sse: { endpoint: { id: current.endpointId }, request: { id } },
        },
      },
    );
    void this.maintain().catch((maintenanceError) =>
      console.error("Failed to maintain SSE history", maintenanceError),
    );
    return value;
  }

  async createBreakpoint(requestId: string, endpoint: SseEndpointSnapshot) {
    const prisma = await getPrismaClient();
    const value = await prisma.sseBreakpoint.create({
      data: {
        id: randomUUID(),
        requestId,
        endpointId: endpoint.id,
        expiresAt: new Date(Date.now() + endpoint.breakpointTimeoutMs),
      },
      include: { request: true },
    });
    this.changed(SSE_BREAKPOINTS_CHANGED_TOPIC, "WAITING", [value.id]);
    await this.workflow(
      "SSE_BREAKPOINT_WAITING",
      endpoint.id,
      `sse-breakpoint:${value.id}:waiting`,
      {
        endpoint: { id: endpoint.id, name: endpoint.name },
        request: { id: requestId, mode: endpoint.mode },
        breakpoint: {
          id: value.id,
          version: value.version,
          expiresAt: value.expiresAt.toISOString(),
        },
        sessionData: {
          sse: {
            endpoint: { id: endpoint.id },
            request: { id: requestId },
            breakpoint: { id: value.id },
          },
        },
      },
    );
    return this.breakpointView(value);
  }

  private breakpointView(
    value: Prisma.SseBreakpointGetPayload<{ include: { request: true } }>,
  ) {
    return {
      ...value,
      adHocComposition: json(value.adHocCompositionJson, null),
      request: this.requestView(value.request),
      expiresAt: value.expiresAt.toISOString(),
      resolvedAt: value.resolvedAt?.toISOString() ?? null,
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    };
  }

  async breakpoints(status?: string | null) {
    const prisma = await getPrismaClient();
    const values = await prisma.sseBreakpoint.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      include: { request: true },
    });
    return values.map((value) => this.breakpointView(value));
  }

  async resolveBreakpoint(input: SseBreakpointResolutionInput) {
    const prisma = await getPrismaClient();
    const current = await prisma.sseBreakpoint.findUnique({
      where: { id: input.id },
      include: { request: true },
    });
    if (!current) throw new Error("SSE breakpoint not found");
    if (input.resolution === "SAVED_MOCK") {
      if (!input.mockCompositionId)
        throw new Error("A saved mock composition is required");
      const composition = await prisma.sseMockComposition.findFirst({
        where: {
          id: input.mockCompositionId,
          endpointId: current.endpointId ?? undefined,
        },
      });
      if (!composition)
        throw new Error("Mock composition does not belong to this endpoint");
    }
    if (input.resolution === "AD_HOC" && !input.adHocComposition)
      throw new Error("An ad hoc composition is required");
    const resolvedAt = new Date();
    const update = await prisma.sseBreakpoint.updateMany({
      where: { id: input.id, status: "WAITING", version: input.version },
      data: {
        status: "RESOLVED",
        version: { increment: 1 },
        resolution: input.resolution,
        mockCompositionId:
          input.resolution === "SAVED_MOCK" ? input.mockCompositionId : null,
        adHocCompositionJson:
          input.resolution === "AD_HOC"
            ? jsonString(input.adHocComposition)
            : null,
        resolvedAt,
      },
    });
    if (update.count !== 1) throw new Error("SSE breakpoint version conflict");
    await prisma.sseRequestHistory.update({
      where: { id: current.requestId },
      data: { breakpointResolution: input.resolution },
    });
    const value = await prisma.sseBreakpoint.findUniqueOrThrow({
      where: { id: input.id },
      include: { request: true },
    });
    this.changed(SSE_BREAKPOINTS_CHANGED_TOPIC, "RESOLVED", [value.id]);
    await this.workflow(
      "SSE_BREAKPOINT_RESOLVED",
      current.endpointId ?? current.request.endpointToken,
      `sse-breakpoint:${value.id}:resolved`,
      {
        endpoint: {
          id: current.endpointId,
          name: current.request.endpointName,
        },
        request: { id: current.requestId, mode: current.request.mode },
        breakpoint: { id: value.id, resolution: value.resolution },
        sessionData: {
          sse: {
            endpoint: { id: current.endpointId },
            request: { id: current.requestId },
            breakpoint: { id: value.id },
          },
        },
      },
    );
    return this.breakpointView(value);
  }

  async waitForBreakpoint(id: string, signal?: AbortSignal) {
    const prisma = await getPrismaClient();
    while (!signal?.aborted) {
      const value = await prisma.sseBreakpoint.findUnique({
        where: { id },
        include: {
          request: true,
          mockComposition: {
            include: { blocks: { include: { template: true } } },
          },
        },
      });
      if (!value) throw new Error("SSE breakpoint was deleted");
      if (value.status === "RESOLVED") {
        return {
          resolution: value.resolution as "FORWARD" | "SAVED_MOCK" | "AD_HOC",
          composition:
            value.resolution === "SAVED_MOCK"
              ? resolvedComposition(value.mockComposition)
              : value.resolution === "AD_HOC"
                ? json<SseMockCompositionInput | null>(
                    value.adHocCompositionJson,
                    null,
                  )
                : null,
        };
      }
      if (Date.now() >= value.expiresAt.getTime()) {
        await prisma.sseBreakpoint.updateMany({
          where: { id, status: "WAITING" },
          data: {
            status: "TIMED_OUT",
            version: { increment: 1 },
            resolvedAt: new Date(),
          },
        });
        this.changed(SSE_BREAKPOINTS_CHANGED_TOPIC, "TIMED_OUT", [id]);
        throw new Error("SSE breakpoint timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await prisma.sseBreakpoint.updateMany({
      where: { id, status: "WAITING" },
      data: {
        status: "CANCELLED",
        version: { increment: 1 },
        resolvedAt: new Date(),
      },
    });
    this.changed(SSE_BREAKPOINTS_CHANGED_TOPIC, "CANCELLED", [id]);
    throw new Error("SSE client disconnected while waiting at a breakpoint");
  }

  private requestView(
    value: Prisma.SseRequestHistoryGetPayload<Record<string, never>>,
  ) {
    const expanded = value as typeof value & {
      _count?: { events?: number };
      events?: unknown[];
    };
    const { _count, ...record } = expanded;
    return {
      ...record,
      eventCount: _count?.events ?? expanded.events?.length ?? 0,
      requestHeaders: json<SseHeader[]>(value.requestHeadersJson, []),
      effectiveHeaders: json<SseHeader[]>(value.effectiveHeadersJson, []),
      upstreamHeaders: json<SseHeader[]>(value.upstreamHeadersJson, []),
      responseHeaders: json<SseHeader[]>(value.responseHeadersJson, []),
      configSnapshot: json(value.configSnapshotJson, {}),
      startedAt: value.startedAt.toISOString(),
      firstEventAt: value.firstEventAt?.toISOString() ?? null,
      finishedAt: value.finishedAt?.toISOString() ?? null,
    };
  }

  private eventView(
    value: Prisma.SseHistoryEventGetPayload<{ include: { request: true } }>,
  ) {
    return {
      ...value,
      createdAt: value.createdAt.toISOString(),
      request: this.requestView(value.request),
    };
  }

  async history(input: SseHistoryQueryInput = {}) {
    const view = oneOf(
      input.view,
      SSE_HISTORY_VIEWS,
      "STREAMS",
      "History view",
    );
    const first = numberInRange(input.first, 100, 1, 500, "Page size");
    const offset = cursorOffset(input.after);
    const prisma = await getPrismaClient();
    const requestWhere: Prisma.SseRequestHistoryWhereInput = {
      endpointId: input.endpointId ?? undefined,
      mode: input.modes?.length ? { in: input.modes } : undefined,
      status: input.statuses?.length ? { in: input.statuses } : undefined,
    };
    if (view === "STREAMS") {
      if (input.search) {
        const [totalCount, allValues] = await Promise.all([
          prisma.sseRequestHistory.count({ where: requestWhere }),
          prisma.sseRequestHistory.findMany({
            where: requestWhere,
            orderBy: [{ startedAt: "desc" }, { id: "desc" }],
            include: { _count: { select: { events: true } } },
          }),
        ]);
        const filtered = this.search(
          allValues.map((value) => this.requestView(value)),
          input,
        );
        return {
          view,
          streams: filtered.slice(offset, offset + first),
          events: [],
          nextCursor:
            offset + first < filtered.length
              ? Buffer.from(String(offset + first)).toString("base64url")
              : null,
          matchingCount: filtered.length,
          totalCount,
        };
      }
      const [totalCount, values] = await Promise.all([
        prisma.sseRequestHistory.count({ where: requestWhere }),
        prisma.sseRequestHistory.findMany({
          where: requestWhere,
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          skip: offset,
          take: first + 1,
          include: { _count: { select: { events: true } } },
        }),
      ]);
      const filtered = this.search(
        values.map((value) => this.requestView(value)),
        input,
      );
      const hasNext = values.length > first;
      return {
        view,
        streams: filtered.slice(0, first),
        events: [],
        nextCursor: hasNext
          ? Buffer.from(String(offset + first)).toString("base64url")
          : null,
        matchingCount: totalCount,
        totalCount,
      };
    }
    const eventWhere: Prisma.SseHistoryEventWhereInput = {
      request: requestWhere,
      eventName: input.eventNames?.length
        ? { in: input.eventNames }
        : undefined,
      stage: input.stages?.length ? { in: input.stages } : undefined,
    };
    if (input.search) {
      const [totalCount, allValues] = await Promise.all([
        prisma.sseHistoryEvent.count({ where: eventWhere }),
        prisma.sseHistoryEvent.findMany({
          where: eventWhere,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: { request: true },
        }),
      ]);
      const filtered = this.search(
        allValues.map((value) => this.eventView(value)),
        input,
      );
      return {
        view,
        streams: [],
        events: filtered.slice(offset, offset + first),
        nextCursor:
          offset + first < filtered.length
            ? Buffer.from(String(offset + first)).toString("base64url")
            : null,
        matchingCount: filtered.length,
        totalCount,
      };
    }
    const [totalCount, values] = await Promise.all([
      prisma.sseHistoryEvent.count({ where: eventWhere }),
      prisma.sseHistoryEvent.findMany({
        where: eventWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: first + 1,
        include: { request: true },
      }),
    ]);
    const filtered = this.search(
      values.map((value) => this.eventView(value)),
      input,
    );
    const hasNext = values.length > first;
    return {
      view,
      streams: [],
      events: filtered.slice(0, first),
      nextCursor: hasNext
        ? Buffer.from(String(offset + first)).toString("base64url")
        : null,
      matchingCount: totalCount,
      totalCount,
    };
  }

  async exportHistory(
    input: SseHistoryQueryInput = {},
    format: "JSON" | "CSV" | "MARKDOWN" = "JSON",
  ) {
    const rows: Array<Record<string, unknown>> = [];
    let after: string | null = null;
    do {
      const page = await this.history({ ...input, first: 500, after });
      rows.push(
        ...((page.view === "STREAMS" ? page.streams : page.events) as Array<
          Record<string, unknown>
        >),
      );
      after = page.nextCursor;
    } while (after);

    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const scalar = (value: unknown): string => {
      if (value === null || value === undefined) return "";
      return typeof value === "object" ? jsonString(value) : String(value);
    };
    let content: string;
    if (format === "CSV") {
      const quote = (value: unknown) =>
        `"${scalar(value).replaceAll('"', '""')}"`;
      content = [
        columns.map(quote).join(","),
        ...rows.map((row) =>
          columns.map((column) => quote(row[column])).join(","),
        ),
      ].join("\n");
    } else if (format === "MARKDOWN") {
      const cell = (value: unknown) =>
        scalar(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
      content = [
        `| ${columns.map(cell).join(" | ")} |`,
        `| ${columns.map(() => "---").join(" | ")} |`,
        ...rows.map(
          (row) =>
            `| ${columns.map((column) => cell(row[column])).join(" | ")} |`,
        ),
      ].join("\n");
    } else {
      content = JSON.stringify(rows, null, 2);
    }
    return { format, content, rowCount: rows.length };
  }

  private search<T>(values: T[], input: SseHistoryQueryInput): T[] {
    if (!input.search) return values;
    const source = input.caseSensitive
      ? input.search
      : input.search.toLocaleLowerCase();
    const pattern =
      input.searchMode === "REGEX"
        ? new RegExp(input.search, input.caseSensitive ? "" : "i")
        : null;
    const glob =
      input.searchMode === "GLOB"
        ? new RegExp(
            `^${input.search
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replaceAll("*", ".*")
              .replaceAll("?", ".")}$`,
            input.caseSensitive ? "" : "i",
          )
        : null;
    return values.filter((value) => {
      const text = jsonString(value);
      if (pattern) return pattern.test(text);
      if (glob) return glob.test(text);
      return (input.caseSensitive ? text : text.toLocaleLowerCase()).includes(
        source,
      );
    });
  }

  async historyRequest(id: string) {
    const prisma = await getPrismaClient();
    const value = await prisma.sseRequestHistory.findUnique({
      where: { id },
      include: { events: { orderBy: { sequence: "asc" } } },
    });
    if (!value) return null;
    return {
      ...this.requestView(value),
      events: value.events.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  async clearHistory(input: {
    ids?: string[] | null;
    endpointId?: string | null;
  }): Promise<number> {
    const prisma = await getPrismaClient();
    const result = await prisma.sseRequestHistory.deleteMany({
      where: input.ids?.length
        ? { id: { in: input.ids }, status: { not: "OPEN" } }
        : {
            endpointId: input.endpointId ?? undefined,
            status: { not: "OPEN" },
          },
    });
    if (result.count)
      this.changed(SSE_HISTORY_CHANGED_TOPIC, "CLEARED", input.ids ?? []);
    if (result.count) {
      this.changed(
        SSE_REQUEST_HISTORY_CHANGED_TOPIC,
        "CLEARED",
        input.ids ?? [],
      );
      this.changed(SSE_EVENT_HISTORY_CHANGED_TOPIC, "CLEARED", input.ids ?? []);
    }
    return result.count;
  }

  async historyFacets() {
    const prisma = await getPrismaClient();
    const [endpoints, modes, statuses, events] = await Promise.all([
      prisma.sseRequestHistory.findMany({
        distinct: ["endpointId"],
        select: { endpointId: true, endpointName: true },
      }),
      prisma.sseRequestHistory.findMany({
        distinct: ["mode"],
        select: { mode: true },
      }),
      prisma.sseRequestHistory.findMany({
        distinct: ["status"],
        select: { status: true },
      }),
      prisma.sseHistoryEvent.findMany({
        distinct: ["eventName"],
        select: { eventName: true },
      }),
    ]);
    return {
      endpoints,
      modes: modes.map(({ mode }) => mode),
      statuses: statuses.map(({ status }) => status),
      eventNames: events.map(({ eventName }) => eventName),
    };
  }

  async historyFacetsPage(input: CursorPageInput = {}) {
    const prisma = await getPrismaClient();
    const [endpoints, modes, statuses, eventNames] = await Promise.all([
      prisma.sseRequestHistory.groupBy({
        by: ["endpointId", "endpointName"],
        _count: { _all: true },
      }),
      prisma.sseRequestHistory.groupBy({
        by: ["mode"],
        _count: { _all: true },
      }),
      prisma.sseRequestHistory.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),
      prisma.sseHistoryEvent.groupBy({
        by: ["eventName"],
        _count: { _all: true },
      }),
    ]);
    const nodes = [
      ...endpoints.map((value) => ({
        kind: "ENDPOINT",
        value: value.endpointId ?? value.endpointName,
        label: value.endpointName,
        endpointId: value.endpointId,
        count: value._count._all,
      })),
      ...modes.map((value) => ({
        kind: "MODE",
        value: value.mode,
        label: value.mode,
        endpointId: null,
        count: value._count._all,
      })),
      ...statuses.map((value) => ({
        kind: "STATUS",
        value: value.status,
        label: value.status,
        endpointId: null,
        count: value._count._all,
      })),
      ...eventNames.map((value) => ({
        kind: "EVENT_NAME",
        value: value.eventName,
        label: value.eventName,
        endpointId: null,
        count: value._count._all,
      })),
    ].sort((first, second) =>
      `${first.kind}:${first.label}`.localeCompare(
        `${second.kind}:${second.label}`,
      ),
    );
    return cursorPage(nodes, input);
  }

  private defaultColumns(view: string): string[] {
    return view === "EVENTS"
      ? [
          "endpoint",
          "createdAt",
          "eventName",
          "stage",
          "eventId",
          "data",
          "sequence",
          "mode",
        ]
      : [
          "endpoint",
          "startedAt",
          "method",
          "mode",
          "status",
          "responseStatus",
          "eventCount",
          "duration",
          "storedBytes",
        ];
  }

  async historyViewSettings(viewValue: string) {
    const view = oneOf(viewValue, SSE_HISTORY_VIEWS, "STREAMS", "History view");
    const prisma = await getPrismaClient();
    const value = await prisma.sseHistoryViewSettings.upsert({
      where: { view },
      create: { view, columnsJson: jsonString(this.defaultColumns(view)) },
      update: {},
    });
    return {
      ...value,
      columns: json<string[]>(value.columnsJson, this.defaultColumns(view)),
    };
  }

  async saveHistoryViewSettings(input: {
    view: string;
    columns?: string[] | null;
    timeFormat?: string | null;
    activeColumnPresetId?: string | null;
    activeSavedFilterId?: string | null;
  }) {
    const view = oneOf(
      input.view,
      SSE_HISTORY_VIEWS,
      "STREAMS",
      "History view",
    );
    const prisma = await getPrismaClient();
    const current = await this.historyViewSettings(view);
    await prisma.sseHistoryViewSettings.update({
      where: { view },
      data: {
        columnsJson: jsonString(input.columns ?? current.columns),
        timeFormat: input.timeFormat ?? current.timeFormat,
        activeColumnPresetId:
          input.activeColumnPresetId === undefined
            ? current.activeColumnPresetId
            : input.activeColumnPresetId,
        activeSavedFilterId:
          input.activeSavedFilterId === undefined
            ? current.activeSavedFilterId
            : input.activeSavedFilterId,
      },
    });
    this.changed(SSE_HISTORY_CHANGED_TOPIC, "VIEW_SETTINGS", [view]);
    return this.historyViewSettings(view);
  }

  async historyColumnPresets(viewValue: string) {
    const view = oneOf(viewValue, SSE_HISTORY_VIEWS, "STREAMS", "History view");
    const prisma = await getPrismaClient();
    const values = await prisma.sseHistoryColumnPreset.findMany({
      where: { view },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    return values.map((value) => ({
      ...value,
      columns: json<string[]>(value.columnsJson, []),
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    }));
  }

  async saveHistoryColumnPreset(input: {
    id?: string | null;
    view: string;
    name: string;
    columns: string[];
    isDefault?: boolean | null;
  }) {
    const view = oneOf(
      input.view,
      SSE_HISTORY_VIEWS,
      "STREAMS",
      "History view",
    );
    if (!input.columns.length)
      throw new Error("Select at least one history column");
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
      if (input.isDefault) {
        await transaction.sseHistoryColumnPreset.updateMany({
          where: { view },
          data: { isDefault: false },
        });
      }
      await transaction.sseHistoryColumnPreset.upsert({
        where: { id },
        create: {
          id,
          view,
          name: cleanName(input.name, "Preset name"),
          columnsJson: jsonString(input.columns),
          isDefault: input.isDefault ?? false,
        },
        update: {
          view,
          name: cleanName(input.name, "Preset name"),
          columnsJson: jsonString(input.columns),
          isDefault: input.isDefault ?? false,
        },
      });
    });
    this.changed(SSE_HISTORY_CHANGED_TOPIC, "COLUMN_PRESET", [id]);
    return (await this.historyColumnPresets(view)).find(
      (value) => value.id === id,
    )!;
  }

  async deleteHistoryColumnPreset(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.sseHistoryViewSettings.updateMany({
      where: { activeColumnPresetId: id },
      data: { activeColumnPresetId: null },
    });
    const result = await prisma.sseHistoryColumnPreset.deleteMany({
      where: { id },
    });
    if (result.count)
      this.changed(SSE_HISTORY_CHANGED_TOPIC, "COLUMN_PRESET_DELETED", [id]);
    return result.count > 0;
  }

  async historySavedFilters(viewValue: string) {
    const view = oneOf(viewValue, SSE_HISTORY_VIEWS, "STREAMS", "History view");
    const prisma = await getPrismaClient();
    const values = await prisma.sseHistorySavedFilter.findMany({
      where: { view },
      orderBy: { name: "asc" },
    });
    return values.map((value) => ({
      ...value,
      definition: json(value.definitionJson, {}),
      createdAt: value.createdAt.toISOString(),
      updatedAt: value.updatedAt.toISOString(),
    }));
  }

  async saveHistorySavedFilter(input: {
    id?: string | null;
    view: string;
    name: string;
    definition: unknown;
  }) {
    const view = oneOf(
      input.view,
      SSE_HISTORY_VIEWS,
      "STREAMS",
      "History view",
    );
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    await prisma.sseHistorySavedFilter.upsert({
      where: { id },
      create: {
        id,
        view,
        name: cleanName(input.name, "Filter name"),
        definitionJson: jsonString(input.definition),
      },
      update: {
        view,
        name: cleanName(input.name, "Filter name"),
        definitionJson: jsonString(input.definition),
      },
    });
    this.changed(SSE_HISTORY_CHANGED_TOPIC, "SAVED_FILTER", [id]);
    return (await this.historySavedFilters(view)).find(
      (value) => value.id === id,
    )!;
  }

  async deleteHistorySavedFilter(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.sseHistoryViewSettings.updateMany({
      where: { activeSavedFilterId: id },
      data: { activeSavedFilterId: null },
    });
    const result = await prisma.sseHistorySavedFilter.deleteMany({
      where: { id },
    });
    if (result.count)
      this.changed(SSE_HISTORY_CHANGED_TOPIC, "SAVED_FILTER_DELETED", [id]);
    return result.count > 0;
  }

  subscribeEndpoints() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      SSE_ENDPOINTS_CHANGED_TOPIC,
    );
  }
  subscribeStorage() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      SSE_STORAGE_CHANGED_TOPIC,
    );
  }
  subscribeBreakpoints() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      SSE_BREAKPOINTS_CHANGED_TOPIC,
    );
  }
  subscribeHistory() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      SSE_HISTORY_CHANGED_TOPIC,
    );
  }
  subscribeRequestHistory() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      SSE_REQUEST_HISTORY_CHANGED_TOPIC,
    );
  }
  subscribeEventHistory() {
    return agentEventBus.iterate<{ reason: string; ids: string[] }>(
      SSE_EVENT_HISTORY_CHANGED_TOPIC,
    );
  }

  async maintain(): Promise<void> {
    if (Date.now() < this.nextMaintenanceAt) return;
    this.nextMaintenanceAt = Date.now() + MAINTENANCE_INTERVAL_MS;
    const prisma = await getPrismaClient();

    const expiredBreakpoints = await prisma.sseBreakpoint.findMany({
      where: { status: "WAITING", expiresAt: { lte: new Date() } },
      select: {
        id: true,
        requestId: true,
        request: {
          select: {
            endpointId: true,
            endpointName: true,
            endpointToken: true,
            mode: true,
            startedAt: true,
          },
        },
      },
    });
    if (expiredBreakpoints.length) {
      const finishedAt = new Date();
      const ids = expiredBreakpoints.map(({ id }) => id);
      const requestIds = expiredBreakpoints.map(({ requestId }) => requestId);
      await prisma.$transaction([
        prisma.sseBreakpoint.updateMany({
          where: { id: { in: ids }, status: "WAITING" },
          data: {
            status: "TIMED_OUT",
            version: { increment: 1 },
            resolvedAt: finishedAt,
          },
        }),
        ...expiredBreakpoints.map((breakpoint) =>
          prisma.sseRequestHistory.updateMany({
            where: { id: breakpoint.requestId, status: "OPEN" },
            data: {
              status: "FAILED",
              outcome: "BREAKPOINT_ORPHANED",
              error: "SSE breakpoint expired without an active runtime waiter",
              finishedAt,
              durationMs: Math.max(
                0,
                finishedAt.getTime() - breakpoint.request.startedAt.getTime(),
              ),
            },
          }),
        ),
      ]);
      this.changed(SSE_BREAKPOINTS_CHANGED_TOPIC, "TIMED_OUT", ids);
      this.changed(SSE_HISTORY_CHANGED_TOPIC, "FAILED", requestIds);
      this.changed(SSE_REQUEST_HISTORY_CHANGED_TOPIC, "FAILED", requestIds);
      for (const breakpoint of expiredBreakpoints) {
        await this.workflow(
          "SSE_STREAM_FAILED",
          breakpoint.request.endpointId ?? breakpoint.request.endpointToken,
          `sse-request:${breakpoint.requestId}:failed`,
          {
            endpoint: {
              id: breakpoint.request.endpointId,
              name: breakpoint.request.endpointName,
            },
            request: {
              id: breakpoint.requestId,
              mode: breakpoint.request.mode,
              outcome: "BREAKPOINT_ORPHANED",
              error: "SSE breakpoint expired without an active runtime waiter",
            },
            sessionData: {
              sse: {
                endpoint: { id: breakpoint.request.endpointId },
                request: { id: breakpoint.requestId },
              },
            },
          },
        );
      }
    }

    const endpoints = await prisma.sseEndpoint.findMany({
      select: { id: true, retentionDays: true, retentionEventLimit: true },
    });
    for (const endpoint of endpoints) {
      while (true) {
        const expired = await prisma.sseRequestHistory.findMany({
          where: {
            endpointId: endpoint.id,
            finishedAt: {
              not: null,
              lt: new Date(Date.now() - endpoint.retentionDays * 86_400_000),
            },
          },
          orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
          select: { id: true },
          take: 1_000,
        });
        if (!expired.length) break;
        await prisma.sseRequestHistory.deleteMany({
          where: { id: { in: expired.map(({ id }) => id) } },
        });
        const expiredIds = expired.map(({ id }) => id);
        this.changed(SSE_HISTORY_CHANGED_TOPIC, "RETAINED", expiredIds);
        this.changed(SSE_REQUEST_HISTORY_CHANGED_TOPIC, "RETAINED", expiredIds);
        this.changed(SSE_EVENT_HISTORY_CHANGED_TOPIC, "RETAINED", expiredIds);
      }

      let eventCount = await prisma.sseHistoryEvent.count({
        where: { request: { endpointId: endpoint.id } },
      });
      while (eventCount > endpoint.retentionEventLimit) {
        const oldest = await prisma.sseRequestHistory.findMany({
          where: {
            endpointId: endpoint.id,
            finishedAt: { not: null },
          },
          orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
          take: 100,
          select: { id: true, _count: { select: { events: true } } },
        });
        if (!oldest.length) break;
        const ids: string[] = [];
        let removedEvents = 0;
        for (const request of oldest) {
          ids.push(request.id);
          removedEvents += request._count.events;
          if (eventCount - removedEvents <= endpoint.retentionEventLimit) break;
        }
        await prisma.sseRequestHistory.deleteMany({
          where: { id: { in: ids } },
        });
        eventCount -= removedEvents;
        this.changed(SSE_HISTORY_CHANGED_TOPIC, "RETAINED", ids);
        this.changed(SSE_REQUEST_HISTORY_CHANGED_TOPIC, "RETAINED", ids);
        this.changed(SSE_EVENT_HISTORY_CHANGED_TOPIC, "RETAINED", ids);
      }
    }
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
