import { describe, expect, test } from "vitest";

import { CLI_HEALTH_MAX_CHECKS, parseCliHealthJobPayload } from "./cli-health";

const check = (id: string) => ({
  id,
  name: id,
  command: "tool auth status",
  builtIn: false,
});

describe("parseCliHealthJobPayload", () => {
  test("accepts bounded definitions and preserves their order", () => {
    expect(
      parseCliHealthJobPayload({
        checks: [check("one"), check("two")],
      }).checks.map((item) => item.id),
    ).toEqual(["one", "two"]);
  });

  test("rejects duplicate identifiers and unsafe commands", () => {
    expect(() =>
      parseCliHealthJobPayload({ checks: [check("same"), check("same")] }),
    ).toThrow("identifiers must be unique");
    expect(() =>
      parseCliHealthJobPayload({
        checks: [{ ...check("unsafe"), command: "echo\0bad" }],
      }),
    ).toThrow("command is invalid");
  });

  test("rejects more than the combined built-in and custom limit", () => {
    expect(() =>
      parseCliHealthJobPayload({
        checks: Array.from({ length: CLI_HEALTH_MAX_CHECKS + 1 }, (_, index) =>
          check(String(index)),
        ),
      }),
    ).toThrow(`at most ${CLI_HEALTH_MAX_CHECKS}`);
  });
});
