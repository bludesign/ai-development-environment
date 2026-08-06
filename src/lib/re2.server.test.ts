import { describe, expect, test } from "vitest";

import { compileRe2, RE2_PATTERN_MAX_LENGTH } from "./re2.server";

describe("shared RE2 compiler", () => {
  test("always uses Unicode mode and preserves requested flags", () => {
    const regex = compileRe2("ready", { flags: "i" });
    expect(regex.flags).toContain("i");
    expect(regex.flags).toContain("u");
    expect(regex.test("READY")).toBe(true);
  });

  test("rejects unsupported syntax and overlong patterns", () => {
    expect(() => compileRe2("(?=ready)", { label: "Test pattern" })).toThrow(
      /Test pattern is not valid RE2 syntax/,
    );
    expect(() => compileRe2("(ready)\\1")).toThrow(/RE2 syntax/);
    expect(() => compileRe2("a".repeat(RE2_PATTERN_MAX_LENGTH + 1))).toThrow(
      new RegExp(`${RE2_PATTERN_MAX_LENGTH} characters`),
    );
  });

  test("evaluates nested quantifiers without backtracking", () => {
    const regex = compileRe2("^(a+)+$");
    expect(regex.test(`${"a".repeat(100_000)}!`)).toBe(false);
  });
});
