import "server-only";

import { randomUUID } from "node:crypto";

import { runSseScript } from "./script-runner";
import { renderSseParameterizedTemplate } from "./mock-template";
import { encodeSseEvent, SseEventNormalizer, SseParser } from "./sse-parser";
import type { SseService } from "./sse.service";
import {
  validateSseStreamingStatus,
  type SseEndpointSnapshot,
  type SseEvent,
  type SseHeader,
  type SseMockCompositionInput,
  type SseResolvedComposition,
  type SseScriptEventResult,
  type SseSplitDirective,
} from "./types";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);
const MAX_ERROR_BODY_BYTES = 2 * 1024 * 1024;
const TRANSFORMED_BODY_HEADERS = [
  "content-encoding",
  "content-md5",
  "content-range",
  "digest",
  "etag",
] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function headerList(headers: Headers): SseHeader[] {
  const values: SseHeader[] = [];
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") values.push({ name, value });
  });
  const setCookies =
    (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  for (const value of setCookies) values.push({ name: "set-cookie", value });
  return values;
}

function safeHeaders(values: SseHeader[], includeContentType = true): Headers {
  const headers = new Headers();
  for (const { name, value } of values) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (!includeContentType && lower === "content-type") continue;
    headers.append(name, value);
  }
  return headers;
}

function sseHeaders(values: SseHeader[]): Headers {
  const headers = safeHeaders(values, false);
  for (const name of TRANSFORMED_BODY_HEADERS) headers.delete(name);
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.set("access-control-allow-origin", "*");
  headers.set("vary", "origin");
  return headers;
}

function corsError(status: number, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    },
  );
}

async function requestBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error("SSE request body exceeded the configured limit");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("SSE request body exceeded the configured limit");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function requestBodyContext(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON request bodies remain available as text and base64.
  }
  return {
    text,
    base64: Buffer.from(bytes).toString("base64"),
    json: parsed,
    byteLength: bytes.byteLength,
  };
}

function normalizeScriptHeaders(value: unknown): SseHeader[] {
  if (!Array.isArray(value))
    throw new Error("Script headers must be a HeaderBag or header array");
  return value.map((header) => {
    if (!header || typeof header !== "object")
      throw new Error("Script returned an invalid header");
    const { name, value } = header as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || typeof value !== "string")
      throw new Error("Script returned an invalid header");
    new Headers([[name, value]]);
    return { name, value };
  });
}

function normalizeEvent(value: unknown): SseEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SSE script events must be objects");
  }
  const event = value as Record<string, unknown>;
  if (typeof event.data !== "string")
    throw new Error("SSE script event data must be a string");
  if (event.event != null && typeof event.event !== "string")
    throw new Error("SSE event name must be a string");
  if (event.id != null && typeof event.id !== "string")
    throw new Error("SSE event ID must be a string");
  if (
    event.retry != null &&
    (!Number.isInteger(event.retry) || Number(event.retry) < 0)
  ) {
    throw new Error("SSE event retry must be a non-negative integer");
  }
  if (event.dispatch != null && typeof event.dispatch !== "boolean") {
    throw new Error("SSE event dispatch must be a boolean");
  }
  return {
    event: (event.event as string | null | undefined) ?? null,
    data: event.data,
    id: event.id as string | null | undefined,
    retry: event.retry as number | null | undefined,
    dispatch: event.dispatch as boolean | undefined,
  };
}

function eventResult(
  value: unknown,
  fallback: SseEvent,
): { events: SseEvent[]; splits: SseSplitDirective[]; dropped: boolean } {
  if (value === undefined)
    return { events: [fallback], splits: [], dropped: false };
  if (value === null) return { events: [], splits: [], dropped: true };
  let eventsValue: unknown = value;
  let splits: SseSplitDirective[] = [];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("events" in value || "split" in value || "splits" in value)
  ) {
    const structured = value as SseScriptEventResult;
    eventsValue = "events" in value ? structured.events : fallback;
    const singleOrMany =
      structured.split == null
        ? []
        : Array.isArray(structured.split)
          ? structured.split
          : [structured.split];
    splits = [...singleOrMany, ...(structured.splits ?? [])];
  }
  if (eventsValue === null) return { events: [], splits, dropped: true };
  const events = (Array.isArray(eventsValue) ? eventsValue : [eventsValue]).map(
    normalizeEvent,
  );
  return { events, splits, dropped: events.length === 0 };
}

