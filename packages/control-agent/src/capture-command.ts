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
  stdoutFileDescriptor?: number;
}): Promise<CaptureResult> {
  if (options.signal.aborted || options.timeoutMs <= 0) {
    return Promise.resolve({
      exitCode: null,
      signal: null,
      timedOut: !options.signal.aborted,
      cancelled: options.signal.aborted,
      stdout: "",
      stderr: "",
    });
  }
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const detached = process.platform !== "win32";
    const child = spawn(options.command, options.args, {
      shell: false,
      stdio: [
        "ignore",
        options.stdoutFileDescriptor === undefined
          ? "pipe"
          : options.stdoutFileDescriptor,
        "pipe",
      ],
      env: options.env ?? process.env,
      cwd: options.cwd,
      // Git can leave credential helpers, SSH processes, hooks, or signing
      // prompts behind. A separate process group lets timeout and cancellation
      // stop the entire command tree instead of only the immediate Git process.
      detached,
    });
    const append = (current: string, chunk: Buffer | string) =>
      `${current}${String(chunk)}`.slice(0, MAX_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const sendSignal = (signal: NodeJS.Signals) => {
      if (detached && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          // The group can disappear or become inaccessible before Node reports
          // the child as closed. Fall back to the child handle in either case.
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            (error.code !== "ESRCH" && error.code !== "EPERM")
          ) {
            throw error;
          }
        }
      }
      try {
        child.kill(signal);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "ESRCH" && error.code !== "EPERM")
        ) {
          throw error;
        }
      }
    };
    const terminate = () => {
      if (child.exitCode !== null || child.killed) return;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null) sendSignal("SIGKILL");
      }, 5_000);
      killTimer.unref();
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
      if (killTimer) clearTimeout(killTimer);
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
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
