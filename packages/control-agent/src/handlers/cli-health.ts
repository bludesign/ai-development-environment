import { Buffer } from "node:buffer";
import { homedir } from "node:os";

import {
  CLI_HEALTH_CHECK_TIMEOUT_MS,
  CLI_HEALTH_MAX_OUTPUT_BYTES,
  parseCliHealthJobPayload,
  type CliHealthCheckDefinition,
  type CliHealthCheckResult,
  type CliHealthJobResult,
} from "@ai-development-environment/agent-contract/cli-health";

import { captureCommand } from "../capture-command.js";
import type { ProcessLog } from "../process-runner.js";

const CONCURRENCY = 4;
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

function clean(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

function lineBufferedOutput(value: string): string {
  return value.replace(/\r?\n$/, "");
}

function appendWithinLimit(
  current: string,
  line: string,
  retainedBytes: number,
): { value: string; retainedBytes: number; truncated: boolean } {
  const addition = current ? `\n${line}` : line;
  if (!addition) return { value: current, retainedBytes, truncated: false };
  const remaining = CLI_HEALTH_MAX_OUTPUT_BYTES - retainedBytes;
  if (remaining <= 0) return { value: current, retainedBytes, truncated: true };
  const bytes = Buffer.from(addition, "utf8");
  if (bytes.length <= remaining)
    return {
      value: current + addition,
      retainedBytes: retainedBytes + bytes.length,
      truncated: false,
    };
  let end = remaining;
  let retained = "";
  while (end > 0) {
    try {
      retained = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, end),
      );
      break;
    } catch {
      end -= 1;
    }
  }
  return {
    value: current + retained,
    retainedBytes: retainedBytes + Buffer.byteLength(retained, "utf8"),
    truncated: true,
  };
}

async function reportOutput(
  check: CliHealthCheckDefinition,
  stdout: string,
  stderr: string,
  createdAt: string,
  onLog: (log: ProcessLog) => Promise<void>,
): Promise<void> {
  for (const [stream, message] of [
    ["STDOUT", stdout],
    ["STDERR", stderr],
  ] as const) {
    if (!message) continue;
    try {
      await onLog({
        sequence: 0,
        stream,
        message: `[${check.name}] ${message}`,
        createdAt,
      });
    } catch (error) {
      console.error(
        `Could not append CLI health log for ${check.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

export async function runCliHealthCheck(
  check: CliHealthCheckDefinition,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
  options: { timeoutMs?: number; shell?: string; cwd?: string } = {},
): Promise<CliHealthCheckResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const shell = options.shell || process.env.SHELL || "/bin/sh";
    const timeoutMs = options.timeoutMs ?? CLI_HEALTH_CHECK_TIMEOUT_MS;
    const result = await captureCommand({
      command: shell,
      args: ["-lc", check.command],
      cwd: options.cwd || homedir(),
      timeoutMs,
      signal,
      maxOutputBytes: CLI_HEALTH_MAX_OUTPUT_BYTES,
    });
    const capturedStdout = appendWithinLimit(
      "",
      clean(lineBufferedOutput(result.stdout)),
      0,
    );
    const systemError = result.timedOut
      ? `Process exceeded its ${Math.round(timeoutMs / 1000)} second timeout`
      : result.cancelled
        ? "Cancellation requested"
        : "";
    const capturedStderr = appendWithinLimit(
      "",
      [clean(lineBufferedOutput(result.stderr)), systemError]
        .filter(Boolean)
        .join("\n"),
      capturedStdout.retainedBytes,
    );
    const stdout = capturedStdout.value;
    const stderr = capturedStderr.value;
    const outputTruncated =
      result.outputTruncated ||
      capturedStdout.truncated ||
      capturedStderr.truncated;
    await reportOutput(check, stdout, stderr, checkedAt, onLog);
    return {
      ...check,
      exitCode: result.exitCode,
      stdout,
      stderr,
      durationMs: Date.now() - started,
      checkedAt,
      timedOut: result.timedOut,
      launchError: null,
      outputTruncated,
    };
  } catch (error) {
    const launchError = clean(
      error instanceof Error ? error.message : String(error),
    );
    await reportOutput(check, "", launchError, checkedAt, onLog);
    return {
      ...check,
      exitCode: null,
      stdout: "",
      stderr: launchError,
      durationMs: Date.now() - started,
      checkedAt,
      timedOut: false,
      launchError,
      outputTruncated: false,
    };
  }
}

export async function runCliHealth(
  payload: unknown,
  _timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
): Promise<CliHealthJobResult> {
  const { checks } = parseCliHealthJobPayload(payload);
  const results = new Array<CliHealthCheckResult>(checks.length);
  let next = 0;
  let logSequence = 0;
  let logChain = Promise.resolve();
  const appendSweepLog = (log: ProcessLog) => {
    const sequenced = { ...log, sequence: logSequence++ };
    const task = logChain.then(() => onLog(sequenced));
    logChain = task.catch(() => undefined);
    return task;
  };
  const worker = async () => {
    while (!signal.aborted) {
      const index = next++;
      if (index >= checks.length) return;
      results[index] = await runCliHealthCheck(
        checks[index],
        signal,
        appendSweepLog,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, checks.length) }, worker),
  );
  await logChain;
  return {
    exitCode: signal.aborted ? null : 0,
    signal: null,
    timedOut: false,
    cancelled: signal.aborted,
    checks: results.filter(Boolean),
  };
}
