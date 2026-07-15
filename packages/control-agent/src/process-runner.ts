import { spawn } from "node:child_process";

export type ProcessLog = {
  sequence: number;
  stream: "STDOUT" | "STDERR" | "SYSTEM";
  message: string;
  createdAt: string;
};

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
};

type RunProcessOptions = {
  command: string;
  args: string[];
  timeoutMs: number;
  signal: AbortSignal;
  onLog: (log: ProcessLog) => Promise<void>;
};

export async function runProcess(
  options: RunProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let sequence = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let logChain = Promise.resolve();

    const child = spawn(options.command, options.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const emit = (stream: ProcessLog["stream"], message: string) => {
      const log = {
        sequence: sequence++,
        stream,
        message,
        createdAt: new Date().toISOString(),
      };
      logChain = logChain.then(async () => {
        try {
          await options.onLog(log);
        } catch (error) {
          console.error(
            `Could not append process log ${log.sequence}:`,
            error instanceof Error ? error.message : error,
          );
        }
      });
    };

    const attach = (
      stream: NodeJS.ReadableStream,
      kind: ProcessLog["stream"],
    ) => {
      let remainder = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = `${remainder}${chunk}`.split(/\r?\n/);
        remainder = parts.pop() ?? "";
        for (const line of parts) emit(kind, line);
      });
      stream.on("end", () => {
        if (remainder) emit(kind, remainder);
      });
    };

    attach(child.stdout, "STDOUT");
    attach(child.stderr, "STDERR");

    const terminate = () => {
      if (child.exitCode !== null || child.killed) return;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      emit(
        "SYSTEM",
        `Process exceeded its ${Math.round(options.timeoutMs / 1000)} second timeout`,
      );
      terminate();
    }, options.timeoutMs);
    timeout.unref();

    const abort = () => {
      cancelled = true;
      emit("SYSTEM", "Cancellation requested");
      terminate();
    };
    options.signal.addEventListener("abort", abort, { once: true });

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
      void logChain.then(() =>
        resolve({ exitCode, signal, timedOut, cancelled }),
      );
    });
  });
}
