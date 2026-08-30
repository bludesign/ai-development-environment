import { describe, expect, test, vi } from "vitest";

import { handlePublicSseRequest } from "./sse-runtime";
import type { SseService } from "./sse.service";
import type {
  SseEndpointSnapshot,
  SseHeader,
  SseResolvedComposition,
} from "./types";

function endpoint(
  composition: SseResolvedComposition,
  overrides: Partial<SseEndpointSnapshot> = {},
): SseEndpointSnapshot {
  return {
    id: "endpoint-1",
    token: "token",
    name: "Test endpoint",
    description: "",
    mode: "MOCK",
    forwardUrl: "https://upstream.example/events",
    requestScript: "",
    responseScript: "",
    activeMockCompositionId: composition.id,
    deliveryBufferMode: "STANDARD",
    historyBufferMode: "CONCATENATE",
    breakpointTimeoutMs: 300_000,
    heartbeatEnabled: false,
    heartbeatIntervalMs: 15_000,
    mockCompletion: "CLOSE",
    requestScriptTimeoutMs: 30_000,
    mockScriptTimeoutMs: 30_000,
    responseScriptTimeoutMs: 5_000,
    scriptMemoryLimitMb: 32,
    fetchTimeoutMs: 15_000,
    requestBodyLimitBytes: 2 * 1024 * 1024,
    eventDataLimitBytes: 512 * 1024,
    streamHistoryLimitBytes: 50 * 1024 * 1024,
    retentionDays: 30,
    retentionEventLimit: 100_000,
    activeMockComposition: composition,
    ...overrides,
  };
}

function service() {
  const history: Array<{
    requestId: string;
    eventId?: string | null;
    data: string;
  }> = [];
  let effectiveRequest:
    | { url: string; method: string; headers: SseHeader[]; body: string | null }
    | undefined;
  const values = new Map<string, { value: unknown; version: number }>();
  const fake = {
    openRequest: vi.fn(async () => ({ id: "request-1" })),
    updateEffectiveRequest: vi.fn(
      async (
        _id: string,
        value: {
          url: string;
          method: string;
          headers: SseHeader[];
          body: string | null;
        },
      ) => {
        effectiveRequest = value;
      },
    ),
    updateResponse: vi.fn(async () => undefined),
    completeRequest: vi.fn(async () => undefined),
    appendHistoryEvent: vi.fn(async (value: (typeof history)[number]) => {
      history.push(value);
      return value;
    }),
    backfillEventId: vi.fn(async (requestId: string, eventId: string) => {
      let count = 0;
      for (const item of history) {
        if (item.requestId === requestId && item.eventId == null) {
          item.eventId = eventId;
          count += 1;
        }
      }
      return count;
    }),
    scriptStorage: vi.fn(() => ({
      get: async (key: string) => {
        const value = values.get(key);
        return value ? { key, ...value } : null;
      },
      set: async (key: string, value: unknown) => {
        const next = { value, version: (values.get(key)?.version ?? 0) + 1 };
        values.set(key, next);
        return { key, ...next };
      },
      delete: async (key: string) => values.delete(key),
      compareAndSet: async (
        key: string,
        version: number | null,
        value: unknown,
      ) => {
        if ((values.get(key)?.version ?? null) !== version) {
          throw new Error("version conflict");
        }
        const next = { value, version: (version ?? 0) + 1 };
        values.set(key, next);
        return { key, ...next };
      },
      increment: async (key: string, delta: number) => {
        const next = {
          value: Number(values.get(key)?.value ?? 0) + delta,
          version: (values.get(key)?.version ?? 0) + 1,
        };
        values.set(key, next);
        return { key, ...next };
      },
    })),
  };
  return {
    fake: fake as unknown as SseService,
    history,
    effectiveRequest: () => effectiveRequest,
  };
}

describe("handlePublicSseRequest", () => {
  test("ignores request-script URL overrides in Mock mode", async () => {
    const composition: SseResolvedComposition = {
      id: "mock-1",
      name: "Empty mock",
      statusCode: 200,
      headers: [],
      blocks: [],
    };
    const testService = service();
    const response = await handlePublicSseRequest(
      testService.fake,
      endpoint(composition, {
        requestScript: 'forward.url = "not a URL"; return { url: null };',
      }),
      new Request("https://control.example/api/public/sse/token"),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
    expect(testService.effectiveRequest()?.url).toBe(
      "https://upstream.example/events",
    );
  });

  test("streams custom event blocks without creating a template", async () => {
    const composition: SseResolvedComposition = {
      id: "mock-custom",
      name: "Custom event",
      statusCode: 200,
      headers: [],
      blocks: [
        {
          id: "custom-event",
          kind: "EVENT",
          delayMs: null,
          script: null,
          template: null,
          customEvent: {
            eventName: "display_card",
            data: '{"title":"Custom"}',
            eventId: "event-42",
            retryMs: 2_000,
          },
        },
      ],
    };
    const testService = service();
    const response = await handlePublicSseRequest(
      testService.fake,
      endpoint(composition),
      new Request("https://control.example/api/public/sse/token"),
    );

    await expect(response.text()).resolves.toContain(
      'event:display_card\nid:event-42\nretry:2000\ndata:{"title":"Custom"}',
    );
    expect(testService.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: '{"title":"Custom"}',
          eventId: "event-42",
        }),
      ]),
    );
  });

  test("backfills records flushed by the event that introduces an ID", async () => {
    const composition: SseResolvedComposition = {
      id: "mock-2",
      name: "ID backfill",
      statusCode: 200,
      headers: [],
      blocks: [
        {
          id: "first",
          kind: "EVENT",
          delayMs: null,
          script: null,
          customEvent: null,
          template: {
            id: "template-1",
            endpointId: "endpoint-1",
            name: "First",
            eventName: null,
            data: "before",
            eventId: null,
            retryMs: null,
          },
        },
        {
          id: "second",
          kind: "EVENT",
          delayMs: null,
          script: null,
          customEvent: null,
          template: {
            id: "template-2",
            endpointId: "endpoint-1",
            name: "Second",
            eventName: "done",
            data: "after",
            eventId: "1349872",
            retryMs: null,
          },
        },
      ],
    };
    const testService = service();
    const response = await handlePublicSseRequest(
      testService.fake,
      endpoint(composition),
      new Request("https://control.example/api/public/sse/token"),
    );

    await response.text();
    expect(
      testService.history.map(({ data, eventId }) => ({ data, eventId })),
    ).toEqual([
      { data: "before", eventId: "1349872" },
      { data: "after", eventId: "1349872" },
      { data: "before", eventId: "1349872" },
      { data: "after", eventId: "1349872" },
    ]);
  });
});