async function boundedResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ERROR_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Upstream error body exceeded 2 MiB");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchWithRedirectLimit(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let current = new URL(url);
  let method = init.method ?? "GET";
  let body = init.body;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(current, {
      ...init,
      method,
      body,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === 5)
      throw new Error("SSE upstream exceeded five redirects");
    current = new URL(location, current);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method.toUpperCase() === "POST")
    ) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("SSE upstream redirect failed");
}

type EffectiveRequest = {
  url: string;
  method: string;
  headers: SseHeader[];
  body: string | null;
};

type StreamState = {
  sequence: number;
  logicalIndex: number;
  inheritedId: string | null;
};

class EventPipeline {
  private readonly sourceHistory: SseEventNormalizer;
  private readonly emittedHistory: SseEventNormalizer;
  private readonly delivery: SseEventNormalizer;
  private readonly state: StreamState = {
    sequence: 0,
    logicalIndex: 0,
    inheritedId: null,
  };
  private committedResponse: { status: number; headers: SseHeader[] };

  constructor(
    private readonly service: SseService,
    private readonly endpoint: SseEndpointSnapshot,
    private readonly requestId: string,
    private readonly scriptRequest: Record<string, unknown>,
    response: { status: number; headers: SseHeader[] },
    private readonly enqueue: (chunk: Uint8Array) => Promise<void>,
  ) {
    this.sourceHistory = new SseEventNormalizer(endpoint.historyBufferMode);
    this.emittedHistory = new SseEventNormalizer(endpoint.historyBufferMode);
    this.delivery = new SseEventNormalizer(endpoint.deliveryBufferMode);
    this.committedResponse = structuredClone(response);
  }

  private effectiveId(event: SseEvent): SseEvent {
    if (event.id !== undefined && event.id !== null) {
      if (event.id === "") this.state.inheritedId = null;
      else this.state.inheritedId = event.id;
    }
    return {
      ...event,
      id:
        event.id === ""
          ? ""
          : (event.id ?? this.state.inheritedId ?? undefined),
    };
  }

  private async record(
    stage: "SOURCE" | "EMITTED" | "DROPPED",
    event: SseEvent,
    correlationId: string,
    extra: {
      dropped?: boolean;
      split?: boolean;
      fanOutIndex?: number | null;
    } = {},
  ) {
    await this.service.appendHistoryEvent({
      requestId: this.requestId,
      sequence: this.state.sequence++,
      logicalIndex: this.state.logicalIndex++,
      stage,
      correlationId,
      eventName: event.event || "text",
      data: event.data,
      eventId: event.id ?? null,
      retryMs: event.retry,
      dropped: extra.dropped,
      split: extra.split,
      fanOutIndex: extra.fanOutIndex,
      limitBytes: this.endpoint.streamHistoryLimitBytes,
      limitRecords: this.endpoint.retentionEventLimit,
      endpointId: this.endpoint.id,
      mode: this.endpoint.mode,
    });
  }

  private checkSize(event: SseEvent): void {
    if (Buffer.byteLength(event.data) > this.endpoint.eventDataLimitBytes) {
      throw new Error("SSE event exceeded the configured data limit");
    }
  }

