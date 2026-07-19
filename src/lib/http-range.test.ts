import { describe, expect, test } from "vitest";

import { parseRangeHeader } from "./http-range";

describe("parseRangeHeader", () => {
  test("returns null when no header is present", () => {
    expect(parseRangeHeader(null, 100)).toBeNull();
  });

  test("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-1023", 4096)).toEqual({
      start: 0,
      end: 1023,
    });
  });

  test("parses an open ended range", () => {
    expect(parseRangeHeader("bytes=1024-", 4096)).toEqual({
      start: 1024,
      end: 4095,
    });
  });

  test("parses a suffix range", () => {
    expect(parseRangeHeader("bytes=-500", 4096)).toEqual({
      start: 3596,
      end: 4095,
    });
  });

  test("clamps a suffix longer than the resource", () => {
    expect(parseRangeHeader("bytes=-9000", 4096)).toEqual({
      start: 0,
      end: 4095,
    });
  });

  test("clamps an end past the final byte", () => {
    expect(parseRangeHeader("bytes=4000-9999", 4096)).toEqual({
      start: 4000,
      end: 4095,
    });
  });

  test("includes the final byte of a whole-resource range", () => {
    expect(parseRangeHeader("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
  });

  test("accepts a single byte range", () => {
    expect(parseRangeHeader("bytes=5-5", 10)).toEqual({ start: 5, end: 5 });
  });

  test("reports a start past the end as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=4096-", 4096)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=5000-6000", 4096)).toBe("unsatisfiable");
  });

  test("reports any range against an empty resource as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=0-10", 0)).toBe("unsatisfiable");
  });

  test("ignores malformed headers", () => {
    expect(parseRangeHeader("bytes=abc-def", 100)).toBeNull();
    expect(parseRangeHeader("items=0-10", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-", 100)).toBeNull();
    expect(parseRangeHeader("bytes=10-5", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-0", 100)).toBeNull();
  });

  test("ignores multi-range requests", () => {
    expect(parseRangeHeader("bytes=0-99,200-299", 4096)).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseRangeHeader("  bytes=0-9  ", 100)).toEqual({
      start: 0,
      end: 9,
    });
  });
});
