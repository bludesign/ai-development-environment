import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { captureCommand } from "./capture-command.js";
import { withRepositoryMetadata } from "./repository-metadata.js";

export type PushLease = {
  branch: string;
  remote: string;
  ref: string;
  sha: string;
};

async function git(
  folder: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const result = await captureCommand({
    command: "git",
    args: ["-C", folder, ...args],
    timeoutMs,
    signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.cancelled || result.timedOut || result.exitCode !== 0)
    throw new Error(
      result.stderr || `Could not ${args[0]} while pinning Git references`,
    );
  return result.stdout.trim();
}

async function pushLease(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PushLease> {
  const branch = await git(
    folder,
    ["symbolic-ref", "--short", "HEAD"],
    timeoutMs,
    signal,
  );
  const remote = await git(
    folder,
    ["config", "--get", `branch.${branch}.remote`],
    timeoutMs,
    signal,
  );
  const ref = await git(
    folder,
    ["config", "--get", `branch.${branch}.merge`],
    timeoutMs,
    signal,
  );
  const sha = await git(
    folder,
    ["rev-parse", "@{upstream}"],
    timeoutMs,
    signal,
  );
  if (
    !remote ||
    !ref.startsWith("refs/heads/") ||
    !/^[a-f\d]{40,64}$/i.test(sha)
  )
    throw new Error("The branch has no usable push lease");
  return { branch, remote, ref, sha };
}

export function pinnedForcePushArguments(lease: PushLease): string[] {
  return [
    "push",
    `--force-with-lease=${lease.ref}:${lease.sha}`,
    lease.remote,
    `HEAD:${lease.ref}`,
  ];
}

/** Fetch and resolve all inputs while no sibling fetch can replace those refs. */
export async function fetchSyncSnapshot(
  folder: string,
  baseRef: string,
  timeoutMs: number,
  signal: AbortSignal,
  captureLease = true,
): Promise<{ baseSha: string; lease: PushLease | null }> {
  return withRepositoryMetadata(
    folder,
    async () => {
      await git(folder, ["fetch", "origin"], timeoutMs, signal);
      return {
        baseSha: await git(folder, ["rev-parse", baseRef], timeoutMs, signal),
        lease: captureLease ? await pushLease(folder, timeoutMs, signal) : null,
      };
    },
    signal,
  );
}

export async function snapshotPushLease(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PushLease> {
  return withRepositoryMetadata(
    folder,
    () => pushLease(folder, timeoutMs, signal),
    signal,
  );
}

export async function fetchPinnedRef(
  folder: string,
  remote: string,
  ref: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return withRepositoryMetadata(
    folder,
    async () => {
      await git(folder, ["fetch", remote], timeoutMs, signal);
      return git(folder, ["rev-parse", ref], timeoutMs, signal);
    },
    signal,
  );
}

const leaseFile = (gitDirectory: string) =>
  join(gitDirectory, "aide-sync-push-lease.json");

export async function saveSyncPushLease(
  gitDirectory: string,
  lease: PushLease,
): Promise<void> {
  const destination = leaseFile(gitDirectory);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readSyncPushLease(
  gitDirectory: string,
  branch: string,
): Promise<PushLease> {
  let lease: PushLease;
  try {
    lease = JSON.parse(
      await readFile(leaseFile(gitDirectory), "utf8"),
    ) as PushLease;
  } catch {
    throw new Error(
      "The original Sync push lease is unavailable; sync again before pushing",
    );
  }
  if (
    lease.branch !== branch ||
    typeof lease.remote !== "string" ||
    !lease.remote ||
    typeof lease.ref !== "string" ||
    !lease.ref.startsWith("refs/heads/") ||
    typeof lease.sha !== "string" ||
    !/^[a-f\d]{40,64}$/i.test(lease.sha)
  )
    throw new Error(
      "The original Sync push lease is invalid; sync again before pushing",
    );
  return lease;
}

export const clearSyncPushLease = (gitDirectory: string) =>
  rm(leaseFile(gitDirectory), { force: true });
