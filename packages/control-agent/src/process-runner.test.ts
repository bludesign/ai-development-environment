import { afterEach, describe, expect, test, vi } from "vitest";

import { runProcess } from "./process-runner.js";

describe("runProcess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("keeps delivering logs and reports process success after one log upload fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
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
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(
      "Could not append process log 0:",
      "temporary HTTP failure",
    );
  });
});
