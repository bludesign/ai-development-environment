import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../process-runner.js", () => ({ runProcess: vi.fn() }));

import { runProcess } from "../process-runner.js";

import {
  MAX_CCUSAGE_STDOUT_BYTES,
  runCcusage,
  validateCcusagePayload,
} from "./ccusage.js";

const runProcessMock = vi.mocked(runProcess);

const processResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
};

const validReport = {
  daily: [
    {
      agent: "all",
      period: "2026-07-16",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      totalTokens: 100,
      totalCost: 1.25,
      metadata: { agents: ["codex"] },
      modelsUsed: ["gpt-5"],
      modelBreakdowns: [
        {
          modelName: "gpt-5",
          inputTokens: 10,
          outputTokens: 20,
          cacheCreationTokens: 30,
          cacheReadTokens: 40,
          cost: 1.25,
        },
      ],
    },
  ],
  totals: {
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 30,
    cacheReadTokens: 40,
    totalTokens: 100,
    totalCost: 1.25,
  },
};

describe("ccusage handler", () => {
  beforeEach(() => {
    runProcessMock.mockReset();
  });

  test("accepts only an empty object payload", () => {
    expect(validateCcusagePayload({})).toEqual({});
    expect(() => validateCcusagePayload(null)).toThrow("must be an object");
    expect(() =>
      validateCcusagePayload({ args: ["--since", "today"] }),
    ).toThrow("Unexpected ccusage.report payload field");
  });

  test("runs the fixed JSON command, validates stdout, and forwards diagnostics", async () => {
    const onLog = vi.fn().mockResolvedValue(undefined);
    runProcessMock.mockImplementation(async (options) => {
      await options.onLog({
        sequence: 0,
        stream: "STDOUT",
        message: JSON.stringify(validReport),
        createdAt: new Date(0).toISOString(),
      });
      await options.onLog({
        sequence: 1,
        stream: "STDERR",
        message: "pricing cache warning",
        createdAt: new Date(0).toISOString(),
      });
      return processResult;
    });

    const result = await runCcusage(
      {},
      120_000,
      new AbortController().signal,
      onLog,
    );

    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "ccusage", args: ["--json"] }),
    );
    expect(result).toEqual({ ...processResult, report: validReport });
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog.mock.calls[0]?.[0].stream).toBe("STDERR");
  });

  test("returns a non-zero process result without parsing stdout", async () => {
    runProcessMock.mockResolvedValue({ ...processResult, exitCode: 2 });
    await expect(
      runCcusage({}, 120_000, new AbortController().signal, vi.fn()),
    ).resolves.toEqual({ ...processResult, exitCode: 2 });
  });

  test("rejects malformed and oversized JSON output", async () => {
    runProcessMock.mockImplementationOnce(async (options) => {
      await options.onLog({
        sequence: 0,
        stream: "STDOUT",
        message: "not json",
        createdAt: new Date(0).toISOString(),
      });
      return processResult;
    });
    await expect(
      runCcusage({}, 120_000, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("malformed JSON");

    runProcessMock.mockImplementationOnce(async (options) => {
      await options.onLog({
        sequence: 0,
        stream: "STDOUT",
        message: "x".repeat(MAX_CCUSAGE_STDOUT_BYTES),
        createdAt: new Date(0).toISOString(),
      });
      return processResult;
    });
    await expect(
      runCcusage({}, 120_000, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("exceeded");
  });

  test("rejects JSON that does not match the ccusage report contract", async () => {
    runProcessMock.mockImplementationOnce(async (options) => {
      await options.onLog({
        sequence: 0,
        stream: "STDOUT",
        message: JSON.stringify({ daily: [], totals: {} }),
        createdAt: new Date(0).toISOString(),
      });
      return processResult;
    });
    await expect(
      runCcusage({}, 120_000, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("ccusage.totals.inputTokens");
  });

  test("surfaces a missing ccusage executable", async () => {
    runProcessMock.mockRejectedValue(new Error("spawn ccusage ENOENT"));
    await expect(
      runCcusage({}, 120_000, new AbortController().signal, vi.fn()),
    ).rejects.toThrow("ENOENT");
  });
});
