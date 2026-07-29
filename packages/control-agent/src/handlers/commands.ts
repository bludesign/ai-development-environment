import { spawn } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_COMMAND_OUTPUT_BATCH_CHUNKS,
  parseCommandRunPayload,
  type CommandOutputChunk,
} from "@ai-development-environment/agent-contract/commands";

import type { ProcessResult } from "../process-runner.js";
import type { AgentJobHandler } from "./index.js";

const MAX_BATCH_BYTES = 128 * 1024;
const FLUSH_DELAY_MS = 25;
const MAX_UPLOAD_ATTEMPTS = 8;

export const runCommand: AgentJobHandler = async (
  rawPayload,
  _timeoutMs,
  signal,
  _onLog,
  context,
): Promise<ProcessResult> => {
  const payload = parseCommandRunPayload(rawPayload);
  if (!context?.appendCommandOutput) {
    throw new Error("Command output uploader is unavailable");
  }

  const directory = await mkdtemp(join(tmpdir(), "aide-command-"));
  const scriptPath = join(directory, "command.sh");
  await writeFile(scriptPath, payload.script, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(scriptPath, 0o600);

  const cwd =
    payload.targetKind === "AGENT_HOME"
      ? homedir()
      : await realpath(payload.cwd as string);
  let sequence = 0;
  let queuedBytes = 0;
  let pending: CommandOutputChunk[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let uploadChain = Promise.resolve();

  const upload = (chunks: CommandOutputChunk[]) => {
    if (!chunks.length) return;
    const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    uploadChain = uploadChain.then(async () => {
      let retry = 0;
      while (true) {
        try {
          await context.appendCommandOutput?.(payload.attemptId, chunks);
          queuedBytes -= bytes;
          return;
        } catch (error) {
          // During agent shutdown the control plane may already be gone. Do
          // not keep the agent (and its command cleanup) alive retrying output
          // that can no longer be delivered.
          if (signal.aborted) return;
          // A rejected batch can be permanently invalid rather than a
          // transient outage. Retrying it forever would never settle
          // uploadChain, leaving the child's streams paused by backpressure
          // and the command hung with no output. Give up and drop the batch.
          if (++retry >= MAX_UPLOAD_ATTEMPTS) {
            queuedBytes -= bytes;
            console.error(
              `Dropping ${chunks.length} command output chunk(s) after ${retry} failed attempts:`,
              error instanceof Error ? error.message : error,
            );
            return;
          }
          const delay = Math.min(30_000, 500 * 2 ** Math.min(retry - 1, 6));
          console.error(
            `Could not append command output; retrying in ${delay}ms:`,
            error instanceof Error ? error.message : error,
          );
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              clearTimeout(retryTimer);
              resolve();
            };
            const retryTimer = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolve();
            }, delay);
            retryTimer.unref();
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
          if (signal.aborted) return;
        }
      }
    });
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    upload(batch);
  };
  const enqueue = (stream: CommandOutputChunk["stream"], bytes: Buffer) => {
    const chunk: CommandOutputChunk = {
      sequence: sequence++,
      stream,
      dataBase64: bytes.toString("base64"),
      byteLength: bytes.length,
      createdAt: new Date().toISOString(),
    };
    pending.push(chunk);
    pendingBytes += bytes.length;
    queuedBytes += bytes.length;
    // A chatty process can emit hundreds of small writes inside one flush
    // window, so cap the batch by chunk count as well as by bytes — the
    // control plane rejects batches above MAX_COMMAND_OUTPUT_BATCH_CHUNKS.
    if (
      pendingBytes >= MAX_BATCH_BYTES ||
      pending.length >= MAX_COMMAND_OUTPUT_BATCH_CHUNKS
    ) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, FLUSH_DELAY_MS);
      timer.unref();
    }
  };

  try {
    return await new Promise<ProcessResult>((resolve, reject) => {
      let cancelled = false;
      let settled = false;
      const child = spawn(process.env.SHELL || "/bin/sh", ["-l", scriptPath], {
        cwd,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          FORCE_COLOR: "1",
          CLICOLOR_FORCE: "1",
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const pauseForPressure = () => {
        if (queuedBytes < 4 * 1024 * 1024) return;
        child.stdout.pause();
        child.stderr.pause();
        void uploadChain.finally(() => {
          child.stdout.resume();
          child.stderr.resume();
        });
      };
      child.stdout.on("data", (bytes: Buffer) => {
        enqueue("STDOUT", bytes);
        pauseForPressure();
      });
      child.stderr.on("data", (bytes: Buffer) => {
        enqueue("STDERR", bytes);
        pauseForPressure();
      });

      const sendSignal = (name: NodeJS.Signals) => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, name);
          else child.kill(name);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ESRCH"
          ) {
            throw error;
          }
        }
      };
      const abort = () => {
        if (cancelled) return;
        cancelled = true;
        enqueue("SYSTEM", Buffer.from("\r\nCancellation requested\r\n"));
        sendSignal("SIGTERM");
        const killTimer = setTimeout(() => sendSignal("SIGKILL"), 5_000);
        killTimer.unref();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (exitCode, closeSignal) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        flush();
        void uploadChain.then(() =>
          resolve({
            exitCode,
            signal: closeSignal,
            timedOut: false,
            cancelled,
          }),
        );
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    await rm(directory, { force: true, recursive: true });
  }
};