  async push(sourceValue: SseEvent): Promise<void> {
    this.checkSize(sourceValue);
    const backfillId =
      sourceValue.dispatch !== false &&
      sourceValue.id !== undefined &&
      sourceValue.id !== null &&
      sourceValue.id !== ""
        ? sourceValue.id
        : null;
    if (backfillId) {
      this.sourceHistory.inheritId(backfillId);
      this.emittedHistory.inheritId(backfillId);
    }
    const source = this.effectiveId(sourceValue);
    const correlationId = randomUUID();
    for (const event of this.sourceHistory.push(source)) {
      await this.record("SOURCE", event, correlationId);
    }
    let transformed: {
      events: SseEvent[];
      splits: SseSplitDirective[];
      dropped: boolean;
    } = {
      events: [source],
      splits: [],
      dropped: false,
    };
    if (this.endpoint.responseScript.trim()) {
      const result = await runSseScript({
        source: this.endpoint.responseScript,
        timeoutMs: this.endpoint.responseScriptTimeoutMs,
        memoryLimitMb: this.endpoint.scriptMemoryLimitMb,
        fetchTimeoutMs: this.endpoint.fetchTimeoutMs,
        storage: this.service.scriptStorage(`${this.endpoint.id}:response`),
        context: {
          phase: "event",
          endpoint: this.endpoint,
          request: this.scriptRequest,
          response: this.committedResponse,
          event: source,
          buffers: {
            history: this.sourceHistory.text,
            delivery: this.delivery.text + (!source.event ? source.data : ""),
          },
        },
      });
      const response = result.context.response as
        { status?: unknown; headers?: unknown } | undefined;
      if (
        response &&
        (response.status !== this.committedResponse.status ||
          JSON.stringify(response.headers) !==
            JSON.stringify(this.committedResponse.headers))
      ) {
        throw new Error(
          "Response headers and status cannot be changed after the stream starts",
        );
      }
      const fallback = result.context.event
        ? normalizeEvent(result.context.event)
        : source;
      transformed = eventResult(
        result.resultDefined ? result.result : undefined,
        fallback,
      );
    }
    if (transformed.dropped) {
      await this.record("DROPPED", source, correlationId, { dropped: true });
    }
    for (let index = 0; index < transformed.events.length; index += 1) {
      const output = this.effectiveId(transformed.events[index]);
      this.checkSize(output);
      const emitted = this.emittedHistory.push(output);
      const deliverable = this.delivery.push(output);
      for (const event of emitted) {
        await this.record("EMITTED", event, correlationId, {
          fanOutIndex: transformed.events.length > 1 ? index : null,
        });
      }
      for (const event of deliverable) {
        await this.enqueue(encodeSseEvent(event));
      }
    }
    for (const split of transformed.splits)
      await this.applySplit(split, correlationId);
  }

  private async applySplit(
    split: SseSplitDirective,
    correlationId: string,
  ): Promise<void> {
    const target = String(split?.target ?? "").toUpperCase();
    const separatorLength = split?.separatorLength ?? split?.discard ?? 0;
    if (!split || !["DELIVERY", "HISTORY", "BOTH"].includes(target)) {
      throw new Error("SSE script returned an invalid split target");
    }
    if (!Number.isInteger(separatorLength) || separatorLength < 0) {
      throw new Error("SSE script returned an invalid split separator length");
    }
    if (target === "HISTORY" || target === "BOTH") {
      for (const event of this.sourceHistory.splitAt(
        split.offset,
        separatorLength,
      )) {
        await this.record("SOURCE", event, correlationId, { split: true });
      }
      for (const event of this.emittedHistory.splitAt(
        split.offset,
        separatorLength,
      )) {
        await this.record("EMITTED", event, correlationId, { split: true });
      }
    }
    if (target === "DELIVERY" || target === "BOTH") {
      for (const event of this.delivery.splitAt(
        split.offset,
        separatorLength,
      )) {
        await this.enqueue(encodeSseEvent(event));
      }
    }
  }

  async finish(): Promise<void> {
    const correlationId = randomUUID();
    for (const event of this.sourceHistory.flush())
      await this.record("SOURCE", event, correlationId);
    for (const event of this.emittedHistory.flush())
      await this.record("EMITTED", event, correlationId);
    for (const event of this.delivery.flush()) {
      await this.enqueue(encodeSseEvent(event));
    }
  }
}

