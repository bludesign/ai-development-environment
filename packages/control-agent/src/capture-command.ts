import { spawn } from "node:child_process";

import type { ProcessResult } from "./process-runner.js";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type CaptureResult = ProcessResult & {
  stdout: string;
  stderr: string;
};

export function captureCommand(options: {
  command: string;
  args: string[];
  timeoutMs: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const child = spawn(options.command, options.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      cwd: options.cwd,
    });
    const append = (current: string, chunk: Buffer | string) =>
      `${current}${String(chunk)}`.slice(0, MAX_OUTPUT_BYTES);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const terminate = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      timer.unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timeout.unref();
    const abort = () => {
      cancelled = true;
      terminate();
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      resolve({
        exitCode,
        signal,
        timedOut,
        cancelled,
        stdout,
        stderr,
      });
    });
  });
}
