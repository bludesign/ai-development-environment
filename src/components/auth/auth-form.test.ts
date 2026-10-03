import { describe, expect, test } from "vitest";

import { safeReturnTo } from "./auth-form";

describe("authentication return paths", () => {
  test.each([
    [
      "/en/dashboard/builds?status=running",
      "/en/dashboard/builds?status=running",
    ],
    [
      "/en/dashboard/action-center#section",
      "/en/dashboard/action-center#section",
    ],
    [undefined, "/dashboard/action-center"],
    ["https://evil.example", "/dashboard/action-center"],
    ["//evil.example/path", "/dashboard/action-center"],
    ["/\\evil.example/path", "/dashboard/action-center"],
  ])("normalizes %s", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });
});
