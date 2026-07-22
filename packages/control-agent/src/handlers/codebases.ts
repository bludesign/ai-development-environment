import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  codebaseBrowsePayload,
  codebaseGitInspectPayload,
  codebaseGitOperationPayload,
  codebaseJobPayload,
  MAX_CODEBASE_GIT_BRANCHES,
  MAX_CODEBASE_STASHES,
  MAX_CODEBASE_STASH_PATCH_BYTES,
  normalizeGitOrigin,
  type CodebaseDirectoryListing,
  type CodebaseGitState,
  type CodebaseSnapshot,
  type CodebaseStash,
} from "@ai-development-environment/agent-contract/codebases";

import { captureCommand, type CaptureResult } from "../capture-command.js";
import type { AgentJobHandler } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

class InterruptedGitInspection extends Error {
  constructor(readonly result: CaptureResult) {
    super(
      result.cancelled
        ? "Git inspection was cancelled"
        : "Git inspection timed out",
    );
  }
}

function cleanError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
    .slice(0, 2_000);
}

async function git(
  folder: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CaptureResult> {
  const result = await captureCommand({
    command: "git",
    args: ["-C", folder, ...args],
    timeoutMs,
    signal,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (result.cancelled || result.timedOut) {
    throw new InterruptedGitInspection(result);
  }
  return result;
}

async function mutatingGit(
  folder: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CaptureResult> {
  const result = await captureCommand({
    command: "git",
    args: ["-C", folder, ...args],
    timeoutMs,
    signal,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.cancelled || result.timedOut) {
    throw new InterruptedGitInspection(result);
  }
  return result;
}

function requireSuccess(
  result: CaptureResult,
  fallback: string,
): CaptureResult {
  if (result.exitCode !== 0) {
    throw new Error(cleanError(result.stderr || fallback));
  }
  return result;
}

function baseSnapshot(folder: string): CodebaseSnapshot {
  return {
    folder,
    observedOrigin: null,
    canonicalOrigin: null,
    displayOrigin: null,
    branch: null,
    headSha: null,
    upstream: null,
    ahead: null,
    behind: null,
    syncState: "UNKNOWN",
    availability: "ERROR",
    error: null,
    checkedAt: new Date().toISOString(),
    fetchedAt: null,
    linkedWorktree: false,
  };
}

async function fetchedAt(commonDirectory: string): Promise<string | null> {
  try {
    return (
      await stat(join(commonDirectory, "FETCH_HEAD"))
    ).mtime.toISOString();
  } catch {
    return null;
  }
}

async function inspectCodebaseProcess(
  selectedFolder: string,
  timeoutMs: number,
  signal: AbortSignal,
  expectedOrigin?: string,
): Promise<
  (typeof successfulProcess & { snapshot: CodebaseSnapshot }) | CaptureResult
> {
  const fallbackFolder = resolve(selectedFolder);
  const base = baseSnapshot(fallbackFolder);
  let selected: string;
  try {
    selected = await realpath(fallbackFolder);
    if (!(await stat(selected)).isDirectory())
      throw new Error("Folder is not a directory");
  } catch (error) {
    return {
      ...successfulProcess,
      snapshot: {
        ...base,
        availability: "MISSING",
        error: cleanError(error),
      },
    };
  }

  try {
    const rootResult = await git(
      selected,
      ["rev-parse", "--show-toplevel"],
      timeoutMs,
      signal,
    );
    if (rootResult.exitCode !== 0) {
      return {
        ...successfulProcess,
        snapshot: {
          ...base,
          folder: selected,
          availability: "NOT_REPOSITORY",
          error: cleanError(
            rootResult.stderr || "Folder is not a Git repository",
          ),
        },
      };
    }
    const folder = await realpath(rootResult.stdout.trim());
    const bare = await git(
      folder,
      ["rev-parse", "--is-bare-repository"],
      timeoutMs,
      signal,
    );
    if (bare.stdout.trim() === "true") {
      return {
        ...successfulProcess,
        snapshot: {
          ...base,
          folder,
          availability: "NOT_REPOSITORY",
          error: "Bare repositories are not supported",
        },
      };
    }
    const [
      gitDirectoryResult,
      commonDirectoryResult,
      originResult,
      headResult,
    ] = await Promise.all([
      git(
        folder,
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        timeoutMs,
        signal,
      ),
      git(
        folder,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        timeoutMs,
        signal,
      ),
      git(folder, ["remote", "get-url", "origin"], timeoutMs, signal),
      git(folder, ["rev-parse", "HEAD"], timeoutMs, signal),
    ]);
    if (originResult.exitCode !== 0) {
      return {
        ...successfulProcess,
        snapshot: {
          ...base,
          folder,
          availability: "ERROR",
          error: "Repository does not have an origin remote",
        },
      };
    }
    const origin = normalizeGitOrigin(originResult.stdout.trim());
    const gitDirectory = await realpath(gitDirectoryResult.stdout.trim());
    const commonDirectory = await realpath(commonDirectoryResult.stdout.trim());
    const linkedWorktree = gitDirectory !== commonDirectory;
    const branchResult = await git(
      folder,
      ["symbolic-ref", "--short", "-q", "HEAD"],
      timeoutMs,
      signal,
    );
    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    const upstreamResult = branch
      ? await git(
          folder,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          timeoutMs,
          signal,
        )
      : null;
    const upstream =
      upstreamResult?.exitCode === 0 ? upstreamResult.stdout.trim() : null;
    let ahead: number | null = null;
    let behind: number | null = null;
    if (upstream) {
      const counts = await git(
        folder,
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        timeoutMs,
        signal,
      );
      if (counts.exitCode === 0) {
        const [left, right] = counts.stdout.trim().split(/\s+/).map(Number);
        if (Number.isInteger(left) && Number.isInteger(right)) {
          ahead = left;
          behind = right;
        }
      }
    }
    const syncState = !branch
      ? "DETACHED"
      : !upstream
        ? "NO_UPSTREAM"
        : ahead === null || behind === null
          ? "UNKNOWN"
          : ahead > 0 && behind > 0
            ? "DIVERGED"
            : ahead > 0
              ? "AHEAD"
              : behind > 0
                ? "BEHIND"
                : "IN_SYNC";
    const mismatch =
      expectedOrigin !== undefined && origin.canonicalOrigin !== expectedOrigin;
    return {
      ...successfulProcess,
      snapshot: {
        folder,
        observedOrigin: origin.sanitizedOrigin,
        canonicalOrigin: origin.canonicalOrigin,
        displayOrigin: origin.displayOrigin,
        branch,
        headSha: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
        upstream,
        ahead,
        behind,
        syncState,
        availability: mismatch ? "ORIGIN_MISMATCH" : "AVAILABLE",
        error: mismatch ? `Origin changed to ${origin.displayOrigin}` : null,
        checkedAt: new Date().toISOString(),
        fetchedAt: await fetchedAt(commonDirectory),
        linkedWorktree,
      },
    };
  } catch (error) {
    if (error instanceof InterruptedGitInspection) return error.result;
    return {
      ...successfulProcess,
      snapshot: {
        ...base,
        folder: selected,
        availability: "ERROR",
        error: cleanError(error),
      },
    };
  }
}

export async function inspectCodebase(
  selectedFolder: string,
  timeoutMs: number,
  signal: AbortSignal,
  expectedOrigin?: string,
): Promise<CodebaseSnapshot> {
  const result = await inspectCodebaseProcess(
    selectedFolder,
    timeoutMs,
    signal,
    expectedOrigin,
  );
  if (!("snapshot" in result)) {
    throw new Error(
      result.cancelled
        ? "Git inspection was cancelled"
        : "Git inspection timed out",
    );
  }
  return result.snapshot;
}

export const browseCodebaseDirectories: AgentJobHandler = async (payload) => {
  const input = codebaseBrowsePayload(payload);
  const homePath = await realpath(homedir());
  const path = await realpath(input.path ? resolve(input.path) : homePath);
  if (!(await stat(path)).isDirectory())
    throw new Error("Path is not a directory");
  const candidates = await readdir(path, { withFileTypes: true });
  const entries: CodebaseDirectoryListing["entries"] = [];
  for (const candidate of candidates) {
    if (candidate.isDirectory()) {
      entries.push({
        name: candidate.name,
        path: join(path, candidate.name),
        hidden: candidate.name.startsWith("."),
      });
    } else if (candidate.isSymbolicLink()) {
      try {
        const target = join(path, candidate.name);
        if ((await stat(target)).isDirectory()) {
          entries.push({
            name: candidate.name,
            path: target,
            hidden: candidate.name.startsWith("."),
          });
        }
      } catch {
        // Ignore unreadable or broken directory links.
      }
    }
  }
  entries.sort((first, second) => first.name.localeCompare(second.name));
  const listing: CodebaseDirectoryListing = {
    path,
    parentPath: dirname(path) === path ? null : dirname(path),
    homePath,
    entries: entries.slice(0, 1_000),
    truncated: entries.length > 1_000,
  };
  return { ...successfulProcess, listing };
};

export const inspectCodebaseFolder: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = codebaseJobPayload(payload);
  return inspectCodebaseProcess(input.folder, timeoutMs, signal);
};

export const refreshCodebase: AgentJobHandler = inspectCodebaseFolder;

export async function updateBaseBranchAfterFetch(
  folder: string,
  baseBranch: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const localRef = `refs/heads/${baseBranch}`;
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  try {
    const validRef = await git(
      folder,
      ["check-ref-format", localRef],
      timeoutMs,
      signal,
    );
    if (validRef.exitCode !== 0) return false;

    const staged = await git(
      folder,
      ["diff", "--cached", "--quiet"],
      timeoutMs,
      signal,
    );
    if (staged.exitCode !== 0) return false;

    const remoteExists = await git(
      folder,
      ["show-ref", "--verify", "--quiet", remoteRef],
      timeoutMs,
      signal,
    );
    if (remoteExists.exitCode !== 0) return false;

    const currentBranch = await git(
      folder,
      ["symbolic-ref", "--short", "-q", "HEAD"],
      timeoutMs,
      signal,
    );
    if (
      currentBranch.exitCode === 0 &&
      currentBranch.stdout.trim() === baseBranch
    ) {
      const merged = await git(
        folder,
        ["merge", "--ff-only", remoteRef],
        timeoutMs,
        signal,
      );
      return merged.exitCode === 0;
    }

    const localExists = await git(
      folder,
      ["show-ref", "--verify", "--quiet", localRef],
      timeoutMs,
      signal,
    );
    if (localExists.exitCode === 0) {
      const fastForward = await git(
        folder,
        ["merge-base", "--is-ancestor", localRef, remoteRef],
        timeoutMs,
        signal,
      );
      if (fastForward.exitCode !== 0) return false;
    } else if (localExists.exitCode !== 1) {
      return false;
    }

    const updated = await git(
      folder,
      ["branch", "--force", baseBranch, remoteRef],
      timeoutMs,
      signal,
    );
    return updated.exitCode === 0;
  } catch {
    return false;
  }
}

export const fetchCodebase: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = codebaseJobPayload(payload);
  const beforeResult = await inspectCodebaseProcess(
    input.folder,
    Math.min(timeoutMs, 30_000),
    signal,
    input.expectedOrigin,
  );
  if (!("snapshot" in beforeResult)) return beforeResult;
  const before = beforeResult.snapshot;
  if (before.availability !== "AVAILABLE") {
    return { ...successfulProcess, exitCode: 1, snapshot: before };
  }
  let result: CaptureResult;
  try {
    result = await git(input.folder, ["fetch", "origin"], timeoutMs, signal);
  } catch (error) {
    if (error instanceof InterruptedGitInspection) return error.result;
    throw error;
  }
  if (
    result.exitCode === 0 &&
    input.keepBaseBranchUpToDate &&
    input.baseBranch
  ) {
    await updateBaseBranchAfterFetch(
      input.folder,
      input.baseBranch,
      timeoutMs,
      signal,
    );
  }
  const afterResult = await inspectCodebaseProcess(
    input.folder,
    Math.min(timeoutMs, 30_000),
    signal,
    input.expectedOrigin,
  );
  if (!("snapshot" in afterResult)) return afterResult;
  const snapshot = afterResult.snapshot;
  if (result.exitCode !== 0) {
    snapshot.error = cleanError(result.stderr || "Git fetch failed");
  } else if (!snapshot.fetchedAt) {
    snapshot.fetchedAt = new Date().toISOString();
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    snapshot,
  };
};

async function validateGitCodebase(
  folder: string,
  expectedOrigin: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const snapshot = await inspectCodebase(
    folder,
    Math.min(timeoutMs, 30_000),
    signal,
    expectedOrigin,
  );
  if (snapshot.availability !== "AVAILABLE") {
    throw new Error(snapshot.error || "Codebase is unavailable");
  }
  return snapshot.folder;
}

/**
 * The branch tip's subject and commit date, appended to a `for-each-ref`
 * format so listing branches stays a single Git call.
 */
const TIP_FORMAT = "%(contents:subject)%00%(committerdate:iso-strict)";

/** A NUL-separated `for-each-ref` line, split into its fields. */
function refFields(value: string): string[][] {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.split("\0"));
}

/** Empty `for-each-ref` fields mean "unset", which the contract sends as null. */
function refField(fields: string[], index: number): string | null {
  return fields[index]?.trim() || null;
}

/** Normalizes Git's local-offset dates to UTC, dropping anything unparseable. */
function isoDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function parsedRefLines(value: string): Array<[string, string | null]> {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\0");
      if (separator < 0) return [line, null];
      return [
        line.slice(0, separator),
        line.slice(separator + 1).trim() || null,
      ];
    });
}

