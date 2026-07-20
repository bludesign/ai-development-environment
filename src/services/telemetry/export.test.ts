// @vitest-environment node
import { describe, expect, test } from "vitest";

import type { TelemetryEntryView } from "./types";
import { telemetryCsv, telemetryMarkdown, telemetryPdf } from "./export";

const records: TelemetryEntryView[] = [
  {
    id: "separator-1",
    entryType: "SEPARATOR",
    clientTime: "2026-07-20T16:00:00.000Z",
    receivedAt: "2026-07-20T16:00:00.000Z",
    deviceIp: null,
    message: null,
    level: null,
    category: null,
    eventName: null,
    eventKind: null,
    screenName: null,
    buildId: "build-1",
    sessionId: null,
    attributes: {},
    defaultParameters: {},
    additionalParameters: {},
    highlightColor: null,
    separatorKind: "BUILD",
    separatorName: "Build · Debug · iPhone",
  },
  {
    id: "log-1",
    entryType: "CONSOLE",
    clientTime: "2026-07-20T15:59:00.000Z",
    receivedAt: "2026-07-20T15:59:01.000Z",
    deviceIp: "203.0.113.4",
    message: "=unsafe spreadsheet value",
    level: "info",
    category: "test",
    eventName: null,
    eventKind: null,
    screenName: null,
    buildId: "build-1",
    sessionId: "session-1",
    attributes: {},
    defaultParameters: {},
    additionalParameters: {},
    highlightColor: null,
    separatorKind: null,
    separatorName: null,
  },
];

const input = {
  format: "CSV" as const,
  view: "CONSOLE" as const,
  fields: ["time", "message", "buildId"],
  locale: "en",
  timeZone: "UTC",
  timeFormat: "12" as const,
};

describe("telemetry exports", () => {
  test("escapes formulas in CSV and includes named separators", () => {
    const output = telemetryCsv(records, input);
    expect(output).toContain("[Separator] Build · Debug · iPhone");
    expect(output).toContain("'=unsafe spreadsheet value");
  });

  test("formats Markdown with day and separator headings", () => {
    const output = telemetryMarkdown(records, { ...input, format: "MARKDOWN" });
    expect(output).toContain("# Observability export");
    expect(output).toContain("Build · Debug · iPhone");
    expect(output).toContain("| Time | Message | Build ID |");
  });

  test("generates a formatted PDF document", async () => {
    const output = await telemetryPdf(records, { ...input, format: "PDF" });
    expect(new TextDecoder().decode(output.slice(0, 5))).toBe("%PDF-");
    expect(output.byteLength).toBeGreaterThan(1_000);
  });
});
