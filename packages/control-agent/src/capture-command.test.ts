import { describe, expect, test } from "vitest";

import { captureCommand } from "./capture-command.js";

describe("captureCommand", () => {
  test("does not spawn a command after its timeout has elapsed", async () => {
    await expect(
      captureCommand({
        command: "/command-that-does-not-exist",
        args: [],
        timeoutMs: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      cancelled: false,
    });
  });

  test("does not spawn a command after cancellation", async () => {
    await expect(
      captureCommand({
        command: "/command-that-does-not-exist",
        args: [],
        timeoutMs: 10_000,
        signal: AbortSignal.abort(),
      }),
    ).resolves.toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: true,
    });
  });
});