async function inspectStashes(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ stashes: CodebaseStash[]; truncated: boolean }> {
  const result = requireSuccess(
    await git(
      folder,
      [
        "stash",
        "list",
        `--max-count=${MAX_CODEBASE_STASHES + 1}`,
        "--format=%H%x00%gd%x00%ci%x00%gs",
      ],
      timeoutMs,
      signal,
    ),
    "Could not list stashes",
  );
  const stashes = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid = "", selector = "", date = "", ...message] = line.split("\0");
      const createdAt = new Date(date);
      if (!oid || !selector || Number.isNaN(createdAt.valueOf())) {
        throw new Error("Git returned an invalid stash entry");
      }
      return {
        oid: oid.toLowerCase(),
        selector,
        message: message.join("\0"),
        createdAt: createdAt.toISOString(),
      };
    });
  return {
    stashes: stashes.slice(0, MAX_CODEBASE_STASHES),
    truncated: stashes.length > MAX_CODEBASE_STASHES,
  };
}

export async function inspectCodebaseGitState(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CodebaseGitState> {
  const [currentResult, statusResult, localResult, remoteResult, stashResult] =
    await Promise.all([
      git(folder, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs, signal),
      git(
        folder,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        timeoutMs,
        signal,
      ),
      git(
        folder,
        [
          "for-each-ref",
          `--format=%(refname:strip=2)%00%(worktreepath)%00${TIP_FORMAT}`,
          "refs/heads",
        ],
        timeoutMs,
        signal,
      ),
      git(
        folder,
        [
          "for-each-ref",
          `--format=%(refname:strip=3)%00${TIP_FORMAT}`,
          "refs/remotes/origin",
        ],
        timeoutMs,
        signal,
      ),
      inspectStashes(folder, timeoutMs, signal),
    ]);
  requireSuccess(statusResult, "Could not inspect codebase changes");
  requireSuccess(localResult, "Could not list local branches");
  requireSuccess(remoteResult, "Could not list remote branches");
  const current =
    currentResult.exitCode === 0 ? currentResult.stdout.trim() : null;
  const branches = new Map<string, CodebaseGitState["branches"][number]>();
  for (const fields of refFields(localResult.stdout)) {
    const name = fields[0]?.trim();
    if (!name) continue;
    branches.set(name, {
      name,
      local: true,
      remote: false,
      current: name === current,
      checkedOutPath: refField(fields, 1),
      lastCommitMessage: refField(fields, 2),
      lastCommitAt: isoDate(refField(fields, 3)),
    });
  }
  for (const fields of refFields(remoteResult.stdout)) {
    const name = fields[0]?.trim();
    if (!name || name === "HEAD") continue;
    const existing = branches.get(name);
    if (existing) {
      existing.remote = true;
      // A local branch may sit behind its remote, so prefer whichever tip is
      // newer rather than always keeping the local one.
      const remoteAt = isoDate(refField(fields, 2));
      if (
        remoteAt &&
        (!existing.lastCommitAt || remoteAt > existing.lastCommitAt)
      ) {
        existing.lastCommitMessage = refField(fields, 1);
        existing.lastCommitAt = remoteAt;
      }
      continue;
    }
    branches.set(name, {
      name,
      local: false,
      remote: true,
      current: false,
      checkedOutPath: null,
      lastCommitMessage: refField(fields, 1),
      lastCommitAt: isoDate(refField(fields, 2)),
    });
  }
  const sorted = [...branches.values()].sort((first, second) =>
    first.name.localeCompare(second.name),
  );
  return {
    dirty: Boolean(statusResult.stdout),
    branches: sorted.slice(0, MAX_CODEBASE_GIT_BRANCHES),
    branchesTruncated: sorted.length > MAX_CODEBASE_GIT_BRANCHES,
    stashes: stashResult.stashes,
    stashesTruncated: stashResult.truncated,
  };
}

async function resolveStashSelector(
  folder: string,
  oid: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const result = requireSuccess(
    await git(
      folder,
      ["reflog", "show", "--format=%H%x00%gd", "refs/stash"],
      timeoutMs,
      signal,
    ),
    "Could not resolve the stash",
  );
  const match = parsedRefLines(result.stdout).find(
    ([candidate]) => candidate.toLowerCase() === oid.toLowerCase(),
  );
  if (!match?.[1]) {
    throw new Error(
      "The selected stash no longer exists; refresh and try again",
    );
  }
  return match[1];
}

function truncateUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, "utf8");
  return {
    value:
      buffer.byteLength <= maxBytes
        ? value
        : buffer
            .subarray(0, maxBytes)
            .toString("utf8")
            .replace(/\uFFFD$/, ""),
    truncated: buffer.byteLength > maxBytes,
  };
}

