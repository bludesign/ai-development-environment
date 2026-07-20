// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingestConsole: vi.fn(),
  ingestAnalytics: vi.fn(),
  exportEntries: vi.fn(),
}));

vi.mock("@/services/server-services", () => ({
  getServerServices: () => ({ telemetryService: mocks }),
}));

import { POST as consolePost } from "./console-logs/route";
import { POST as analyticsPost } from "./analytics-events/route";
import { POST as exportPost } from "./export/route";

const consoleLog = {
  message: "Ready",
  time: "2026-07-20T16:30:00Z",
  level: "info",
  category: "startup",
  buildId: "build-1",
  sessionId: "session-1",
  attributes: {},
};

function request(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ingestConsole.mockResolvedValue({
    collected: true,
    items: [
      {
        id: "log-1",
        receivedAt: "2026-07-20T16:30:01Z",
        deviceIp: "203.0.113.7",
      },
    ],
  });
  mocks.ingestAnalytics.mockResolvedValue({ collected: false, items: [] });
  mocks.exportEntries.mockResolvedValue([]);
});

describe("telemetry REST routes", () => {
  test("collects console logs without authentication and enriches the IP", async () => {
    const response = await consolePost(
      request(
        "/api/telemetry/console-logs",
        {
          ...consoleLog,
          id: "client-id",
          deviceIp: "198.51.100.2",
          receivedAt: "client-time",
        },
        { "cf-connecting-ip": "203.0.113.7" },
      ),
    );
    expect(response.status).toBe(201);
    expect(mocks.ingestConsole).toHaveBeenCalledWith(
      [
        expect.not.objectContaining({
          id: expect.anything(),
          deviceIp: expect.anything(),
          receivedAt: expect.anything(),
        }),
      ],
      "203.0.113.7",
    );
    await expect(response.json()).resolves.toMatchObject({ collected: true });
  });

  test("acknowledges valid analytics while collection is disabled", async () => {
    const response = await analyticsPost(
      request("/api/telemetry/analytics-events", {
        eventName: "opened",
        kind: "product",
        screenName: "Home",
        time: "2026-07-20T16:30:00Z",
        defaultParameters: {},
        additionalParameters: {},
        buildId: "build-1",
        sessionId: "session-1",
      }),
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      collected: false,
      items: [],
    });
  });

  test("rejects invalid content types, unknown fields, and declared oversized bodies", async () => {
    const unsupported = await consolePost(
      new Request("http://localhost/api/telemetry/console-logs", {
        method: "POST",
        body: JSON.stringify(consoleLog),
      }),
    );
    expect(unsupported.status).toBe(415);

    const unknown = await consolePost(
      request("/api/telemetry/console-logs", {
        ...consoleLog,
        unexpected: "client",
      }),
    );
    expect(unknown.status).toBe(400);

    const oversized = await consolePost(
      request("/api/telemetry/console-logs", consoleLog, {
        "content-length": String(2 * 1024 * 1024 + 1),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(mocks.ingestConsole).not.toHaveBeenCalled();
  });

  test("rejects an oversized streamed export body without Content-Length", async () => {
    const request = new Request("http://localhost/api/telemetry/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: " ".repeat(256 * 1024 + 1),
    });
    expect(request.headers.get("content-length")).toBeNull();

    const response = await exportPost(request);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
    expect(mocks.exportEntries).not.toHaveBeenCalled();
  });
});
