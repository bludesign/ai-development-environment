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

  test.skipIf(process.platform === "win32")(
    "terminates descendants that inherit the captured output pipes",
    async () => {
      const result = await captureCommand({
        command: process.execPath,
        args: [
          "-e",
          [
            'const { spawn } = require("node:child_process");',
            'spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"],',
            '  { stdio: ["ignore", "inherit", "inherit"] });',
            "setInterval(() => {}, 1_000);",
          ].join("\n"),
        ],
        timeoutMs: 100,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        exitCode: null,
        timedOut: true,
        cancelled: false,
      });
    },
  );
});
