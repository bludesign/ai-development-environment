import { describe, expect, test, vi } from "vitest";

import type { CommandOutputChunk } from "@ai-development-environment/agent-contract/commands";

import { runCommand } from "./commands.js";
import type { AgentJobHandlerContext } from "./index.js";

function context(
  append: (attemptId: string, chunks: CommandOutputChunk[]) => Promise<unknown>,
): AgentJobHandlerContext {
  return {
    reportWorktreeActivity: vi.fn(),
    appendCommandOutput: append,
  };
}

const payload = (script: string) => ({
  commandRunId: "run-1",
  attemptId: "attempt-1",
  targetKind: "AGENT_HOME",
  cwd: null,
  script,
});

describe("saved command handler", () => {
  test("falls back to the POSIX shell when SHELL is unset", async () => {
    const shell = process.env.SHELL;
    delete process.env.SHELL;

    try {
      const result = await runCommand(
        payload("printf done"),
        0,
        new AbortController().signal,
        vi.fn(),
        context(async () => undefined),
      );
      expect(result.exitCode).toBe(0);
    } finally {
      if (shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = shell;
    }
  });

  test("preserves raw ANSI and UTF-8 bytes in sequence", async () => {
    const uploaded: CommandOutputChunk[] = [];
    const result = await runCommand(
      payload("printf '\\033[31mred\\033[0m '; printf '🙂'"),
      1,
      new AbortController().signal,
      vi.fn(),
      context(async (_attemptId, chunks) => uploaded.push(...chunks)),
    );
    const bytes = Buffer.concat(
      uploaded
        .sort((left, right) => left.sequence - right.sequence)
        .map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
    );
    expect(bytes.toString("utf8")).toBe("\u001b[31mred\u001b[0m 🙂");
    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    });
  });

  test("does not apply the agent-job timeout", async () => {
    const result = await runCommand(
      payload("sleep 0.05; printf done"),
      1,
      new AbortController().signal,
      vi.fn(),
      context(async () => undefined),
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("retries output in order before reporting completion", async () => {
    let calls = 0;
    const sequences: number[] = [];
    const result = await runCommand(
      payload("printf first; printf second >&2"),
      0,
      new AbortController().signal,
      vi.fn(),
      context(async (_attemptId, chunks) => {
        calls += 1;
        if (calls === 1) throw new Error("temporary upload failure");
        sequences.push(...chunks.map((chunk) => chunk.sequence));
      }),
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(sequences).toEqual(
      [...sequences].sort((left, right) => left - right),
    );
    expect(result.exitCode).toBe(0);
  });

  test("terminates the detached process group on cancellation", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runCommand(
      payload("printf ready; sleep 30"),
      0,
      controller.signal,
      vi.fn(),
      context(async () => undefined),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(7_000);
  });

  test("does not keep retrying output when shutdown cancels the command", async () => {
    const controller = new AbortController();
    const append = vi.fn().mockRejectedValue(new Error("server closed"));
    const running = runCommand(
      payload("printf ready; sleep 30"),
      0,
      controller.signal,
      vi.fn(),
      context(append),
    );
    await vi.waitFor(() => expect(append).toHaveBeenCalled());

    controller.abort();

    await expect(running).resolves.toMatchObject({ cancelled: true });
  });
});