async function responseConfiguration(
  service: SseService,
  endpoint: SseEndpointSnapshot,
  scriptRequest: Record<string, unknown>,
  status: number,
  headers: SseHeader[],
): Promise<{ status: number; headers: SseHeader[] }> {
  const initialStatus = validateSseStreamingStatus(status);
  if (!endpoint.responseScript.trim()) {
    return { status: initialStatus, headers };
  }
  const result = await runSseScript({
    source: endpoint.responseScript,
    timeoutMs: endpoint.responseScriptTimeoutMs,
    memoryLimitMb: endpoint.scriptMemoryLimitMb,
    fetchTimeoutMs: endpoint.fetchTimeoutMs,
    storage: service.scriptStorage(`${endpoint.id}:response-headers`),
    context: {
      phase: "headers",
      endpoint,
      request: scriptRequest,
      response: { status, headers },
      event: null,
      buffers: { history: "", delivery: "" },
    },
  });
  const contextResponse = result.context.response as {
    status?: unknown;
    headers?: unknown;
  };
  const returned =
    result.result && typeof result.result === "object"
      ? (result.result as Record<string, unknown>)
      : {};
  const nextStatus = validateSseStreamingStatus(
    Number(returned.status ?? contextResponse.status ?? initialStatus),
  );
  return {
    status: nextStatus,
    headers: normalizeScriptHeaders(
      returned.headers ?? contextResponse.headers ?? headers,
    ),
  };
}

function streamingResponse(
  service: SseService,
  endpoint: SseEndpointSnapshot,
  requestId: string,
  scriptRequest: Record<string, unknown>,
  config: { status: number; headers: SseHeader[] },
  producer: (pipeline: EventPipeline, signal: AbortSignal) => Promise<void>,
): Response {
  const abort = new AbortController();
  let closed = false;
  let releaseCapacity: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const waitForCapacity = async () => {
        while (!closed && (controller.desiredSize ?? 1) <= 0) {
          await new Promise<void>((resolve) => {
            releaseCapacity = resolve;
          });
        }
      };
      const enqueue = async (chunk: Uint8Array) => {
        await waitForCapacity();
        if (!closed) controller.enqueue(chunk);
      };
      const heartbeat = endpoint.heartbeatEnabled
        ? setInterval(() => {
            if (!closed && (controller.desiredSize ?? 0) > 0) {
              controller.enqueue(
                new TextEncoder().encode(`:heartbeat ${Date.now()}\n\n`),
              );
            }
          }, endpoint.heartbeatIntervalMs)
        : null;
      heartbeat?.unref?.();
      const pipeline = new EventPipeline(
        service,
        endpoint,
        requestId,
        scriptRequest,
        config,
        enqueue,
      );
      void producer(pipeline, abort.signal)
        .then(async () => {
          await pipeline.finish();
          await service.completeRequest(
            requestId,
            abort.signal.aborted ? "CANCELLED" : "COMPLETED",
            abort.signal.aborted ? "SSE client disconnected" : null,
          );
          if (!closed) {
            closed = true;
            controller.close();
          }
        })
        .catch(async (error) => {
          await service
            .completeRequest(requestId, "FAILED", message(error))
            .catch(() => undefined);
          if (!closed) {
            closed = true;
            controller.error(error);
          }
        })
        .finally(() => {
          if (heartbeat) clearInterval(heartbeat);
        });
    },
    pull() {
      const release = releaseCapacity;
      releaseCapacity = null;
      release?.();
    },
    cancel() {
      closed = true;
      abort.abort();
      const release = releaseCapacity;
      releaseCapacity = null;
      release?.();
    },
  });
  return new Response(stream, {
    status: config.status,
    headers: sseHeaders(config.headers),
  });
}

