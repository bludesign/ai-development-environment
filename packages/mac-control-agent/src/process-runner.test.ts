import { describe, expect, test, vi } from "vitest";

import { runProcess } from "./process-runner.js";

describe("runProcess", () => {
  test("keeps delivering logs and reports process success after one log upload fails", async () => {
    const received: string[] = [];
    const onLog = vi.fn(async (log: { message: string }) => {
      received.push(log.message);
      if (log.message === "first") throw new Error("temporary HTTP failure");
    });

    const result = await runProcess({
      command: process.execPath,
      args: ["-e", "console.log('first'); console.log('second')"],
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      onLog,
    });

    expect(result.exitCode).toBe(0);
    expect(received).toEqual(["first", "second"]);
    expect(onLog).toHaveBeenCalledTimes(2);
  });
});
