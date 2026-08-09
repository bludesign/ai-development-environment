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

import { runProcess, type ProcessLog } from "../process-runner.js";

const CONCURRENCY = 4;
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

function clean(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

function appendWithinLimit(
  current: string,
  line: string,
  retainedBytes: number,
): { value: string; retainedBytes: number; truncated: boolean } {
  const addition = current ? `\n${line}` : line;
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

export async function runCliHealthCheck(
  check: CliHealthCheckDefinition,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
  options: { timeoutMs?: number; shell?: string; cwd?: string } = {},
): Promise<CliHealthCheckResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let retainedBytes = 0;
  let outputTruncated = false;
  try {
    const shell = options.shell || process.env.SHELL || "/bin/sh";
    const result = await runProcess({
      command: shell,
      args: ["-lc", check.command],
      cwd: options.cwd || homedir(),
      timeoutMs: options.timeoutMs ?? CLI_HEALTH_CHECK_TIMEOUT_MS,
      signal,
      onLog: async (log) => {
        const message = clean(log.message);
        if (log.stream === "STDOUT") {
          const appended = appendWithinLimit(stdout, message, retainedBytes);
          stdout = appended.value;
          retainedBytes = appended.retainedBytes;
          outputTruncated ||= appended.truncated;
        } else {
          const appended = appendWithinLimit(stderr, message, retainedBytes);
          stderr = appended.value;
          retainedBytes = appended.retainedBytes;
          outputTruncated ||= appended.truncated;
        }
        await onLog({ ...log, message: `[${check.name}] ${message}` });
      },
    });
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
    return {
      ...check,
      exitCode: null,
      stdout,
      stderr: stderr || launchError,
      durationMs: Date.now() - started,
      checkedAt,
      timedOut: false,
      launchError,
      outputTruncated,
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
  const worker = async () => {
    while (!signal.aborted) {
      const index = next++;
      if (index >= checks.length) return;
      results[index] = await runCliHealthCheck(checks[index], signal, onLog);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, checks.length) }, worker),
  );
  return {
    exitCode: signal.aborted ? null : 0,
    signal: null,
    timedOut: false,
    cancelled: signal.aborted,
    checks: results.filter(Boolean),
  };
}