async function forwardResponse(
  service: SseService,
  endpoint: SseEndpointSnapshot,
  requestId: string,
  effective: EffectiveRequest,
  scriptRequest: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const method = effective.method.toUpperCase();
  const upstreamAbort = new AbortController();
  signal.addEventListener("abort", () => upstreamAbort.abort(), { once: true });
  const response = await fetchWithRedirectLimit(effective.url, {
    method,
    headers: safeHeaders(effective.headers),
    body: method === "GET" || method === "HEAD" ? undefined : effective.body,
    signal: upstreamAbort.signal,
    cache: "no-store",
  });
  const upstreamHeaders = headerList(response.headers);
  await service.updateUpstream(requestId, response.status, upstreamHeaders);
  const config = await responseConfiguration(
    service,
    endpoint,
    scriptRequest,
    response.status,
    upstreamHeaders,
  );
  await service.updateResponse(requestId, config.status, config.headers);
  if (!response.ok) {
    const body = await boundedResponseBody(response);
    await service.completeRequest(
      requestId,
      `UPSTREAM_${response.status}`,
      `Upstream returned ${response.status}`,
    );
    const headers = safeHeaders(config.headers);
    for (const name of TRANSFORMED_BODY_HEADERS) headers.delete(name);
    headers.set("access-control-allow-origin", "*");
    headers.set("cache-control", "no-store");
    return new Response(new Uint8Array(body).buffer, {
      status: config.status,
      headers,
    });
  }
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  ) {
    await response.body?.cancel();
    throw new Error(
      "Successful SSE upstream response must use text/event-stream",
    );
  }
  return streamingResponse(
    service,
    endpoint,
    requestId,
    scriptRequest,
    config,
    async (pipeline, streamSignal) => {
      if (!response.body) return;
      const reader = response.body.getReader();
      const parser = new SseParser();
      streamSignal.addEventListener("abort", () => void reader.cancel(), {
        once: true,
      });
      while (!streamSignal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of parser.push(value)) await pipeline.push(event);
      }
      if (!streamSignal.aborted) {
        for (const event of parser.finish()) await pipeline.push(event);
      }
    },
  );
}

async function mockResponse(
  service: SseService,
  endpoint: SseEndpointSnapshot,
  requestId: string,
  composition: SseResolvedComposition,
  scriptRequest: Record<string, unknown>,
): Promise<Response> {
  const config = await responseConfiguration(
    service,
    endpoint,
    scriptRequest,
    composition.statusCode,
    composition.headers,
  );
  await service.updateResponse(requestId, config.status, config.headers);
  return streamingResponse(
    service,
    endpoint,
    requestId,
    scriptRequest,
    config,
    async (pipeline, signal) => {
      const once = async () => {
        for (const block of composition.blocks) {
          if (signal.aborted) return;
          if (block.kind === "DELAY") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, block.delayMs ?? 0);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
          } else if (block.kind === "EVENT") {
            if (block.template) {
              await pipeline.push(
                renderSseParameterizedTemplate(
                  block.template,
                  block.templateValues,
                ),
              );
            } else {
              const event = block.customEvent;
              if (!event) throw new Error("Mock event payload is unavailable");
              await pipeline.push({
                event: event.eventName,
                data: event.data,
                id: event.eventId,
                retry: event.retryMs,
              });
            }
          } else {
            const result = await runSseScript({
              source: block.script ?? "",
              timeoutMs: endpoint.mockScriptTimeoutMs,
              memoryLimitMb: endpoint.scriptMemoryLimitMb,
              fetchTimeoutMs: endpoint.fetchTimeoutMs,
              storage: service.scriptStorage(`${endpoint.id}:mock:${block.id}`),
              context: {
                phase: "mock",
                endpoint,
                request: scriptRequest,
                response: config,
                event: null,
                buffers: { history: "", delivery: "" },
              },
            });
            if (!result.resultDefined || result.result === null) continue;
            const values = Array.isArray(result.result)
              ? result.result
              : [result.result];
            for (const value of values)
              await pipeline.push(normalizeEvent(value));
          }
        }
      };
      do {
        await once();
        if (endpoint.mockCompletion === "CLOSE" || signal.aborted) return;
        if (endpoint.mockCompletion === "HOLD") {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return;
        }
        if (composition.blocks.length === 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(1_000, endpoint.heartbeatIntervalMs)),
          );
        }
      } while (!signal.aborted);
    },
  );
}

