// @vitest-environment node
import { describe, expect, test } from "vitest";

import {
  sseHistoryCsv,
  sseHistoryFilterLines,
  sseHistoryMarkdown,
  sseHistoryPdf,
  type SseHistoryExportInput,
  type SseHistoryExportRow,
} from "./export";

const rows: SseHistoryExportRow[] = [
  {
    id: "event-1",
    requestId: "stream-1",
    sequence: 1,
    stage: "SOURCE",
    eventName: "display_card",
    eventId: "1349872",
    data: '=unsafe | {"title":"Trail shoes"}',
    createdAt: "2026-08-30T20:59:10.000Z",
    request: {
      endpointName: "Product recommendations",
      mode: "FORWARD",
    },
  },
];

const input: SseHistoryExportInput = {
  format: "CSV",
  view: "EVENTS",
  fields: ["endpoint", "createdAt", "eventName", "stage", "eventId", "data"],
  locale: "en",
  timeZone: "UTC",
  timeFormat: "12",
  filterSummary: JSON.stringify({
    endpoint: "Product recommendations",
    stages: ["SOURCE"],
    search: "display_*",
    searchMode: "GLOB",
    caseSensitive: false,
  }),
};

describe("SSE history exports", () => {
  test("formats CSV and Markdown with selected fields and date separators", () => {
    const csv = sseHistoryCsv(rows, input);
    expect(csv).toContain('"[Day] Sunday, August 30, 2026"');
    expect(csv).toContain("'=unsafe |");
    expect(csv.split("\r\n")[0]).toBe(
      '"Endpoint","Create At","Event Name","Stage","Event ID","Data"',
    );

    const markdown = sseHistoryMarkdown(rows, {
      ...input,
      format: "MARKDOWN",
      fields: ["eventName", "data"],
    });
    expect(markdown).toContain("# SSE Events export");
    expect(markdown).toContain("## Sunday, August 30, 2026");
    expect(markdown).toContain("| Event Name | Data |");
    expect(markdown).toContain("\\|");
  });

  test("formats readable filter metadata", () => {
    expect(sseHistoryFilterLines(input.filterSummary)).toEqual([
      "Endpoint: Product recommendations",
      "Stages: SOURCE",
      "Search - Glob, case-insensitive: display_*",
    ]);
  });

  test("generates a formatted PDF with Unicode event data", async () => {
    const pdf = await sseHistoryPdf(
      [{ ...rows[0]!, data: "Good morning 🚀 測試" }],
      { ...input, format: "PDF" },
    );
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });
});