export const inspectCodebaseGit: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = codebaseGitInspectPayload(payload);
  const folder = await validateGitCodebase(
    input.folder,
    input.expectedOrigin,
    timeoutMs,
    signal,
  );
  if (input.action === "STATE") {
    return {
      ...successfulProcess,
      state: await inspectCodebaseGitState(folder, timeoutMs, signal),
    };
  }
  await resolveStashSelector(folder, input.stashOid, timeoutMs, signal);
  const result = requireSuccess(
    await git(
      folder,
      [
        "stash",
        "show",
        "--stat",
        "--patch",
        "--include-untracked",
        "--no-color",
        "--no-ext-diff",
        input.stashOid,
      ],
      timeoutMs,
      signal,
    ),
    "Could not inspect the stash",
  );
  const patch = truncateUtf8(result.stdout, MAX_CODEBASE_STASH_PATCH_BYTES);
  return {
    ...successfulProcess,
    diff: {
      oid: input.stashOid,
      patch: patch.value,
      truncated: patch.truncated,
    },
  };
};

function branchFromState(state: CodebaseGitState, name: string) {
  return state.branches.find((branch) => branch.name === name) ?? null;
}

async function runSwitchBranch(
  folder: string,
  branch: string,
  stashChanges: boolean,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const state = await inspectCodebaseGitState(folder, timeoutMs, signal);
  const selected = branchFromState(state, branch);
  if (!selected?.local && !selected?.remote) {
    throw new Error(`Branch ${branch} is unavailable; refresh and try again`);
  }
  if (selected.current) return;
  if (selected.checkedOutPath) {
    throw new Error(`Branch ${branch} is checked out in another worktree`);
  }
  let stashed = false;
  if (state.dirty) {
    if (!stashChanges) {
      throw new Error("Stash or commit changes before switching branches");
    }
    const stash = requireSuccess(
      await mutatingGit(
        folder,
        [
          "stash",
          "push",
          "--include-untracked",
          "-m",
          `Automatic stash before switching to ${branch}`,
        ],
        timeoutMs,
        signal,
      ),
      "Could not stash codebase changes",
    );
    stashed = !stash.stdout.toLowerCase().includes("no local changes");
  }
  const switched = await mutatingGit(
    folder,
    selected.local
      ? ["switch", branch]
      : ["switch", "--track", "-c", branch, `refs/remotes/origin/${branch}`],
    timeoutMs,
    signal,
  );
  if (switched.exitCode !== 0) {
    throw new Error(
      `${cleanError(switched.stderr || "Could not switch branches")}${
        stashed ? ". The automatic stash was preserved." : ""
      }`,
    );
  }
}

