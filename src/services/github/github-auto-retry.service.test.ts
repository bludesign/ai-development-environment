// @vitest-environment node

import { describe, expect, test } from "vitest";

import { autoRetryDecision } from "./github-auto-retry.service";

describe("GitHub Auto Retry decisions", () => {
  test("count mode repeats successful runs until the configured limit", () => {
    expect(
      autoRetryDecision({
        mode: "COUNT",
        retryLimit: 3,
        automaticRetries: 2,
        state: "SUCCESS",
      }),
    ).toBe("RETRY");
    expect(
      autoRetryDecision({
        mode: "COUNT",
        retryLimit: 3,
        automaticRetries: 3,
        state: "SUCCESS",
      }),
    ).toBe("COMPLETE");
    expect(
      autoRetryDecision({
        mode: "COUNT",
        retryLimit: 3,
        automaticRetries: 0,
        state: "FAILURE",
      }),
    ).toBe("STOP");
  });

  test.each(["FAILURE", "ERROR", "STARTUP_FAILURE", "TIMED_OUT"] as const)(
    "failure mode retries %s",
    (state) => {
      expect(
        autoRetryDecision({
          mode: "FAILURE",
          retryLimit: null,
          automaticRetries: 100,
          state,
        }),
      ).toBe("RETRY");
    },
  );

  test("failure mode completes, exhausts, or stops without retrying other conclusions", () => {
    expect(
      autoRetryDecision({
        mode: "FAILURE",
        retryLimit: 3,
        automaticRetries: 0,
        state: "SUCCESS",
      }),
    ).toBe("COMPLETE");
    expect(
      autoRetryDecision({
        mode: "FAILURE",
        retryLimit: 3,
        automaticRetries: 3,
        state: "FAILURE",
      }),
    ).toBe("EXHAUSTED");
    expect(
      autoRetryDecision({
        mode: "FAILURE",
        retryLimit: 3,
        automaticRetries: 0,
        state: "CANCELLED",
      }),
    ).toBe("STOP");
  });
});
