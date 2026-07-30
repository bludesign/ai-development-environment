import { Buffer } from "node:buffer";

import {
  parseCcusageReport,
  type CcusageReport,
} from "@ai-development-environment/agent-contract";

import { findExecutable } from "../executable-lookup.js";
import {
  runProcess,
  type ProcessLog,
  type ProcessResult,
} from "../process-runner.js";

export const MAX_CCUSAGE_STDOUT_BYTES = 16 * 1024 * 1024;
export type CcusageProcessResult = ProcessResult & { report?: CcusageReport };

export function validateCcusagePayload(
  payload: unknown,
): Record<string, never> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ccusage.report payload must be an object");
  }
  const keys = Object.keys(payload);
  if (keys.length > 0) {
    throw new Error(`Unexpected ccusage.report payload field: ${keys[0]}`);
  }
  return {};
}

export async function runCcusage(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onLog: (log: ProcessLog) => Promise<void>,
): Promise<CcusageProcessResult> {
  validateCcusagePayload(payload);
  const command = findExecutable("ccusage", {
    overrideVariable: "CONTROL_AGENT_CCUSAGE_EXECUTABLE",
  });
  if (!command) {
    throw new Error(
      "ccusage was not found. Install it (brew install ccusage, or npm install -g ccusage) or set CONTROL_AGENT_CCUSAGE_EXECUTABLE to its full path.",
    );
  }
  const stdout: string[] = [];
  let stdoutBytes = 0;
  let exceededLimit = false;

  const result = await runProcess({
    command,
    args: ["--json"],
    timeoutMs,
    signal,
    onLog: async (log) => {
      if (log.stream !== "STDOUT") {
        await onLog(log);
        return;
      }
      const lineBytes = Buffer.byteLength(log.message, "utf8") + 1;
      if (stdoutBytes + lineBytes > MAX_CCUSAGE_STDOUT_BYTES) {
        exceededLimit = true;
        return;
      }
      stdoutBytes += lineBytes;
      stdout.push(log.message);
    },
  });

  if (
    result.exitCode !== 0 ||
    result.cancelled ||
    result.timedOut ||
    result.signal !== null
  ) {
    return result;
  }
  if (exceededLimit) {
    throw new Error(
      `ccusage JSON exceeded the ${MAX_CCUSAGE_STDOUT_BYTES} byte limit`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.join("\n"));
  } catch {
    throw new Error("ccusage returned malformed JSON");
  }

  return { ...result, report: parseCcusageReport(parsed) };
}
