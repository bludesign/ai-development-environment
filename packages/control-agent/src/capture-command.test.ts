import { describe, expect, test, vi } from "vitest";

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

  test("caps combined output before retaining unterminated streams", async () => {
    const result = await captureCommand({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("x".repeat(4096)); process.stderr.write("y".repeat(4096));',
      ],
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      maxOutputBytes: 1024,
    });

    expect(Buffer.byteLength(`${result.stdout}${result.stderr}`, "utf8")).toBe(
      1024,
    );
    expect(result.outputTruncated).toBe(true);
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

  test.skipIf(process.platform === "win32")(
    "falls back to terminating the child when its process group cannot be signalled",
    async () => {
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("Operation not permitted"), {
          code: "EPERM",
        });
      });
      try {
        const result = await captureCommand({
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1_000)"],
          timeoutMs: 100,
          signal: new AbortController().signal,
        });

        expect(result).toMatchObject({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          cancelled: false,
        });
        expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
        expect(kill.mock.calls[0]?.[0]).toBeLessThan(0);
      } finally {
        kill.mockRestore();
      }
    },
  );
});
