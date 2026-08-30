// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ history: vi.fn() }));
const requireUserRequest = vi.hoisted(() => vi.fn());

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ sseService: mocks }),
}));
vi.mock("@/services/auth", () => ({ requireUserRequest }));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/sse/history/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireUserRequest.mockResolvedValue(null);
  mocks.history.mockResolvedValue({
    view: "EVENTS",
    streams: [],
    events: [
      {
        id: "event-1",
        eventName: "loading",
        data: "Loading",
        stage: "SOURCE",
        createdAt: "2026-08-30T20:59:10.000Z",
        request: { endpointName: "Product feed", mode: "FORWARD" },
      },
      {
        id: "event-2",
        eventName: "done",
        data: "Done",
        stage: "EMITTED",
        createdAt: "2026-08-30T21:00:10.000Z",
        request: { endpointName: "Product feed", mode: "FORWARD" },
      },
    ],
    nextCursor: null,
    matchingCount: 2,
    totalCount: 2,
  });
});

describe("SSE history export route", () => {
  test("exports only selected records and fields", async () => {
    const response = await POST(
      request({
        format: "CSV",
        query: { view: "EVENTS", stages: ["SOURCE"] },
        ids: ["event-1"],
        fields: ["eventName", "data"],
        locale: "en",
        timeZone: "UTC",
        timeFormat: "12",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      "sse-events-",
    );
    const content = await response.text();
    expect(content).toContain('"Event Name","Data"');
    expect(content).toContain('"loading","Loading"');
    expect(content).not.toContain("Done");
    expect(mocks.history).toHaveBeenCalledWith(
      expect.objectContaining({
        view: "EVENTS",
        stages: ["SOURCE"],
        first: 500,
      }),
    );
  });

  test("rejects invalid fields before querying history", async () => {
    const response = await POST(
      request({
        format: "PDF",
        query: { view: "EVENTS" },
        fields: ["requestHeaders"],
        locale: "en",
        timeZone: "UTC",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.history).not.toHaveBeenCalled();
  });
});