async function runDeleteBranch(
  folder: string,
  branch: string,
  defaultBranch: string | null,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const selected = branchFromState(
    await inspectCodebaseGitState(folder, timeoutMs, signal),
    branch,
  );
  if (!selected?.local) throw new Error(`Local branch ${branch} was not found`);
  if (selected.current) throw new Error("The current branch cannot be deleted");
  if (branch === defaultBranch)
    throw new Error("The default branch cannot be deleted");
  if (selected.checkedOutPath) {
    throw new Error(`Branch ${branch} is checked out in another worktree`);
  }
  requireSuccess(
    await mutatingGit(
      folder,
      ["branch", "--delete", "--", branch],
      timeoutMs,
      signal,
    ),
    `Could not safely delete branch ${branch}`,
  );
}

export async function pullCodebaseBranch(
  folder: string,
  branch: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  requireSuccess(
    await mutatingGit(folder, ["fetch", "origin"], timeoutMs, signal),
    "Could not fetch origin",
  );
  const state = await inspectCodebaseGitState(folder, timeoutMs, signal);
  const selected = branchFromState(state, branch);
  if (!selected?.local || !selected.remote) {
    throw new Error(
      `Pull requires matching local and origin branches for ${branch}`,
    );
  }
  if (selected.checkedOutPath && !selected.current) {
    throw new Error(`Branch ${branch} is checked out in another worktree`);
  }
  if (selected.current && state.dirty) {
    throw new Error("Stash or commit changes before pulling");
  }
  const localRef = `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const ancestry = await git(
    folder,
    ["merge-base", "--is-ancestor", localRef, remoteRef],
    timeoutMs,
    signal,
  );
  if (ancestry.exitCode === 1) {
    throw new Error(`Branch ${branch} cannot be fast-forwarded from origin`);
  }
  requireSuccess(ancestry, "Could not compare local and origin branches");
  requireSuccess(
    await mutatingGit(
      folder,
      selected.current
        ? ["merge", "--ff-only", remoteRef]
        : ["branch", "--force", "--", branch, remoteRef],
      timeoutMs,
      signal,
    ),
    `Could not fast-forward branch ${branch}`,
  );
}

export async function deleteCodebaseRemoteBranch(
  folder: string,
  branch: string,
  defaultBranch: string | null,
  timeoutMs: number,
  signal: AbortSignal,
) {
  if (branch === "main") {
    throw new Error("origin/main cannot be deleted");
  }
  if (branch === defaultBranch) {
    throw new Error("The default remote branch cannot be deleted");
  }
  const state = await inspectCodebaseGitState(folder, timeoutMs, signal);
  if (!branchFromState(state, branch)?.remote) {
    throw new Error(`Remote branch origin/${branch} was not found`);
  }
  const remote = await git(
    folder,
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    timeoutMs,
    signal,
  );
  if (remote.exitCode === 2) {
    throw new Error(`Remote branch origin/${branch} no longer exists`);
  }
  requireSuccess(remote, `Could not inspect origin/${branch}`);
  requireSuccess(
    await mutatingGit(
      folder,
      ["push", "origin", "--delete", branch],
      timeoutMs,
      signal,
    ),
    `Could not delete origin/${branch}`,
  );
}

export const operateCodebaseGit: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = codebaseGitOperationPayload(payload);
  const folder = await validateGitCodebase(
    input.folder,
    input.expectedOrigin,
    timeoutMs,
    signal,
  );
  switch (input.operation) {
    case "SWITCH_BRANCH":
      await runSwitchBranch(
        folder,
        input.branch!,
        Boolean(input.stashChanges),
        timeoutMs,
        signal,
      );
      break;
    case "DELETE_BRANCH":
      await runDeleteBranch(
        folder,
        input.branch!,
        input.defaultBranch,
        timeoutMs,
        signal,
      );
      break;
    case "DELETE_REMOTE_BRANCH":
      await deleteCodebaseRemoteBranch(
        folder,
        input.branch!,
        input.defaultBranch,
        timeoutMs,
        signal,
      );
      break;
    case "PULL_BRANCH":
      await pullCodebaseBranch(folder, input.branch!, timeoutMs, signal);
      break;
    case "APPLY_STASH":
      await resolveStashSelector(folder, input.stashOid!, timeoutMs, signal);
      requireSuccess(
        await mutatingGit(
          folder,
          ["stash", "apply", input.stashOid!],
          timeoutMs,
          signal,
        ),
        "Could not apply the stash; it was retained",
      );
      break;
    case "DELETE_STASH": {
      const selector = await resolveStashSelector(
        folder,
        input.stashOid!,
        timeoutMs,
        signal,
      );
      requireSuccess(
        await mutatingGit(
          folder,
          ["stash", "drop", selector],
          timeoutMs,
          signal,
        ),
        "Could not delete the stash",
      );
      break;
    }
  }
  return {
    ...successfulProcess,
    snapshot: await inspectCodebase(
      folder,
      Math.min(timeoutMs, 30_000),
      signal,
      input.expectedOrigin,
    ),
    state: await inspectCodebaseGitState(
      folder,
      Math.min(timeoutMs, 30_000),
      signal,
    ),
  };
};
