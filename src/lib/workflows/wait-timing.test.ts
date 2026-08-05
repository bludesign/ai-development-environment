import { describe, expect, test } from "vitest";

import {
  MAX_WAIT_SECONDS,
  MIN_WAIT_TIMEOUT_SECONDS,
  waitCadenceSeconds,
  waitElapsedText,
  waitKindText,
  waitResumeAfter,
  waitTimeoutAt,
} from "./wait-timing";

function inSeconds(date: Date | null): number {
  if (!date) throw new Error("Expected a date");
  return Math.round((date.getTime() - Date.now()) / 1_000);
}

describe("wait timing", () => {
  test("prefers the configured timeout over the step's own budget", () => {
    expect(inSeconds(waitTimeoutAt({ timeoutSeconds: 7_200 }, 3_600))).toBe(
      7_200,
    );
  });

  test("falls back to the step budget when no timeout is configured", () => {
    expect(inSeconds(waitTimeoutAt({}, 3_600))).toBe(3_600);
    expect(inSeconds(waitTimeoutAt({ timeoutSeconds: null }, 900))).toBe(900);
  });

  test("waits indefinitely when neither a config nor a budget applies", () => {
    expect(waitTimeoutAt({})).toBeNull();
    expect(waitTimeoutAt({ timeoutSeconds: "" })).toBeNull();
  });

  test("accepts a numeric string, as a session binding may resolve to one", () => {
    expect(inSeconds(waitTimeoutAt({ timeoutSeconds: " 120 " }))).toBe(120);
    expect(waitCadenceSeconds({ cadenceSeconds: "30" }, 3)).toBe(30);
  });

  test("clamps rather than failing the step over an unusable value", () => {
    expect(inSeconds(waitTimeoutAt({ timeoutSeconds: 1 }))).toBe(
      MIN_WAIT_TIMEOUT_SECONDS,
    );
    expect(inSeconds(waitTimeoutAt({ timeoutSeconds: 1e12 }))).toBe(
      MAX_WAIT_SECONDS,
    );
    expect(waitCadenceSeconds({ cadenceSeconds: 0.2 }, 3)).toBe(1);
  });

  test("ignores values that are not usable seconds", () => {
    for (const value of [0, -5, Number.NaN, "soon", {}, [], true]) {
      expect(waitTimeoutAt({ timeoutSeconds: value }, 60)).not.toBeNull();
      expect(waitCadenceSeconds({ cadenceSeconds: value }, 3)).toBe(3);
    }
  });

  test("keeps the poller's cadence when the step configures none", () => {
    expect(waitCadenceSeconds({}, 10)).toBe(10);
    expect(inSeconds(waitResumeAfter({}))).toBe(1);
    expect(inSeconds(waitResumeAfter({ cadenceSeconds: 45 }))).toBe(45);
  });

  test("spells wait kinds as prose for run event messages", () => {
    expect(waitKindText("AGENT_JOB")).toBe("agent job");
    expect(waitKindText("GITHUB_CHECKS")).toBe("github checks");
  });

  test("reads an elapsed wait at the precision that wait deserves", () => {
    expect(waitElapsedText(0)).toBe("0s");
    expect(waitElapsedText(8_400)).toBe("8s");
    expect(waitElapsedText(128_000)).toBe("2m 8s");
    expect(waitElapsedText(3_780_000)).toBe("1h 3m");
    // A clock that ran backwards between parking and resolving must not
    // produce a negative reading.
    expect(waitElapsedText(-5_000)).toBe("0s");
  });
});
