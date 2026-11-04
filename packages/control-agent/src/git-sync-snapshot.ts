import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { captureCommand } from "./capture-command.js";
import { withRepositoryMetadata } from "./repository-metadata.js";

export type PushLease = {
  version: 2;
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
  allowMissing = false,
): Promise<string> {
  const result = await captureCommand({
    command: "git",
    args: ["-C", folder, ...args],
    timeoutMs,
    signal,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (
    allowMissing &&
    result.exitCode === 1 &&
    !result.cancelled &&
    !result.timedOut
  )
    return "";
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
    ["for-each-ref", "--format=%(push:remotename)", `refs/heads/${branch}`],
    timeoutMs,
    signal,
  );
  const pushUrls = await git(
    folder,
    ["remote", "get-url", "--push", "--all", remote],
    timeoutMs,
    signal,
  );
  if (!remote || pushUrls.split("\n").length !== 1)
    throw new Error(
      "Configure a single push destination before syncing or force pushing",
    );
  // Let Git apply push.default, pushRemote, pushDefault and configured refspecs.
  // Avoid running pre-push hooks twice; the real push still runs them normally.
  const preview = await git(
    folder,
    ["push", "--dry-run", "--porcelain", "--force-with-lease", "--no-verify"],
    timeoutMs,
    signal,
  );
  const updates = preview.split("\n").flatMap((line) => {
    const match = /^[ =*+!-]\t([^:\t]*):([^\t]+)\t/.exec(line);
    return match ? [{ source: match[1]!, ref: match[2]! }] : [];
  });
  const update = updates[0];
  if (
    updates.length !== 1 ||
    (update?.source !== `refs/heads/${branch}` && update?.source !== "HEAD") ||
    !update.ref.startsWith("refs/heads/")
  )
    throw new Error(
      "Configure a single push refspec for the current branch before syncing or force pushing",
    );
  const ref = update.ref;
  // Use the same local tracking ref as Git's implicit lease. Reading the remote
  // tip here would strengthen the lease to include commits we have not fetched.
  const fetchRefspecs = await git(
    folder,
    ["config", "--get-all", `remote.${remote}.fetch`],
    timeoutMs,
    signal,
    true,
  );
  let trackingRef: string | undefined;
  for (const refspec of fetchRefspecs.split("\n")) {
    const [source, destination] = refspec.replace(/^\+/, "").split(":");
    if (!source || !destination || source.startsWith("^")) continue;
    const wildcard = source.indexOf("*");
    if (wildcard < 0) {
      if (source !== ref) continue;
      trackingRef = destination;
    } else {
      const prefix = source.slice(0, wildcard);
      const suffix = source.slice(wildcard + 1);
      if (
        ref.length < prefix.length + suffix.length ||
        !ref.startsWith(prefix) ||
        !ref.endsWith(suffix)
      )
        continue;
      const matched = ref.slice(prefix.length, ref.length - suffix.length);
      trackingRef = destination.replace("*", matched);
    }
    break;
  }
  const sha = trackingRef
    ? await git(
        folder,
        ["rev-parse", "--verify", "--quiet", trackingRef],
        timeoutMs,
        signal,
        true,
      )
    : "";
  if (sha && !/^[a-f\d]{40,64}$/i.test(sha))
    throw new Error("The branch has no usable push lease");
  return { version: 2, branch, remote, ref, sha };
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
    lease.version !== 2 ||
    lease.branch !== branch ||
    typeof lease.remote !== "string" ||
    !lease.remote ||
    typeof lease.ref !== "string" ||
    !lease.ref.startsWith("refs/heads/") ||
    typeof lease.sha !== "string" ||
    (lease.sha !== "" && !/^[a-f\d]{40,64}$/i.test(lease.sha))
  )
    throw new Error(
      "The original Sync push lease is invalid; sync again before pushing",
    );
  return lease;
}

export const clearSyncPushLease = (gitDirectory: string) =>
  rm(leaseFile(gitDirectory), { force: true });
