import { describe, expect, test } from "vitest";

import {
  commandOutputMatchMode,
  commandOutputPattern,
  validateCommandOutputPattern,
} from "./command-output-match";
import { compileCommandOutputPattern } from "./command-output-match.server";

describe("command output matching", () => {
  test("reads optional config and defaults the mode to once", () => {
    expect(commandOutputPattern({})).toBeNull();
    expect(commandOutputPattern({ outputPattern: "ready" })).toBe("ready");
    expect(commandOutputMatchMode({})).toBe("ONCE");
    expect(commandOutputMatchMode({ outputMatchMode: "EACH_MATCH" })).toBe(
      "EACH_MATCH",
    );
  });

  test("supports positional and named RE2 captures", () => {
    const match = compileCommandOutputPattern(
      "ready (?<port>[0-9]+)",
      true,
    ).exec("ready 4321");
    expect(match?.slice(0, 2)).toEqual(["ready 4321", "4321"]);
    expect(match?.groups).toEqual({ port: "4321" });
  });

  test("accepts RE2 syntax that JavaScript RegExp does not support", () => {
    expect(() => validateCommandOutputPattern("\\Aready\\z")).not.toThrow();
    expect(compileCommandOutputPattern("\\Aready\\z").test("ready")).toBe(true);
    expect(
      compileCommandOutputPattern("(?P<state>ready)").exec("ready")?.groups,
    ).toEqual({ state: "ready" });
  });

  test("rejects unsafe or unusable patterns", () => {
    expect(() => compileCommandOutputPattern("(?=ready)")).toThrow(
      /RE2 syntax/,
    );
    expect(() => validateCommandOutputPattern("a*")).toThrow(/consume/);
    expect(() => compileCommandOutputPattern("\\b")).toThrow(/consume/);
    expect(() => compileCommandOutputPattern("a?\\b")).toThrow(/consume/);
    expect(() => validateCommandOutputPattern("x".repeat(1_025))).toThrow(
      /1,?024/,
    );
  });
});
