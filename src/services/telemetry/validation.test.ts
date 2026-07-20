import { describe, expect, test } from "vitest";

import {
  TelemetryValidationError,
  parseAnalyticsEvent,
  parseConsoleLog,
  parseIngestionBody,
} from "./validation";

const consoleLog = {
  message: "Ready",
  time: "2026-07-20T12:30:00-04:00",
  level: "info",
  category: "startup",
  buildId: "build-1",
  sessionId: "session-1",
  attributes: { device: { model: "iPhone" }, attempts: [1, 2] },
};

const analyticsEvent = {
  eventName: "screen_opened",
  kind: "product",
  screenName: "Home",
  time: "2026-07-20T16:30:00Z",
  defaultParameters: { appVersion: "1.0" },
  additionalParameters: { source: "deeplink" },
  buildId: "build-1",
  sessionId: "session-1",
};

describe("telemetry ingestion validation", () => {
  test("normalizes strict console records and direct or batched bodies", () => {
    expect(parseIngestionBody(consoleLog, parseConsoleLog)).toEqual([
      expect.objectContaining({
        time: "2026-07-20T16:30:00.000Z",
        attributes: consoleLog.attributes,
      }),
    ]);
    expect(
      parseIngestionBody({ items: [consoleLog, consoleLog] }, parseConsoleLog),
    ).toHaveLength(2);
  });

  test("accepts separate analytics parameter dictionaries", () => {
    expect(parseAnalyticsEvent(analyticsEvent)).toEqual({
      ...analyticsEvent,
      time: "2026-07-20T16:30:00.000Z",
    });
  });

  test("ignores server-owned fields and rejects timestamps without offsets", () => {
    expect(
      parseConsoleLog({
        ...consoleLog,
        id: "client-id",
        deviceIp: "203.0.113.4",
        receivedAt: "client",
      }),
    ).toEqual({ ...consoleLog, time: "2026-07-20T16:30:00.000Z" });
    expect(() => parseConsoleLog({ ...consoleLog, unexpected: true })).toThrow(
      TelemetryValidationError,
    );
    expect(() =>
      parseConsoleLog({ ...consoleLog, time: "2026-07-20T12:30:00" }),
    ).toThrow("UTC offset");
  });

  test("enforces nested string, path, depth, and batch limits", () => {
    expect(() =>
      parseConsoleLog({
        ...consoleLog,
        attributes: { value: "x".repeat(257) },
      }),
    ).toThrow("256 characters");
    let nested: Record<string, unknown> = { value: true };
    for (let index = 0; index < 12; index += 1) nested = { nested };
    expect(() =>
      parseConsoleLog({ ...consoleLog, attributes: nested }),
    ).toThrow("maximum JSON depth");
    expect(() =>
      parseIngestionBody(
        { items: Array.from({ length: 501 }, () => consoleLog) },
        parseConsoleLog,
      ),
    ).toThrow("1-500 items");
  });
});
