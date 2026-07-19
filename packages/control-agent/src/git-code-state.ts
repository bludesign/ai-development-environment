import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import { captureCommand } from "./capture-command.js";

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function hashGitDiff(
  hash: Hash,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(
      "git",
      [
        "-C",
        folder,
        "--no-optional-locks",
        "diff",
        "--binary",
        "--no-ext-diff",
        "HEAD",
        "--",
      ],
      {
        env: gitEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
    child.stderr.resume();
    const terminate = () => {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    timeout.unref();
    const abort = () => terminate();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolveResult(!timedOut && !signal.aborted && exitCode === 0);
    });
  });
}

export async function worktreeCodeStateHash(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const [head, untracked] = await Promise.all([
      captureCommand({
        command: "git",
        args: ["-C", folder, "rev-parse", "HEAD"],
        timeoutMs,
        signal,
        env: gitEnvironment(),
      }),
      captureCommand({
        command: "git",
        args: [
          "-C",
          folder,
          "--no-optional-locks",
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ],
        timeoutMs,
        signal,
        env: gitEnvironment(),
      }),
    ]);
    if (head.exitCode !== 0 || untracked.exitCode !== 0) return null;
    const hash = createHash("sha256");
    hash.update("head\0");
    hash.update(head.stdout.trim());
    hash.update("\0diff\0");
    if (!(await hashGitDiff(hash, folder, timeoutMs, signal))) return null;
    hash.update("\0untracked\0");
    const paths = untracked.stdout.split("\0").filter(Boolean).sort();
    for (const path of paths) {
      const absolutePath = resolve(folder, path);
      const difference = relative(folder, absolutePath);
      if (
        !difference ||
        difference === ".." ||
        difference.startsWith(`..${sep}`) ||
        isAbsolute(difference)
      ) {
        return null;
      }
      hash.update(path);
      hash.update("\0");
      const information = await lstat(absolutePath);
      if (information.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(await readlink(absolutePath));
      } else if (information.isFile()) {
        hash.update("file\0");
        for await (const chunk of createReadStream(absolutePath)) {
          hash.update(chunk as Buffer);
        }
      }
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}
