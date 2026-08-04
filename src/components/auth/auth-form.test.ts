import { describe, expect, test } from "vitest";

import { safeReturnTo } from "./auth-form";

describe("authentication return paths", () => {
  test.each([
    ["/en/builds?status=running", "/en/builds?status=running"],
    ["/en#section", "/en#section"],
    [undefined, "/"],
    ["https://evil.example", "/"],
    ["//evil.example/path", "/"],
    ["/\\evil.example/path", "/"],
  ])("normalizes %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });
});
