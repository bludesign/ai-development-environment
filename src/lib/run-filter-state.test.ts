import { describe, expect, test } from "vitest";

import {
  DEFAULT_RUN_FILTERS,
  parseRunFilters,
  runFilterCookieName,
  serializeRunFilters,
} from "./run-filter-state";

describe("runFilterCookieName", () => {
  test("scopes the cookie per run kind", () => {
    expect(runFilterCookieName("PLAN")).toBe("ade_run_filters_plan");
    expect(runFilterCookieName("SESSION")).toBe("ade_run_filters_session");
  });
});

describe("parseRunFilters", () => {
  test("round trips a serialized selection", () => {
    const filters = {
      archive: "ARCHIVED",
      provider: "CLAUDE",
      origin: "IMPORTED",
    };
    expect(parseRunFilters(serializeRunFilters(filters))).toEqual(filters);
  });

  test("falls back to defaults when the cookie is missing or empty", () => {
    expect(parseRunFilters(undefined)).toEqual(DEFAULT_RUN_FILTERS);
    expect(parseRunFilters("")).toEqual(DEFAULT_RUN_FILTERS);
  });

  test("rejects values outside each dropdown's options", () => {
    expect(parseRunFilters("DELETED.GEMINI.SCRIPTED")).toEqual(
      DEFAULT_RUN_FILTERS,
    );
  });

  test("keeps the fields it recognizes when others are unusable", () => {
    expect(parseRunFilters("ARCHIVED.GEMINI")).toEqual({
      archive: "ARCHIVED",
      provider: "ALL",
      origin: "ALL",
    });
  });
});
