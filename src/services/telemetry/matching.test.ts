import { describe, expect, test } from "vitest";

import type { TelemetryEntryView, TelemetryQueryInput } from "./types";
import {
  flattenTelemetryObject,
  matchesTelemetryQuery,
  telemetryFields,
  validateTelemetryQuery,
} from "./matching";

const entry: TelemetryEntryView = {
  id: "log-1",
  entryType: "CONSOLE",
  clientTime: "2026-07-20T16:30:00.000Z",
  receivedAt: "2026-07-20T16:30:01.000Z",
  deviceIp: "203.0.113.4",
  message: "Checkout completed",
  level: "Info",
  category: "checkout",
  eventName: null,
  eventKind: null,
  screenName: null,
  buildId: "build-1",
  sessionId: "session-1",
  attributes: {
    device: { model: "iPhone 17" },
    "literal.key": "preserved",
    tags: ["fast", "paid"],
  },
  defaultParameters: {},
  additionalParameters: {},
  highlightColor: null,
  separatorKind: null,
  separatorName: null,
};

const query = (
  patch: Partial<TelemetryQueryInput> = {},
): TelemetryQueryInput => ({
  view: "CONSOLE",
  ...patch,
});

describe("telemetry matching", () => {
  test("flattens nested object paths while retaining arrays and unsafe keys", () => {
    expect(flattenTelemetryObject("attributes", entry.attributes)).toEqual({
      "attributes.device.model": "iPhone 17",
      'attributes["literal.key"]': "preserved",
      "attributes.tags": ["fast", "paid"],
    });
  });

  test("searches standard fields, keys, values, glob, and regex with case controls", () => {
    expect(matchesTelemetryQuery(entry, query({ search: "checkout" }))).toBe(
      true,
    );
    expect(
      matchesTelemetryQuery(
        entry,
        query({ search: "*iPhone*", searchMode: "GLOB" }),
      ),
    ).toBe(true);
    expect(
      matchesTelemetryQuery(
        entry,
        query({ search: "checkout\\s+completed", searchMode: "REGEX" }),
      ),
    ).toBe(true);
    expect(
      matchesTelemetryQuery(
        entry,
        query({ search: "info", caseSensitive: true }),
      ),
    ).toBe(false);
  });

  test("combines quick filters and every advanced comparison family", () => {
    expect(
      matchesTelemetryQuery(
        entry,
        query({ quickFilters: { level: ["Info"], category: ["checkout"] } }),
      ),
    ).toBe(true);
    for (const condition of [
      { field: "message", operator: "CONTAINS", value: "completed" },
      { field: "message", operator: "DOES_NOT_CONTAIN", value: "failed" },
      { field: "level", operator: "IS", value: "info" },
      { field: "level", operator: "IS_NOT", value: "error" },
      {
        field: "attributes.device.model",
        operator: "MATCHES_GLOB",
        value: "iPhone*",
      },
      { field: "message", operator: "MATCHES_REGEX", value: "^Checkout" },
      { field: "message", operator: "NO_REGEX_MATCH", value: "failed$" },
      { field: "eventName", operator: "IS_EMPTY" },
      { field: "message", operator: "IS_NOT_EMPTY" },
    ] as const) {
      expect(
        matchesTelemetryQuery(
          entry,
          query({
            advancedFilter: { mode: "ALL", conditions: [condition] },
          }),
        ),
      ).toBe(true);
    }
  });

  test("ignores source-scoped conditions for the other source", () => {
    expect(
      matchesTelemetryQuery(
        entry,
        query({
          advancedFilter: {
            mode: "ALL",
            conditions: [
              {
                field: "eventName",
                operator: "IS",
                value: "never",
                sources: ["ANALYTICS"],
              },
            ],
          },
        }),
      ),
    ).toBe(true);
    expect(telemetryFields(entry).levelKind).toBe("Info");
  });

  test("rejects invalid and oversized patterns before querying", () => {
    expect(() =>
      validateTelemetryQuery(query({ search: "(", searchMode: "REGEX" })),
    ).toThrow();
    expect(() =>
      validateTelemetryQuery(query({ search: "[abc", searchMode: "GLOB" })),
    ).toThrow("Invalid glob pattern");
    expect(() =>
      validateTelemetryQuery(query({ search: "x".repeat(1_025) })),
    ).toThrow("1024");
  });
});