export async function handlePublicSseRequest(
  service: SseService,
  endpoint: SseEndpointSnapshot,
  request: Request,
): Promise<Response> {
  let requestId: string | null = null;
  try {
    const bodyBytes = await requestBody(
      request,
      endpoint.requestBodyLimitBytes,
    );
    const body = requestBodyContext(bodyBytes);
    const inboundHeaders = headerList(request.headers);
    const history = await service.openRequest({
      endpoint,
      method: request.method,
      url: request.url,
      headers: inboundHeaders,
      body: body.text || null,
    });
    requestId = history.id;
    const originalRequest = {
      id: requestId,
      method: request.method,
      url: request.url,
      headers: inboundHeaders,
      body,
    };
    let effective: EffectiveRequest = {
      url: endpoint.forwardUrl,
      method: request.method,
      headers: inboundHeaders.filter(
        ({ name }) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
      ),
      body: body.text || null,
    };
    if (endpoint.requestScript.trim()) {
      const result = await runSseScript({
        source: endpoint.requestScript,
        timeoutMs: endpoint.requestScriptTimeoutMs,
        memoryLimitMb: endpoint.scriptMemoryLimitMb,
        fetchTimeoutMs: endpoint.fetchTimeoutMs,
        storage: service.scriptStorage(`${endpoint.id}:request`),
        context: {
          phase: "request",
          endpoint,
          request: originalRequest,
          forward: effective,
          response: null,
          event: null,
          buffers: { history: "", delivery: "" },
        },
      });
      const mutated = result.context.forward as Record<string, unknown>;
      const returned =
        result.resultDefined &&
        result.result &&
        typeof result.result === "object" &&
        !Array.isArray(result.result)
          ? (result.result as Record<string, unknown>)
          : {};
      const merged = { ...mutated, ...returned };
      effective = {
        // Mock mode never consumes an override. Retaining the configured URL
        // also prevents an invalid, unused override from failing a mock.
        url:
          endpoint.mode === "MOCK"
            ? endpoint.forwardUrl
            : validateEffectiveUrl(merged.url),
        method: String(merged.method ?? request.method).toUpperCase(),
        headers: normalizeScriptHeaders(merged.headers ?? []),
        body: merged.body == null ? null : String(merged.body),
      };
    }
    effective.headers = effective.headers.filter(
      ({ name }) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()),
    );
    await service.updateEffectiveRequest(requestId, effective);
    const scriptRequest = { ...originalRequest, effective };
    let selectedMode = endpoint.mode;
    let selectedComposition: SseResolvedComposition | null =
      endpoint.activeMockComposition;
    if (selectedMode === "BREAKPOINT") {
      const breakpoint = await service.createBreakpoint(requestId, endpoint);
      const resolution = await service.waitForBreakpoint(
        breakpoint.id,
        request.signal,
      );
      if (resolution.resolution === "FORWARD") selectedMode = "FORWARD";
      else {
        selectedMode = "MOCK";
        selectedComposition = isResolvedComposition(resolution.composition)
          ? resolution.composition
          : await service.resolveCompositionInput(
              endpoint.id,
              resolution.composition as SseMockCompositionInput,
            );
      }
    }
    if (selectedMode === "MOCK") {
      if (!selectedComposition)
        throw new Error("Mock mode requires an active composition");
      return await mockResponse(
        service,
        endpoint,
        requestId,
        selectedComposition,
        scriptRequest,
      );
    }
    return await forwardResponse(
      service,
      endpoint,
      requestId,
      effective,
      scriptRequest,
      request.signal,
    );
  } catch (error) {
    if (requestId)
      await service
        .completeRequest(requestId, "FAILED", message(error))
        .catch(() => undefined);
    const status = message(error).includes("body exceeded")
      ? 413
      : message(error).includes("breakpoint timed out")
        ? 504
        : message(error).includes("content-type") ||
            message(error).includes("text/event-stream")
          ? 502
          : 500;
    return corsError(status, message(error));
  }
}

function validateEffectiveUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Request script must provide a forward URL");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Forward URL must use HTTP or HTTPS");
  return url.toString();
}

function isResolvedComposition(
  value: unknown,
): value is SseResolvedComposition {
  return Boolean(
    value && typeof value === "object" && "id" in value && "blocks" in value,
  );
}

export function sseOptionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400",
      vary: "origin, access-control-request-headers",
    },
  });
}
