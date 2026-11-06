import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const inspection = vi.hoisted(() => ({ fail: false, calls: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFileSync: (...args: Parameters<typeof original.execFileSync>) => {
      if (args[0] === "/bin/ps") {
        inspection.calls(...args);
        if (inspection.fail)
          throw Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" });
      }
      return original.execFileSync(...args);
    },
  };
});

import { captureCommand } from "./capture-command.js";
import {
  executionCompletion,
  ProcessInspectionTimeoutError,
  recoverExecution,
  withExecutionJournal,
} from "./execution-recovery.js";

let directory: string;
const identity = { agentId: "agent", jobId: "build", executionToken: "owner" };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "execution-inspection-"));
  vi.stubEnv("CONTROL_AGENT_CONFIG", join(directory, "config.json"));
  inspection.fail = false;
  inspection.calls.mockClear();
});
afterEach(async () => {
  inspection.fail = false;
  await recoverExecution(identity);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "uses a 30-second inspection timeout and leaves completed artifacts recoverable with the claim protected",
  async () => {
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      artifacts: [{ kind: "RUNNABLE_APP", relativePath: "App.app" }],
    };
    await expect(
      withExecutionJournal(identity, async (execution) => {
        await captureCommand({
          command: process.execPath,
          args: ["-e", ""],
          timeoutMs: 10_000,
          signal: new AbortController().signal,
        });
        execution.checkpointCompletion({ status: "SUCCEEDED", result });
        inspection.fail = true;
      }),
    ).rejects.toBeInstanceOf(ProcessInspectionTimeoutError);
    expect(inspection.calls).toHaveBeenCalledWith(
      "/bin/ps",
      expect.any(Array),
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(executionCompletion(identity)).toEqual({
      status: "SUCCEEDED",
      result,
    });
    const [file] = await readdir(join(directory, "executions"));
    expect(
      JSON.parse(await readFile(join(directory, "executions", file!), "utf8"))
        .state,
    ).toBe("SETTLING");
    inspection.fail = false;
    await recoverExecution(identity);
    expect(
      JSON.parse(await readFile(join(directory, "executions", file!), "utf8"))
        .state,
    ).toBe("SETTLED");
  },
);

test("does not inspect processes when no gated command could have started", async () => {
  inspection.fail = true;
  await withExecutionJournal(identity, async () => undefined);
  expect(inspection.calls).not.toHaveBeenCalled();
});
