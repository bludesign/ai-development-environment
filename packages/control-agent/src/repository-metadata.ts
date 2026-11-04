import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { captureCommand } from "./capture-command.js";

const owners = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();

/** Serialize shared Git metadata without leasing any checkout for the duration. */
export async function withRepositoryMetadata<T>(
  folder: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const result = await captureCommand({
    command: "git",
    args: [
      "-C",
      folder,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    timeoutMs: 30_000,
    signal: signal ?? new AbortController().signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Could not resolve shared Git metadata");
  }
  const directory = result.stdout.trim();
  const key = await realpath(
    isAbsolute(directory) ? directory : resolve(folder, directory),
  );
  return withMetadataKey(key, task, signal);
}

/** Also used for atomic read/modify/write of a resolved shared metadata file. */
export async function withMetadataKey<T>(
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const held = owners.getStore();
  if (held?.has(key)) return task();
  const previous = tails.get(key) ?? Promise.resolve();
  const release = Promise.withResolvers<void>();
  const tail = previous.then(() => release.promise);
  tails.set(key, tail);
  const finish = () => {
    release.resolve();
    if (tails.get(key) === tail) tails.delete(key);
  };
  let acquired = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      void previous.then(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      if (signal?.aborted) abort();
    });
    acquired = true;
    signal?.throwIfAborted();
    return await owners.run(new Set([...(held ?? []), key]), task);
  } finally {
    // A cancelled waiter retains its queue link until its predecessor finishes.
    if (acquired) finish();
    else void previous.then(finish);
  }
}
