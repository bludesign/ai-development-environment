import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { captureCommand } from "./capture-command.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")(
  "captured process group cleanup",
  () => {
    test("times out helpers holding output pipes after the direct child exits", async () => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: 0,
        killed: false,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      const pending = captureCommand({
        command: "git",
        args: ["fetch", "origin"],
        timeoutMs: 100,
        signal: new AbortController().signal,
      });

      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
      } finally {
        child.emit("close", 0, null);
        await expect(pending).resolves.toMatchObject({ timedOut: true });
      }
    });

    test("escalates when the direct child exits but a helper ignores SIGTERM", async () => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        killed: false,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        child.exitCode = 0;
        return true;
      });
      const controller = new AbortController();
      const pending = captureCommand({
        command: "git",
        args: ["fetch", "origin"],
        timeoutMs: 30_000,
        signal: controller.signal,
      });

      try {
        controller.abort();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(kill.mock.calls).toEqual([
          [-12345, "SIGTERM"],
          [-12345, "SIGKILL"],
        ]);
      } finally {
        child.emit("close", 0, null);
        await expect(pending).resolves.toMatchObject({
          timedOut: false,
          cancelled: true,
        });
      }
    });
  },
);
