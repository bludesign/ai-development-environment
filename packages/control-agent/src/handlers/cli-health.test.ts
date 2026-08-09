import { homedir } from "node:os";

import { describe, expect, test } from "vitest";

import { runCliHealth, runCliHealthCheck } from "./cli-health.js";

describe("runCliHealth", () => {
  test("captures ordered stdout, stderr, and individual exit codes", async () => {
    const result = await runCliHealth(
      {
        checks: [
          {
            id: "pass",
            name: "Passing",
            command: "printf 'ready'",
            builtIn: true,
          },
          {
            id: "fail",
            name: "Failing",
            command: "printf 'expired' >&2; exit 7",
            builtIn: false,
          },
        ],
      },
      600_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect(result.exitCode).toBe(0);
    expect(result.checks.map((check) => check.id)).toEqual(["pass", "fail"]);
    expect(result.checks[0]).toMatchObject({
      exitCode: 0,
      stdout: "ready",
      stderr: "",
    });
    expect(result.checks[1]).toMatchObject({
      exitCode: 7,
      stdout: "",
      stderr: "expired",
    });
  });

  test("strips terminal controls and truncates oversized output", async () => {
    const logs: Array<{ sequence: number; message: string }> = [];
    const result = await runCliHealth(
      {
        checks: [
          {
            id: "large",
            name: "Large",
            command: "printf '\\033[31m'; yes x | head -c 40000",
            builtIn: false,
          },
        ],
      },
      600_000,
      new AbortController().signal,
      async (log) => {
        logs.push(log);
      },
    );
    expect(result.checks[0]?.stdout).not.toContain("\u001b");
    expect(result.checks[0]?.outputTruncated).toBe(true);
    expect(
      Buffer.byteLength(
        `${result.checks[0]?.stdout}${result.checks[0]?.stderr}`,
        "utf8",
      ),
    ).toBeLessThanOrEqual(32 * 1024);
    expect(logs).toHaveLength(1);
    expect(Buffer.byteLength(logs[0]?.message ?? "", "utf8")).toBeLessThan(
      33 * 1024,
    );
  });

  test("does not mark output truncated when it exactly fills the limit", async () => {
    const result = await runCliHealth(
      {
        checks: [
          {
            id: "exact",
            name: "Exact",
            command: "head -c 32768 /dev/zero | tr '\\0' x",
            builtIn: false,
          },
        ],
      },
      600_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect(Buffer.byteLength(result.checks[0]?.stdout ?? "", "utf8")).toBe(
      32 * 1024,
    );
    expect(result.checks[0]?.outputTruncated).toBe(false);
  });

  test("allocates log sequences across concurrent checks", async () => {
    const logs: Array<{ sequence: number; message: string }> = [];
    await runCliHealth(
      {
        checks: [
          {
            id: "first",
            name: "First",
            command: "printf 'one\\ntwo\\n'",
            builtIn: false,
          },
          {
            id: "second",
            name: "Second",
            command: "printf 'three\\nfour\\n'",
            builtIn: false,
          },
        ],
      },
      600_000,
      new AbortController().signal,
      async (log) => {
        logs.push(log);
      },
    );

    expect(logs).toHaveLength(2);
    expect(logs.map((log) => log.sequence)).toEqual([0, 1]);
    expect(logs.every((log) => log.message.includes("\n"))).toBe(true);
  });

  test("runs through a shell from the agent home directory and maps a missing executable", async () => {
    const result = await runCliHealth(
      {
        checks: [
          {
            id: "cwd",
            name: "Working directory",
            command: "pwd",
            builtIn: false,
          },
          {
            id: "missing",
            name: "Missing",
            command: "aide-command-that-does-not-exist",
            builtIn: false,
          },
        ],
      },
      600_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect(result.checks[0]).toMatchObject({ exitCode: 0, stdout: homedir() });
    expect(result.checks[1]?.exitCode).not.toBe(0);
    expect(result.checks[1]?.stderr).toContain(
      "aide-command-that-does-not-exist",
    );
  });

  test("reports timeouts and shell launch failures as individual unhealthy results", async () => {
    const check = {
      id: "timeout",
      name: "Timeout",
      command: "sleep 1",
      builtIn: false,
    };
    const timedOut = await runCliHealthCheck(
      check,
      new AbortController().signal,
      async () => undefined,
      { timeoutMs: 20 },
    );
    const launchFailure = await runCliHealthCheck(
      { ...check, id: "launch", name: "Launch" },
      new AbortController().signal,
      async () => undefined,
      { shell: "/aide/missing-shell" },
    );

    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).toBeNull();
    expect(timedOut.stderr).toContain("Process exceeded");
    expect(launchFailure.launchError).toContain("missing-shell");
    expect(launchFailure.exitCode).toBeNull();
  });

  test("runs no more than four checks at once", async () => {
    const started = Date.now();
    const result = await runCliHealth(
      {
        checks: Array.from({ length: 5 }, (_, index) => ({
          id: String(index),
          name: String(index),
          command: "sleep 0.25",
          builtIn: false,
        })),
      },
      600_000,
      new AbortController().signal,
      async () => undefined,
    );
    const duration = Date.now() - started;

    expect(result.checks).toHaveLength(5);
    expect(duration).toBeGreaterThanOrEqual(400);
    expect(duration).toBeLessThan(1_200);
  });

  test("reports a cancelled sweep without turning completed checks into a job failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCliHealth(
      { checks: [] },
      600_000,
      controller.signal,
      async () => undefined,
    );
    expect(result).toMatchObject({
      exitCode: null,
      cancelled: true,
      checks: [],
    });
  });
});
