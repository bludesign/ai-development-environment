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

function remainingTimeoutMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function containedPath(folder: string, path: string): string | null {
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
  return absolutePath;
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
        "--no-textconv",
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
  const deadline = Date.now() + timeoutMs;
  const operation = new AbortController();
  const abort = () => operation.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => operation.abort(), Math.max(0, timeoutMs));
  timeout.unref();

  try {
    operation.signal.throwIfAborted();
    const [head, untracked, submodules] = await Promise.all([
      captureCommand({
        command: "git",
        args: ["-C", folder, "rev-parse", "HEAD"],
        timeoutMs: remainingTimeoutMs(deadline),
        signal: operation.signal,
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
        timeoutMs: remainingTimeoutMs(deadline),
        signal: operation.signal,
        env: gitEnvironment(),
      }),
      captureCommand({
        command: "git",
        args: [
          "-C",
          folder,
          "--no-optional-locks",
          "submodule",
          "foreach",
          "--quiet",
          'printf "%s\\0" "$sm_path"',
        ],
        timeoutMs: remainingTimeoutMs(deadline),
        signal: operation.signal,
        env: gitEnvironment(),
      }),
    ]);
    if (
      head.exitCode !== 0 ||
      untracked.exitCode !== 0 ||
      submodules.exitCode !== 0 ||
      operation.signal.aborted
    ) {
      return null;
    }
    const hash = createHash("sha256");
    hash.update("head\0");
    hash.update(head.stdout.trim());
    hash.update("\0diff\0");
    if (
      !(await hashGitDiff(
        hash,
        folder,
        remainingTimeoutMs(deadline),
        operation.signal,
      ))
    ) {
      return null;
    }
    hash.update("\0untracked\0");
    const paths = untracked.stdout.split("\0").filter(Boolean).sort();
    for (const path of paths) {
      operation.signal.throwIfAborted();
      const absolutePath = containedPath(folder, path);
      if (!absolutePath) return null;
      hash.update(path);
      hash.update("\0");
      const information = await lstat(absolutePath);
      operation.signal.throwIfAborted();
      if (information.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(await readlink(absolutePath));
      } else if (information.isFile()) {
        hash.update("file\0");
        hash.update((information.mode & 0o777).toString(8).padStart(3, "0"));
        hash.update("\0");
        for await (const chunk of createReadStream(absolutePath, {
          signal: operation.signal,
        })) {
          hash.update(chunk as Buffer);
        }
      }
      hash.update("\0");
    }
    hash.update("submodules\0");
    const submodulePaths = submodules.stdout.split("\0").filter(Boolean).sort();
    for (const path of submodulePaths) {
      operation.signal.throwIfAborted();
      const absolutePath = containedPath(folder, path);
      if (!absolutePath) return null;
      const submoduleHash = await worktreeCodeStateHash(
        absolutePath,
        remainingTimeoutMs(deadline),
        operation.signal,
      );
      if (!submoduleHash) return null;
      hash.update(path);
      hash.update("\0");
      hash.update(submoduleHash);
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
