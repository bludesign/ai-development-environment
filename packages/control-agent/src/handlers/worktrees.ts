import { createWriteStream, watch, type FSWatcher } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { spawn } from "node:child_process";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import {
  worktreeBranchJobPayload,
  worktreeDeleteJobPayload,
  worktreeDiffPayload,
  worktreeJobPayload,
  worktreeMoveCheckoutJobPayload,
  worktreeMovePushJobPayload,
  worktreeWatchJobPayload,
  type WorktreeActivityReport,
  type WorktreeChange,
  type WorktreeCommit,
  type WorktreeDetail,
  type WorktreeDiffFile,
  type WorktreeInventoryItem,
  type WorktreePushStatus,
} from "@ai-development-environment/agent-contract/worktrees";

import { captureCommand, type CaptureResult } from "../capture-command.js";
import { worktreeCodeStateHash } from "../git-code-state.js";
import type { AgentJobHandler, AgentJobHandlerContext } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;
const WATCH_DEBOUNCE_MS = 500;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".bmp",
]);

type ActiveWorktreeWatch = {
  watchId: string;
  codebaseId: string;
  gitDirectory: string;
  folder: string;
  baseBranch: string | null;
  timeoutMs: number;
  watchers: FSWatcher[];
  reporter: AgentJobHandlerContext["reportWorktreeActivity"];
  timer: ReturnType<typeof setTimeout> | null;
  reporting: boolean;
  pending: boolean;
  headIdentity: string | null;
};

const activeWorktreeWatches = new Map<string, ActiveWorktreeWatch>();

function statusChangeState(value: string): {
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
} {
  const entries = value.split("\0").filter(Boolean);
  let hasStagedChanges = false;
  let hasUnstagedChanges = false;
  for (let index = 0; index < entries.length; index += 1) {
    const code = entries[index]!.slice(0, 2);
    const untracked = code === "??";
    if (!untracked && code[0] !== " " && code[0] !== "?" && code[0] !== "!") {
      hasStagedChanges = true;
    }
    if (untracked || (code[1] !== " " && code[1] !== "?" && code[1] !== "!")) {
      hasUnstagedChanges = true;
    }
    if ((code[0] === "R" || code[0] === "C") && entries[index + 1]) {
      index += 1;
    }
  }
  return { hasStagedChanges, hasUnstagedChanges };
}

function closeWorktreeWatch(entry: ActiveWorktreeWatch): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  for (const watcher of entry.watchers) watcher.close();
  entry.watchers.length = 0;
}

export function closeAllWorktreeWatches(): void {
  for (const entry of activeWorktreeWatches.values()) {
    closeWorktreeWatch(entry);
  }
  activeWorktreeWatches.clear();
}

async function flushWorktreeActivity(entry: ActiveWorktreeWatch) {
  if (activeWorktreeWatches.get(entry.gitDirectory) !== entry) return;
  if (entry.reporting) {
    entry.pending = true;
    return;
  }
  entry.reporting = true;
  entry.pending = false;
  try {
    const signal = new AbortController().signal;
    const [status, branchResult, headResult, codeStateHash] = await Promise.all(
      [
        git(
          entry.folder,
          [
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
          ],
          entry.timeoutMs,
          signal,
        ),
        git(
          entry.folder,
          ["symbolic-ref", "--short", "-q", "HEAD"],
          entry.timeoutMs,
          signal,
        ),
        git(entry.folder, ["rev-parse", "HEAD"], entry.timeoutMs, signal),
        worktreeCodeStateHash(entry.folder, entry.timeoutMs, signal),
      ],
    );
    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
    const headIdentity = headSha ? `${branch ?? ""}\0${headSha}` : null;
    const changes =
      status.exitCode === 0
        ? statusChangeState(status.stdout)
        : { hasStagedChanges: false, hasUnstagedChanges: false };
    const report: WorktreeActivityReport = {
      codebaseId: entry.codebaseId,
      gitDirectory: entry.gitDirectory,
      codeStateHash,
      ...changes,
      pushStatus: await worktreePushStatus(
        entry.folder,
        branch,
        changes,
        entry.timeoutMs,
        signal,
      ),
      observedAt: new Date().toISOString(),
    };
    if (headIdentity && headIdentity !== entry.headIdentity) {
      const upstreamResult = branch
        ? await git(
            entry.folder,
            [
              "rev-parse",
              "--abbrev-ref",
              "--symbolic-full-name",
              "@{upstream}",
            ],
            entry.timeoutMs,
            signal,
          )
        : null;
      const upstream =
        upstreamResult?.exitCode === 0 ? upstreamResult.stdout.trim() : null;
      const upstreamCounts = upstream
        ? await counts(
            entry.folder,
            "HEAD...@{upstream}",
            entry.timeoutMs,
            signal,
          )
        : { ahead: null, behind: null };
      const baseCounts = entry.baseBranch
        ? await counts(
            entry.folder,
            `HEAD...refs/remotes/origin/${entry.baseBranch}`,
            entry.timeoutMs,
            signal,
          )
        : { ahead: null, behind: null };
      Object.assign(report, {
        branch,
        headSha,
        upstream,
        ahead: upstreamCounts.ahead,
        behind: upstreamCounts.behind,
        syncState: worktreeSyncState(branch, upstream, upstreamCounts),
        baseAhead: baseCounts.ahead,
        baseBehind: baseCounts.behind,
      } satisfies Partial<WorktreeActivityReport>);
    }
    await entry.reporter(report);
    if (headIdentity) entry.headIdentity = headIdentity;
  } catch (error) {
    console.error(
      "Could not report worktree activity:",
      error instanceof Error ? error.message : error,
    );
  } finally {
    entry.reporting = false;
    if (
      entry.pending &&
      activeWorktreeWatches.get(entry.gitDirectory) === entry
    ) {
      scheduleWorktreeActivity(entry);
    }
  }
}

function scheduleWorktreeActivity(entry: ActiveWorktreeWatch): void {
  entry.pending = true;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void flushWorktreeActivity(entry);
  }, WATCH_DEBOUNCE_MS);
  entry.timer.unref();
}

type WorktreeEntry = {
  folder: string;
  headSha: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
};

function cleanError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
    .slice(0, 2_000);
}

async function command(
  executable: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureResult> {
  return captureCommand({ command: executable, args, timeoutMs, signal, env });
}

async function git(
  folder: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<CaptureResult> {
  return command("git", ["-C", folder, ...args], timeoutMs, signal, {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  });
}

function requireSuccess(
  result: CaptureResult,
  fallback: string,
): CaptureResult {
  if (result.cancelled) throw new Error("Worktree operation was cancelled");
  if (result.timedOut) throw new Error("Worktree operation timed out");
  if (result.exitCode !== 0)
    throw new Error(cleanError(result.stderr || fallback));
  return result;
}

function parseWorktreeList(value: string): WorktreeEntry[] {
  return value
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const field = (prefix: string) =>
        lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) ??
        null;
      const branchRef = field("branch ");
      return {
        folder: field("worktree ") ?? "",
        headSha: field("HEAD "),
        branch: branchRef?.replace(/^refs\/heads\//, "") ?? null,
        detached: lines.includes("detached"),
        prunable: lines.some((line) => line.startsWith("prunable")),
      };
    })
    .filter((entry) => Boolean(entry.folder));
}

async function gitDirectory(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const result = requireSuccess(
    await git(
      folder,
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      timeoutMs,
      signal,
    ),
    "Could not resolve the worktree Git directory",
  );
  return realpath(result.stdout.trim());
}

async function origin(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const result = requireSuccess(
    await git(folder, ["remote", "get-url", "origin"], timeoutMs, signal),
    "Repository does not have an origin remote",
  );
  return normalizeGitOrigin(result.stdout.trim()).canonicalOrigin;
}

async function validateWorktree(
  input: ReturnType<typeof worktreeJobPayload>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const folder = await realpath(input.folder);
  if (!(await stat(folder)).isDirectory())
    throw new Error("Worktree is missing");
  const observedGitDirectory = await gitDirectory(folder, timeoutMs, signal);
  if (observedGitDirectory !== input.gitDirectory) {
    throw new Error("Worktree identity changed; refresh the page");
  }
  if ((await origin(folder, timeoutMs, signal)) !== input.expectedOrigin) {
    throw new Error("Worktree origin changed; refresh the codebase");
  }
  return folder;
}

async function counts(
  folder: string,
  range: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ ahead: number | null; behind: number | null }> {
  const result = await git(
    folder,
    ["rev-list", "--left-right", "--count", range],
    timeoutMs,
    signal,
  );
  if (result.exitCode !== 0) return { ahead: null, behind: null };
  const [left, right] = result.stdout.trim().split(/\s+/).map(Number);
  return Number.isInteger(left) && Number.isInteger(right)
    ? { ahead: left, behind: right }
    : { ahead: null, behind: null };
}

function worktreeSyncState(
  branch: string | null,
  upstream: string | null,
  upstreamCounts: { ahead: number | null; behind: number | null },
) {
  return !branch
    ? ("DETACHED" as const)
    : !upstream
      ? ("NO_UPSTREAM" as const)
      : upstreamCounts.ahead === null || upstreamCounts.behind === null
        ? ("UNKNOWN" as const)
        : upstreamCounts.ahead > 0 && upstreamCounts.behind > 0
          ? ("DIVERGED" as const)
          : upstreamCounts.ahead > 0
            ? ("AHEAD" as const)
            : upstreamCounts.behind > 0
              ? ("BEHIND" as const)
              : ("IN_SYNC" as const);
}

async function worktreePushStatus(
  folder: string,
  branch: string | null,
  changes: { hasStagedChanges: boolean; hasUnstagedChanges: boolean },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreePushStatus> {
  if (changes.hasStagedChanges || changes.hasUnstagedChanges) return "DIRTY";
  if (!branch) return "DETACHED";
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (!(await refExists(folder, remoteRef, timeoutMs, signal))) return "READY";
  const remoteCounts = await counts(
    folder,
    `HEAD...${remoteRef}`,
    timeoutMs,
    signal,
  );
  if (remoteCounts.ahead === null || remoteCounts.behind === null) {
    return "UNKNOWN";
  }
  if (remoteCounts.behind > 0 && remoteCounts.ahead > 0) return "DIVERGED";
  if (remoteCounts.behind > 0) return "BEHIND";
  return "READY";
}

export async function inspectWorktreeItem(
  folderValue: string,
  rootFolder: string,
  baseBranch: string | null,
  primary: boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreeInventoryItem> {
  const checkedAt = new Date().toISOString();
  try {
    const folder = await realpath(folderValue);
    const [gitDir, branchResult, headResult, statusResult] = await Promise.all([
      gitDirectory(folder, timeoutMs, signal),
      git(folder, ["symbolic-ref", "--short", "-q", "HEAD"], timeoutMs, signal),
      git(folder, ["rev-parse", "HEAD"], timeoutMs, signal),
      git(
        folder,
        [
          "--no-optional-locks",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ],
        timeoutMs,
        signal,
      ),
    ]);
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
    const upstreamCounts = upstream
      ? await counts(folder, "HEAD...@{upstream}", timeoutMs, signal)
      : { ahead: null, behind: null };
    const baseCounts = baseBranch
      ? await counts(
          folder,
          `HEAD...refs/remotes/origin/${baseBranch}`,
          timeoutMs,
          signal,
        )
      : { ahead: null, behind: null };
    const syncState = worktreeSyncState(branch, upstream, upstreamCounts);
    const changes =
      statusResult.exitCode === 0
        ? statusChangeState(statusResult.stdout)
        : { hasStagedChanges: false, hasUnstagedChanges: false };
    return {
      gitDirectory: gitDir,
      folder,
      relativePath: relative(rootFolder, folder) || ".",
      primary,
      branch,
      headSha: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
      codeStateHash: await worktreeCodeStateHash(folder, timeoutMs, signal),
      upstream,
      ahead: upstreamCounts.ahead,
      behind: upstreamCounts.behind,
      syncState,
      baseAhead: baseCounts.ahead,
      baseBehind: baseCounts.behind,
      ...changes,
      pushStatus: await worktreePushStatus(
        folder,
        branch,
        changes,
        timeoutMs,
        signal,
      ),
      availability: "AVAILABLE",
      error: null,
      checkedAt,
    };
  } catch (error) {
    return {
      gitDirectory: folderValue,
      folder: folderValue,
      relativePath: relative(rootFolder, folderValue) || ".",
      primary,
      branch: null,
      headSha: null,
      codeStateHash: null,
      upstream: null,
      ahead: null,
      behind: null,
      syncState: "UNKNOWN",
      baseAhead: null,
      baseBehind: null,
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      pushStatus: "UNKNOWN",
      availability: "ERROR",
      error: cleanError(error),
      checkedAt,
    };
  }
}

export async function discoverWorktrees(
  rootFolderValue: string,
  baseOverrides: Map<string, string | null>,
  knownDefaultBranch: string | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{
  complete: boolean;
  defaultBranch: string | null;
  localBranches: string[];
  remoteBranches: string[];
  worktrees: WorktreeInventoryItem[];
}> {
  const rootFolder = await realpath(rootFolderValue);
  const list = requireSuccess(
    await git(
      rootFolder,
      ["worktree", "list", "--porcelain"],
      timeoutMs,
      signal,
    ),
    "Could not list Git worktrees",
  );
  const remoteHead = await git(
    rootFolder,
    ["ls-remote", "--symref", "origin", "HEAD"],
    timeoutMs,
    signal,
  );
  let defaultBranch =
    remoteHead.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m)?.[1] ??
    null;
  const defaultResult = await git(
    rootFolder,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    timeoutMs,
    signal,
  );
  if (!defaultBranch) {
    const localDefaultBranch =
      defaultResult.exitCode === 0
        ? defaultResult.stdout.trim().replace(/^origin\//, "")
        : null;
    defaultBranch = localDefaultBranch || knownDefaultBranch;
  }
  const [localBranchesResult, remoteBranchesResult] = await Promise.all([
    git(
      rootFolder,
      ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"],
      timeoutMs,
      signal,
    ),
    git(
      rootFolder,
      ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"],
      timeoutMs,
      signal,
    ),
  ]);
  const localBranches = localBranchesResult.stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second));
  const remoteBranches = remoteBranchesResult.stdout
    .split("\n")
    .map((branch) => branch.trim())
    .filter((branch) => branch && branch !== "HEAD")
    .sort((first, second) => first.localeCompare(second));
  const entries = parseWorktreeList(list.stdout).filter(
    (entry) => !entry.prunable,
  );
  const worktrees: WorktreeInventoryItem[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    let identity: string | null = null;
    try {
      identity = await gitDirectory(entry.folder, timeoutMs, signal);
    } catch {
      // inspectWorktreeItem reports the inaccessible entry.
    }
    worktrees.push(
      await inspectWorktreeItem(
        entry.folder,
        rootFolder,
        (identity && baseOverrides.get(identity)) || defaultBranch,
        index === 0,
        timeoutMs,
        signal,
      ),
    );
  }
  return {
    complete: true,
    defaultBranch,
    localBranches,
    remoteBranches,
    worktrees,
  };
}

function parseNumstat(
  value: string,
): Map<string, [number | null, number | null]> {
  const result = new Map<string, [number | null, number | null]>();
  const entries = value.split("\0");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (!entry) continue;
    const [added, deleted, ...pathParts] = entry.split("\t");
    let path = pathParts.join("\t");
    if (!path && entries[index + 1] && entries[index + 2]) {
      path = entries[index + 2]!;
      index += 2;
    }
    if (!path) continue;
    result.set(path, [
      added === "-" ? null : Number(added),
      deleted === "-" ? null : Number(deleted),
    ]);
  }
  return result;
}

async function untrackedLines(
  folder: string,
  path: string,
): Promise<number | null> {
  try {
    const file = await stat(`${folder}/${path}`);
    if (!file.isFile() || file.size > 1024 * 1024) return null;
    const contents = await readFile(`${folder}/${path}`);
    if (contents.includes(0)) return null;
    const text = contents.toString("utf8");
    return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
  } catch {
    return null;
  }
}

async function inspectChanges(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ changes: WorktreeChange[]; truncated: boolean }> {
  const [statusResult, stagedResult, unstagedResult] = await Promise.all([
    git(
      folder,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      timeoutMs,
      signal,
    ),
    git(folder, ["diff", "--cached", "--numstat", "-z"], timeoutMs, signal),
    git(folder, ["diff", "--numstat", "-z"], timeoutMs, signal),
  ]);
  requireSuccess(statusResult, "Could not inspect worktree changes");
  const stagedCounts = parseNumstat(stagedResult.stdout);
  const unstagedCounts = parseNumstat(unstagedResult.stdout);
  const values = statusResult.stdout.split("\0").filter(Boolean);
  const changes: WorktreeChange[] = [];
  for (
    let index = 0;
    index < values.length && changes.length < 501;
    index += 1
  ) {
    const value = values[index]!;
    const code = value.slice(0, 2);
    const path = value.slice(3);
    const previousPath =
      (code[0] === "R" || code[0] === "C") && values[index + 1]
        ? values[index + 1]!
        : null;
    if (previousPath) index += 1;
    const untracked = code === "??";
    const conflicted = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(
      code,
    );
    const staged = !untracked && code[0] !== " " && code[0] !== "?";
    const unstaged = !untracked && code[1] !== " " && code[1] !== "?";
    const stagedCount = stagedCounts.get(path) ?? [null, null];
    const unstagedCount = unstagedCounts.get(path) ?? [null, null];
    const untrackedCount = untracked
      ? await untrackedLines(folder, path)
      : null;
    changes.push({
      path,
      previousPath,
      changeType: untracked ? "ADDED" : conflicted ? "CONFLICTED" : code,
      staged,
      unstaged,
      untracked,
      conflicted,
      stagedAdditions: stagedCount[0],
      stagedDeletions: stagedCount[1],
      unstagedAdditions: untracked ? untrackedCount : unstagedCount[0],
      unstagedDeletions: untracked ? 0 : unstagedCount[1],
    });
  }
  return { changes: changes.slice(0, 500), truncated: changes.length > 500 };
}

function imagePath(path: string): boolean {
  const extension = path.slice(path.lastIndexOf(".")).toLocaleLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

function parseNameStatus(value: string): Array<{
  path: string;
  previousPath: string | null;
  changeType: string;
}> {
  const entries = value.split("\0").filter(Boolean);
  const files: Array<{
    path: string;
    previousPath: string | null;
    changeType: string;
  }> = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++] ?? "M";
    const renamed = status.startsWith("R") || status.startsWith("C");
    const first = entries[index++] ?? "";
    const second = renamed ? (entries[index++] ?? "") : null;
    const path = second ?? first;
    if (!path) continue;
    files.push({
      path,
      previousPath: renamed ? first : null,
      changeType: status[0] ?? "M",
    });
  }
  return files;
}

async function diffFiles(
  folder: string,
  range: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreeDiffFile[]> {
  const [status, counts] = await Promise.all([
    git(folder, ["diff", "--name-status", "-z", range], timeoutMs, signal),
    git(folder, ["diff", "--numstat", "-z", range], timeoutMs, signal),
  ]);
  requireSuccess(status, "Could not inspect changed files");
  requireSuccess(counts, "Could not inspect changed line counts");
  const numstat = parseNumstat(counts.stdout);
  return parseNameStatus(status.stdout).map((file) => {
    const [additions, deletions] = numstat.get(file.path) ?? [null, null];
    return {
      ...file,
      additions,
      deletions,
      binary: additions === null && deletions === null,
      image: imagePath(file.path),
    };
  });
}

async function inspectBranchChanges(
  folder: string,
  baseBranch: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ changes: WorktreeDiffFile[]; truncated: boolean }> {
  const mergeBase = requireSuccess(
    await git(
      folder,
      ["merge-base", `refs/remotes/origin/${baseBranch}`, "HEAD"],
      timeoutMs,
      signal,
    ),
    "Could not determine the base-branch merge base",
  ).stdout.trim();
  const files = await diffFiles(
    folder,
    `${mergeBase}..HEAD`,
    timeoutMs,
    signal,
  );
  return { changes: files.slice(0, 500), truncated: files.length > 500 };
}

async function inspectCommits(
  folder: string,
  baseBranch: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ commits: WorktreeCommit[]; truncated: boolean }> {
  const result = requireSuccess(
    await git(
      folder,
      [
        "log",
        "--max-count=101",
        "--format=%x1e%H%x1f%s%x1f%an%x1f%aI",
        "--numstat",
        `refs/remotes/origin/${baseBranch}..HEAD`,
      ],
      timeoutMs,
      signal,
    ),
    "Could not inspect base-relative commits",
  );
  const commits = result.stdout
    .split("\x1e")
    .filter(Boolean)
    .map((block) => {
      const lines = block.trim().split("\n");
      const [sha = "", subject = "", authorName = "", authoredAt = ""] = (
        lines.shift() ?? ""
      ).split("\x1f");
      let additions = 0;
      let deletions = 0;
      for (const line of lines) {
        const [added, deleted] = line.split("\t");
        if (/^\d+$/.test(added ?? "")) additions += Number(added);
        if (/^\d+$/.test(deleted ?? "")) deletions += Number(deleted);
      }
      return { sha, subject, authorName, authoredAt, additions, deletions };
    });
  return { commits: commits.slice(0, 100), truncated: commits.length > 100 };
}

export async function inspectWorktreeDetail(
  folder: string,
  baseBranch: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreeDetail> {
  const [commitResult, changeResult, branchResult] = await Promise.all([
    inspectCommits(folder, baseBranch, timeoutMs, signal),
    inspectChanges(folder, timeoutMs, signal),
    inspectBranchChanges(folder, baseBranch, timeoutMs, signal),
  ]);
  return {
    commits: commitResult.commits,
    changes: changeResult.changes,
    branchChanges: branchResult.changes,
    commitsTruncated: commitResult.truncated,
    changesTruncated: changeResult.truncated,
    branchChangesTruncated: branchResult.truncated,
  };
}

type DiffSide =
  | { kind: "GIT"; specification: string }
  | { kind: "FILE"; path: string }
  | null;

async function baseMergeCommit(
  folder: string,
  baseBranch: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return requireSuccess(
    await git(
      folder,
      ["merge-base", `refs/remotes/origin/${baseBranch}`, "HEAD"],
      timeoutMs,
      signal,
    ),
    "Could not determine the base-branch merge base",
  ).stdout.trim();
}

async function validateDisplayedCommit(
  folder: string,
  baseBranch: string,
  commitSha: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) {
    throw new Error("Commit SHA is invalid");
  }
  const base = await baseMergeCommit(folder, baseBranch, timeoutMs, signal);
  const [afterBase, beforeHead] = await Promise.all([
    git(
      folder,
      ["merge-base", "--is-ancestor", base, commitSha],
      timeoutMs,
      signal,
    ),
    git(
      folder,
      ["merge-base", "--is-ancestor", commitSha, "HEAD"],
      timeoutMs,
      signal,
    ),
  ]);
  if (afterBase.exitCode !== 0 || beforeHead.exitCode !== 0) {
    throw new Error("Commit is outside the displayed branch history");
  }
}

async function parentCommit(
  folder: string,
  commitSha: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await git(
    folder,
    ["rev-parse", `${commitSha}^`],
    timeoutMs,
    signal,
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function gitObjectExists(
  folder: string,
  specification: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return (
    (await git(folder, ["cat-file", "-e", specification], timeoutMs, signal))
      .exitCode === 0
  );
}

async function comparisonSides(
  input: ReturnType<typeof worktreeDiffPayload>,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ before: DiffSide; after: DiffSide }> {
  if (!input.path) return { before: null, after: null };
  const path = input.path;
  const currentPath = join(folder, path);
  if (input.scope === "UNTRACKED") {
    return { before: null, after: { kind: "FILE", path: currentPath } };
  }
  if (input.scope === "STAGED") {
    return {
      before: { kind: "GIT", specification: `HEAD:${path}` },
      after: { kind: "GIT", specification: `:${path}` },
    };
  }
  if (input.scope === "UNSTAGED") {
    return {
      before: { kind: "GIT", specification: `:${path}` },
      after: { kind: "FILE", path: currentPath },
    };
  }
  if (input.scope === "COMMIT") {
    const commitSha = input.commitSha!;
    await validateDisplayedCommit(
      folder,
      input.baseBranch,
      commitSha,
      timeoutMs,
      signal,
    );
    const parent = await parentCommit(folder, commitSha, timeoutMs, signal);
    return {
      before: parent
        ? { kind: "GIT", specification: `${parent}:${path}` }
        : null,
      after: { kind: "GIT", specification: `${commitSha}:${path}` },
    };
  }
  const base = await baseMergeCommit(
    folder,
    input.baseBranch,
    timeoutMs,
    signal,
  );
  return {
    before: { kind: "GIT", specification: `${base}:${path}` },
    after: { kind: "GIT", specification: `HEAD:${path}` },
  };
}

async function availableSide(
  side: DiffSide,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (!side) return false;
  if (side.kind === "GIT") {
    return gitObjectExists(folder, side.specification, timeoutMs, signal);
  }
  try {
    const resolved = await realpath(side.path);
    const difference = relative(folder, resolved);
    return (
      difference !== ".." &&
      !difference.startsWith("../") &&
      (await stat(resolved)).isFile()
    );
  } catch {
    return false;
  }
}

async function inspectRequestedDiff(
  input: ReturnType<typeof worktreeDiffPayload>,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  if (!input.path) {
    if (input.scope === "COMMIT") {
      await validateDisplayedCommit(
        folder,
        input.baseBranch,
        input.commitSha!,
        timeoutMs,
        signal,
      );
      const parent = await parentCommit(
        folder,
        input.commitSha!,
        timeoutMs,
        signal,
      );
      const files = await diffFiles(
        folder,
        parent ? `${parent}..${input.commitSha}` : input.commitSha!,
        timeoutMs,
        signal,
      );
      return { files: files.slice(0, 500), truncated: files.length > 500 };
    }
    if (input.scope === "BRANCH") {
      const result = await inspectBranchChanges(
        folder,
        input.baseBranch,
        timeoutMs,
        signal,
      );
      return { files: result.changes, truncated: result.truncated };
    }
    throw new Error("A file path is required for this diff scope");
  }
  if (input.scope === "COMMIT") {
    await validateDisplayedCommit(
      folder,
      input.baseBranch,
      input.commitSha!,
      timeoutMs,
      signal,
    );
  }
  await validateChangedPath(input, folder, timeoutMs, signal);
  const args = ["diff", "--no-color", "--no-ext-diff", "--unified=3"];
  let oversized = false;
  if (input.scope === "STAGED") args.push("--cached");
  if (input.scope === "COMMIT") {
    const parent = await parentCommit(
      folder,
      input.commitSha!,
      timeoutMs,
      signal,
    );
    args.push(parent ?? `${input.commitSha}^`, input.commitSha!);
  } else if (input.scope === "BRANCH") {
    args.push(
      await baseMergeCommit(folder, input.baseBranch, timeoutMs, signal),
      "HEAD",
    );
  }
  args.push("--", input.path);
  let patch: string;
  if (input.scope === "UNTRACKED") {
    const contents = await readFile(join(folder, input.path));
    if (contents.length > 2 * 1024 * 1024 || contents.includes(0)) {
      oversized = contents.length > 2 * 1024 * 1024;
      patch = "";
    } else {
      patch = [
        `diff --git a/${input.path} b/${input.path}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${input.path}`,
        ...contents
          .toString("utf8")
          .split("\n")
          .map((line) => `+${line}`),
      ].join("\n");
    }
  } else {
    patch = requireSuccess(
      await git(folder, args, timeoutMs, signal),
      "Could not load the file diff",
    ).stdout;
  }
  const sides = await comparisonSides(input, folder, timeoutMs, signal);
  const [beforeAvailable, afterAvailable] = await Promise.all([
    availableSide(sides.before, folder, timeoutMs, signal),
    availableSide(sides.after, folder, timeoutMs, signal),
  ]);
  return {
    files: [],
    patch,
    image: imagePath(input.path),
    binary: !patch && !imagePath(input.path) && !oversized,
    truncated: oversized || Buffer.byteLength(patch) >= 2 * 1024 * 1024,
    beforeAvailable,
    afterAvailable,
  };
}

async function validateChangedPath(
  input: ReturnType<typeof worktreeDiffPayload>,
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!input.path) throw new Error("A changed file path is required");
  let result: CaptureResult;
  if (input.scope === "UNTRACKED") {
    result = await git(
      folder,
      ["ls-files", "--others", "--exclude-standard", "-z", "--", input.path],
      timeoutMs,
      signal,
    );
  } else {
    const args = ["diff", "--name-only", "-z"];
    if (input.scope === "STAGED") args.push("--cached");
    if (input.scope === "COMMIT") {
      await validateDisplayedCommit(
        folder,
        input.baseBranch,
        input.commitSha!,
        timeoutMs,
        signal,
      );
      const parent = await parentCommit(
        folder,
        input.commitSha!,
        timeoutMs,
        signal,
      );
      args.push(parent ?? `${input.commitSha}^`, input.commitSha!);
    } else if (input.scope === "BRANCH") {
      args.push(
        await baseMergeCommit(folder, input.baseBranch, timeoutMs, signal),
        "HEAD",
      );
    }
    args.push("--", input.path);
    result = await git(folder, args, timeoutMs, signal);
  }
  requireSuccess(result, "Could not validate the changed file");
  if (!result.stdout.split("\0").filter(Boolean).includes(input.path)) {
    throw new Error("The requested file is outside the displayed diff");
  }
}

export const inspectWorktreeDiff: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeDiffPayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  return {
    ...successfulProcess,
    diff: await inspectRequestedDiff(input, folder, timeoutMs, signal),
  };
};

function imageContentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".")).toLocaleLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".avif": "image/avif",
      ".bmp": "image/bmp",
    }[extension] ?? "application/octet-stream"
  );
}

async function writeGitObject(
  folder: string,
  specification: string,
  destination: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "git",
      ["-C", folder, "cat-file", "blob", specification],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = createWriteStream(destination, { mode: 0o600 });
    let stderr = "";
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(0, 4_000);
    });
    child.stdout.pipe(output);
    child.once("error", fail);
    output.once("error", fail);
    const terminate = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      terminate();
      fail(new Error("Image extraction timed out"));
    }, timeoutMs);
    timer.unref();
    const abort = () => {
      terminate();
      fail(new Error("Image extraction was cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (settled) return;
      if (code !== 0) {
        fail(new Error(cleanError(stderr || "Could not extract image")));
        return;
      }
      output.end(() => {
        if (settled) return;
        settled = true;
        resolvePromise();
      });
    });
  });
}

export const downloadWorktreeDiffAsset: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = worktreeDiffPayload(payload);
  if (!input.path || !input.uploadId || !input.side) {
    throw new Error("Diff image path, side, and upload ID are required");
  }
  if (!imagePath(input.path)) throw new Error("Diff asset is not an image");
  if (!context?.uploadBuildArtifact) {
    throw new Error("This agent cannot upload diff images");
  }
  const folder = await validateWorktree(input, timeoutMs, signal);
  await validateChangedPath(input, folder, timeoutMs, signal);
  const sides = await comparisonSides(input, folder, timeoutMs, signal);
  const selected = input.side === "BEFORE" ? sides.before : sides.after;
  if (
    !selected ||
    !(await availableSide(selected, folder, timeoutMs, signal))
  ) {
    throw new Error("The requested image side is unavailable");
  }
  let uploadPath: string;
  let temporaryDirectory: string | null = null;
  try {
    if (selected.kind === "FILE") {
      uploadPath = await realpath(selected.path);
      const difference = relative(folder, uploadPath);
      if (difference === ".." || difference.startsWith("../")) {
        throw new Error("Diff image resolves outside the worktree");
      }
    } else {
      const size = requireSuccess(
        await git(
          folder,
          ["cat-file", "-s", selected.specification],
          timeoutMs,
          signal,
        ),
        "Could not inspect diff image",
      ).stdout.trim();
      if (!/^\d+$/.test(size) || Number(size) > 20 * 1024 * 1024) {
        throw new Error("Diff image exceeds the 20 MiB limit");
      }
      temporaryDirectory = await mkdtemp(join(tmpdir(), "ade-diff-image-"));
      uploadPath = join(temporaryDirectory, basename(input.path));
      await writeGitObject(
        folder,
        selected.specification,
        uploadPath,
        timeoutMs,
        signal,
      );
    }
    const information = await stat(uploadPath);
    if (!information.isFile() || information.size > 20 * 1024 * 1024) {
      throw new Error("Diff image exceeds the 20 MiB limit");
    }
    await context.uploadBuildArtifact({
      uploadId: input.uploadId,
      path: uploadPath,
      filename: basename(input.path),
      contentType: imageContentType(input.path),
    });
    return successfulProcess;
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
};

export const watchWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
  _onLog,
  context,
) => {
  const input = worktreeWatchJobPayload(payload);
  const current = activeWorktreeWatches.get(input.gitDirectory);
  if (input.action === "STOP") {
    if (current?.watchId === input.watchId) {
      closeWorktreeWatch(current);
      activeWorktreeWatches.delete(input.gitDirectory);
    }
    return successfulProcess;
  }

  if (!context) throw new Error("Worktree activity reporting is unavailable");
  const folder = await validateWorktree(input, timeoutMs, signal);
  if (current?.watchId === input.watchId) return successfulProcess;
  if (current) {
    closeWorktreeWatch(current);
    activeWorktreeWatches.delete(input.gitDirectory);
  }

  const entry: ActiveWorktreeWatch = {
    watchId: input.watchId,
    codebaseId: input.codebaseId,
    gitDirectory: input.gitDirectory,
    folder,
    baseBranch: input.baseBranch,
    timeoutMs: Math.min(timeoutMs, 30_000),
    watchers: [],
    reporter: context.reportWorktreeActivity,
    timer: null,
    reporting: false,
    pending: false,
    headIdentity: null,
  };
  activeWorktreeWatches.set(input.gitDirectory, entry);
  try {
    for (const target of new Set([folder, input.gitDirectory])) {
      const watcher = watch(target, { recursive: true }, () =>
        scheduleWorktreeActivity(entry),
      );
      watcher.on("error", (error) => {
        console.error(
          `Worktree watcher failed for ${target}:`,
          error instanceof Error ? error.message : error,
        );
      });
      watcher.unref();
      entry.watchers.push(watcher);
    }
    scheduleWorktreeActivity(entry);
  } catch (error) {
    closeWorktreeWatch(entry);
    activeWorktreeWatches.delete(input.gitDirectory);
    throw error;
  }
  return successfulProcess;
};

export const inspectWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeJobPayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  if (!input.baseBranch) throw new Error("A base branch is required");
  return {
    ...successfulProcess,
    detail: await inspectWorktreeDetail(
      folder,
      input.baseBranch,
      timeoutMs,
      signal,
    ),
  };
};

async function refExists(
  folder: string,
  ref: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await git(
    folder,
    ["show-ref", "--verify", "--quiet", ref],
    timeoutMs,
    signal,
  );
  return result.exitCode === 0;
}

async function resolveHead(
  folder: string,
  ref: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  return requireSuccess(
    await git(folder, ["rev-parse", ref], timeoutMs, signal),
    `Could not resolve ${ref}`,
  ).stdout.trim();
}

async function isAncestor(
  folder: string,
  ancestor: string,
  descendant: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await git(
    folder,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    timeoutMs,
    signal,
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  requireSuccess(result, "Could not compare Git history");
  return false;
}

async function statusState(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const result = requireSuccess(
    await git(
      folder,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      timeoutMs,
      signal,
    ),
    "Could not inspect worktree changes",
  );
  return statusChangeState(result.stdout);
}

function hasChanges(changes: {
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
}) {
  return changes.hasStagedChanges || changes.hasUnstagedChanges;
}

async function currentBranch(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await git(
    folder,
    ["symbolic-ref", "--short", "-q", "HEAD"],
    timeoutMs,
    signal,
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function chooseNewBranch(
  folder: string,
  candidates: string[],
  allowedCurrentBranch: string | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  for (const candidate of candidates) {
    if (candidate === allowedCurrentBranch) return candidate;
    const [local, remote] = await Promise.all([
      refExists(folder, `refs/heads/${candidate}`, timeoutMs, signal),
      refExists(folder, `refs/remotes/origin/${candidate}`, timeoutMs, signal),
    ]);
    if (!local && !remote) return candidate;
  }
  throw new Error("Every generated ticket branch name is already taken");
}

async function validateBranchRoot(
  input: { rootFolder: string; expectedOrigin: string; baseBranch: string },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const rootFolder = await realpath(input.rootFolder);
  if (!(await stat(rootFolder)).isDirectory()) {
    throw new Error("Base repository is missing");
  }
  if ((await origin(rootFolder, timeoutMs, signal)) !== input.expectedOrigin) {
    throw new Error("Repository origin changed; refresh the codebase");
  }
  if (
    !(await refExists(
      rootFolder,
      `refs/remotes/origin/${input.baseBranch}`,
      timeoutMs,
      signal,
    ))
  ) {
    throw new Error(
      "The selected origin base branch is unavailable; fetch and try again",
    );
  }
  return rootFolder;
}

async function existingBranchArgs(
  folder: string,
  branch: string,
  action: "CREATE" | "CHANGE",
  targetFolder: string | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  const [local, remote] = await Promise.all([
    refExists(folder, `refs/heads/${branch}`, timeoutMs, signal),
    refExists(folder, `refs/remotes/origin/${branch}`, timeoutMs, signal),
  ]);
  if (!local && !remote) {
    throw new Error(
      `Existing branch ${branch} is unavailable; refresh and try again`,
    );
  }
  if (action === "CREATE") {
    return local
      ? ["worktree", "add", targetFolder!, branch]
      : [
          "worktree",
          "add",
          "--track",
          "-b",
          branch,
          targetFolder!,
          `refs/remotes/origin/${branch}`,
        ];
  }
  return local
    ? ["switch", branch]
    : ["switch", "--track", "-c", branch, `refs/remotes/origin/${branch}`];
}

export const branchWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeBranchJobPayload(payload);
  const rootFolder = await validateBranchRoot(input, timeoutMs, signal);
  const changeFolder =
    input.action === "CHANGE"
      ? await validateWorktree(
          {
            codebaseId: input.codebaseId,
            folder: input.folder!,
            gitDirectory: input.gitDirectory!,
            expectedOrigin: input.expectedOrigin,
            baseBranch: input.baseBranch,
          },
          timeoutMs,
          signal,
        )
      : null;
  const beforeBranch = changeFolder
    ? await currentBranch(changeFolder, timeoutMs, signal)
    : null;
  const branch =
    input.mode === "NEW"
      ? await chooseNewBranch(
          rootFolder,
          input.candidates,
          input.action === "CHANGE" ? beforeBranch : null,
          timeoutMs,
          signal,
        )
      : input.candidates[0]!;
  const targetFolder =
    input.action === "CREATE"
      ? join(
          dirname(rootFolder),
          `${basename(rootFolder)}-${branch.replaceAll("/", "-")}`,
        )
      : changeFolder!;

  if (input.action === "CREATE") {
    try {
      await stat(targetFolder);
      throw new Error(`Worktree folder already exists: ${targetFolder}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  let args: string[];
  if (input.mode === "EXISTING") {
    args = await existingBranchArgs(
      rootFolder,
      branch,
      input.action,
      input.action === "CREATE" ? targetFolder : null,
      timeoutMs,
      signal,
    );
  } else if (input.action === "CREATE") {
    args = [
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      targetFolder,
      `refs/remotes/origin/${input.baseBranch}`,
    ];
  } else if (branch === beforeBranch) {
    args = [];
  } else {
    args = [
      "switch",
      "--no-track",
      "-c",
      branch,
      `refs/remotes/origin/${input.baseBranch}`,
    ];
  }

  let stashed = false;
  if (args.length > 0) {
    let switched = await git(
      input.action === "CREATE" ? rootFolder : targetFolder,
      args,
      timeoutMs,
      signal,
    );
    if (
      switched.exitCode !== 0 &&
      input.action === "CHANGE" &&
      input.stashOnFailure
    ) {
      const stash = requireSuccess(
        await git(
          targetFolder,
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
        "Could not stash worktree changes",
      );
      stashed = !stash.stdout.toLowerCase().includes("no local changes");
      switched = await git(targetFolder, args, timeoutMs, signal);
      if (switched.exitCode !== 0) {
        throw new Error(
          `${cleanError(switched.stderr || "Branch switch failed after stashing")}. The stash was preserved.`,
        );
      }
    } else {
      requireSuccess(
        switched,
        input.action === "CREATE"
          ? "Could not create the worktree"
          : "Could not change the worktree branch",
      );
    }
  }

  const worktree = await inspectWorktreeItem(
    targetFolder,
    rootFolder,
    input.baseBranch,
    targetFolder === rootFolder,
    Math.min(timeoutMs, 30_000),
    signal,
  );
  if (worktree.availability !== "AVAILABLE") {
    throw new Error(worktree.error || "Could not inspect the updated worktree");
  }
  return {
    ...successfulProcess,
    worktree,
    branch,
    baseBranch: input.baseBranch,
    stashed,
  };
};

export const pushMovedWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeMovePushJobPayload(payload);
  const folder = await validateWorktree(
    {
      codebaseId: input.codebaseId,
      folder: input.folder,
      gitDirectory: input.gitDirectory,
      expectedOrigin: input.expectedOrigin,
      baseBranch: null,
    },
    timeoutMs,
    signal,
  );
  const [branch, headSha, changes] = await Promise.all([
    currentBranch(folder, timeoutMs, signal),
    resolveHead(folder, "HEAD", timeoutMs, signal),
    statusState(folder, timeoutMs, signal),
  ]);
  if (branch !== input.branch || headSha !== input.expectedHeadSha) {
    throw new Error("The source branch changed; refresh and try again");
  }
  if (hasChanges(changes)) {
    throw new Error("Commit or discard source changes before moving");
  }
  requireSuccess(
    await git(folder, ["fetch", "origin"], timeoutMs, signal),
    "Could not fetch origin before moving",
  );
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (
    (await refExists(folder, remoteRef, timeoutMs, signal)) &&
    !(await isAncestor(folder, remoteRef, "HEAD", timeoutMs, signal))
  ) {
    throw new Error(
      "The origin branch contains commits that must be pulled before moving",
    );
  }
  requireSuccess(
    await git(
      folder,
      ["push", "--set-upstream", "origin", `HEAD:refs/heads/${branch}`],
      timeoutMs,
      signal,
    ),
    "Could not push the source branch",
  );
  const pushedHeadSha = await resolveHead(folder, "HEAD", timeoutMs, signal);
  if (pushedHeadSha !== input.expectedHeadSha) {
    throw new Error("The source branch changed while it was being pushed");
  }
  return {
    ...successfulProcess,
    moveId: input.moveId,
    branch,
    headSha: pushedHeadSha,
  };
};

async function updateLocalBranchForMove(
  rootFolder: string,
  branch: string,
  expectedHeadSha: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const localRef = `refs/heads/${branch}`;
  if (!(await refExists(rootFolder, localRef, timeoutMs, signal))) return false;
  const localHead = await resolveHead(rootFolder, localRef, timeoutMs, signal);
  if (localHead === expectedHeadSha) return true;
  if (
    !(await isAncestor(
      rootFolder,
      localHead,
      expectedHeadSha,
      timeoutMs,
      signal,
    ))
  ) {
    throw new Error(
      `Local branch ${branch} has commits that are not on origin; move them before retrying`,
    );
  }
  requireSuccess(
    await git(
      rootFolder,
      ["branch", "-f", branch, expectedHeadSha],
      timeoutMs,
      signal,
    ),
    `Could not fast-forward local branch ${branch}`,
  );
  return true;
}

async function checkedOutBranchFolder(
  rootFolder: string,
  branch: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const result = requireSuccess(
    await git(
      rootFolder,
      ["worktree", "list", "--porcelain"],
      timeoutMs,
      signal,
    ),
    "Could not list destination worktrees",
  );
  return parseWorktreeList(result.stdout).find(
    (entry) => entry.branch === branch,
  )?.folder;
}

export const checkoutMovedWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeMoveCheckoutJobPayload(payload);
  const rootFolder = await validateBranchRoot(input, timeoutMs, signal);
  const remoteRef = `refs/remotes/origin/${input.branch}`;
  requireSuccess(
    await git(
      rootFolder,
      [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${input.branch}:${remoteRef}`,
      ],
      timeoutMs,
      signal,
    ),
    `Could not fetch origin/${input.branch}`,
  );
  const remoteHead = await resolveHead(
    rootFolder,
    remoteRef,
    timeoutMs,
    signal,
  );
  if (remoteHead !== input.expectedHeadSha) {
    throw new Error(
      "The origin branch changed after the source push; refresh and retry",
    );
  }

  let targetFolder: string;
  let stashed = false;
  const occupiedFolder = await checkedOutBranchFolder(
    rootFolder,
    input.branch,
    timeoutMs,
    signal,
  );
  if (input.mode === "NEW") {
    if (occupiedFolder) {
      throw new Error(
        `Branch ${input.branch} is already checked out in ${occupiedFolder}`,
      );
    }
    targetFolder = join(
      dirname(rootFolder),
      `${basename(rootFolder)}-${input.branch.replaceAll("/", "-")}`,
    );
    try {
      await stat(targetFolder);
      throw new Error(`Worktree folder already exists: ${targetFolder}`);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const local = await updateLocalBranchForMove(
      rootFolder,
      input.branch,
      input.expectedHeadSha,
      timeoutMs,
      signal,
    );
    requireSuccess(
      await git(
        rootFolder,
        local
          ? ["worktree", "add", targetFolder, input.branch]
          : [
              "worktree",
              "add",
              "--track",
              "-b",
              input.branch,
              targetFolder,
              remoteRef,
            ],
        timeoutMs,
        signal,
      ),
      "Could not create the destination worktree",
    );
  } else {
    targetFolder = await validateWorktree(
      {
        codebaseId: input.codebaseId,
        folder: input.folder!,
        gitDirectory: input.gitDirectory!,
        expectedOrigin: input.expectedOrigin,
        baseBranch: input.baseBranch,
      },
      timeoutMs,
      signal,
    );
    const targetBranch = await currentBranch(targetFolder, timeoutMs, signal);
    const targetChanges = await statusState(targetFolder, timeoutMs, signal);
    if (occupiedFolder) {
      const occupied = await realpath(occupiedFolder);
      if (occupied !== targetFolder) {
        throw new Error(
          `Branch ${input.branch} is checked out in another destination worktree`,
        );
      }
    }
    let switchArgs: string[];
    if (targetBranch === input.branch) {
      const localHead = await resolveHead(
        targetFolder,
        "HEAD",
        timeoutMs,
        signal,
      );
      if (
        localHead !== input.expectedHeadSha &&
        !(await isAncestor(
          targetFolder,
          localHead,
          input.expectedHeadSha,
          timeoutMs,
          signal,
        ))
      ) {
        throw new Error(
          `Local branch ${input.branch} has commits that are not on origin`,
        );
      }
      switchArgs = ["merge", "--ff-only", remoteRef];
    } else {
      const local = await updateLocalBranchForMove(
        rootFolder,
        input.branch,
        input.expectedHeadSha,
        timeoutMs,
        signal,
      );
      switchArgs = local
        ? ["switch", input.branch]
        : ["switch", "--track", "-c", input.branch, remoteRef];
    }

    if (input.stashOnFailure && hasChanges(targetChanges)) {
      const stash = requireSuccess(
        await git(
          targetFolder,
          [
            "stash",
            "push",
            "--include-untracked",
            "-m",
            `Automatic stash before moving to ${input.branch}`,
          ],
          timeoutMs,
          signal,
        ),
        "Could not stash destination changes",
      );
      stashed = !stash.stdout.toLowerCase().includes("no local changes");
    }
    const switched = await git(targetFolder, switchArgs, timeoutMs, signal);
    if (switched.exitCode !== 0) {
      if (!input.stashOnFailure && hasChanges(targetChanges)) {
        return {
          ...successfulProcess,
          moveId: input.moveId,
          outcome: "NEEDS_STASH",
          message: cleanError(
            switched.stderr || "Destination changes block the branch switch",
          ),
        };
      }
      throw new Error(
        `${cleanError(switched.stderr || "Could not check out the moved branch")}${
          stashed ? ". The destination stash was preserved." : ""
        }`,
      );
    }
  }

  requireSuccess(
    await git(
      targetFolder,
      ["branch", "--set-upstream-to", `origin/${input.branch}`, input.branch],
      timeoutMs,
      signal,
    ),
    "Could not configure the destination upstream",
  );
  const checkedOutHead = await resolveHead(
    targetFolder,
    "HEAD",
    timeoutMs,
    signal,
  );
  if (checkedOutHead !== input.expectedHeadSha) {
    throw new Error("The destination did not check out the pushed commit");
  }
  const worktree = await inspectWorktreeItem(
    targetFolder,
    rootFolder,
    input.baseBranch,
    targetFolder === rootFolder,
    Math.min(timeoutMs, 30_000),
    signal,
  );
  if (worktree.availability !== "AVAILABLE") {
    throw new Error(
      worktree.error || "Could not inspect the destination worktree",
    );
  }
  return {
    ...successfulProcess,
    moveId: input.moveId,
    outcome: "CHECKED_OUT",
    worktree,
    baseBranch: input.baseBranch,
    stashed,
  };
};

export const deleteWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeDeleteJobPayload(payload);
  const rootFolder = await realpath(input.rootFolder);
  if (!(await stat(rootFolder)).isDirectory()) {
    throw new Error("Base repository is missing");
  }
  if ((await origin(rootFolder, timeoutMs, signal)) !== input.expectedOrigin) {
    throw new Error("Repository origin changed; refresh the codebase");
  }
  const folder = await validateWorktree(
    {
      codebaseId: input.codebaseId,
      folder: input.folder,
      gitDirectory: input.gitDirectory,
      expectedOrigin: input.expectedOrigin,
      baseBranch: null,
    },
    timeoutMs,
    signal,
  );
  if (folder === rootFolder)
    throw new Error("The primary worktree cannot be deleted");
  const listed = parseWorktreeList(
    requireSuccess(
      await git(
        rootFolder,
        ["worktree", "list", "--porcelain"],
        timeoutMs,
        signal,
      ),
      "Could not list worktrees",
    ).stdout,
  );
  const listedIndex = listed.findIndex((entry) => entry.folder === folder);
  if (listedIndex <= 0)
    throw new Error("The primary worktree cannot be deleted");
  const [branch, headSha, changes] = await Promise.all([
    currentBranch(folder, timeoutMs, signal),
    resolveHead(folder, "HEAD", timeoutMs, signal),
    statusState(folder, timeoutMs, signal),
  ]);
  if (branch !== input.branch) {
    throw new Error("The worktree branch changed; refresh and try again");
  }
  if (
    input.requireClean &&
    (hasChanges(changes) || headSha !== input.expectedHeadSha)
  ) {
    throw new Error(
      "The source worktree changed after moving; it was kept for review",
    );
  }
  if (input.deleteRemoteBranch) {
    if (!branch) throw new Error("A detached worktree has no remote branch");
    if (branch === input.defaultBranch) {
      throw new Error("The default remote branch cannot be deleted");
    }
    const remote = await git(
      rootFolder,
      ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
      timeoutMs,
      signal,
    );
    if (remote.exitCode === 0) {
      requireSuccess(
        await git(
          rootFolder,
          ["push", "origin", "--delete", branch],
          timeoutMs,
          signal,
        ),
        `Could not delete origin/${branch}`,
      );
    } else if (remote.exitCode !== 2) {
      requireSuccess(remote, `Could not inspect origin/${branch}`);
    }
  }
  requireSuccess(
    await git(
      rootFolder,
      ["worktree", "remove", "--force", folder],
      timeoutMs,
      signal,
    ),
    "Could not remove the worktree",
  );
  if (
    branch &&
    (await refExists(rootFolder, `refs/heads/${branch}`, timeoutMs, signal))
  ) {
    requireSuccess(
      await git(rootFolder, ["branch", "-D", branch], timeoutMs, signal),
      `Worktree removed, but local branch ${branch} could not be deleted`,
    );
  }
  return {
    ...successfulProcess,
    moveId: input.moveId,
    deleted: true,
    branch,
    remoteBranchDeleted: input.deleteRemoteBranch,
  };
};

export const operateWorktree: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = worktreeJobPayload(payload);
  const folder = await validateWorktree(input, timeoutMs, signal);
  if (!input.operation) throw new Error("A worktree operation is required");
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
        ["rev-parse", "--abbrev-ref", "@{upstream}"],
        timeoutMs,
        signal,
      )
    : null;
  const upstream =
    upstreamResult?.exitCode === 0 ? upstreamResult.stdout.trim() : null;
  const runGit = async (args: string[], fallback: string) =>
    requireSuccess(await git(folder, args, timeoutMs, signal), fallback);

  switch (input.operation) {
    case "OPEN_EDITOR": {
      if (input.editorVariant === "NONE" || !input.editorVariant) {
        throw new Error("VS Code is disabled in Settings");
      }
      const app =
        input.editorVariant === "CODE_INSIDERS"
          ? "Visual Studio Code - Insiders"
          : "Visual Studio Code";
      requireSuccess(
        await command("open", ["-a", app, folder], timeoutMs, signal),
        `${app} could not be opened`,
      );
      break;
    }
    case "FORCE_PUSH":
      if (!branch || !upstream)
        throw new Error("Force Push requires a branch with an upstream");
      await runGit(["push", "--force-with-lease"], "Force push failed");
      break;
    case "SYNC": {
      if (!branch || !upstream)
        throw new Error("Sync requires a branch with an upstream");
      if (!input.baseBranch) throw new Error("Sync requires a base branch");
      const statusResult = await runGit(
        ["status", "--porcelain"],
        "Could not inspect worktree changes",
      );
      if (statusResult.stdout.trim())
        throw new Error("Stash or commit changes before syncing");
      await runGit(["fetch", "origin"], "Could not fetch origin");
      const rebase = await git(
        folder,
        ["rebase", `refs/remotes/origin/${input.baseBranch}`],
        timeoutMs,
        signal,
      );
      if (rebase.exitCode !== 0) {
        await git(folder, ["rebase", "--abort"], timeoutMs, signal);
        throw new Error(cleanError(rebase.stderr || "Rebase failed"));
      }
      await runGit(["push", "--force-with-lease"], "Sync push failed");
      break;
    }
    case "PUSH":
      if (!branch) throw new Error("Push requires a branch");
      await runGit(
        upstream ? ["push"] : ["push", "--set-upstream", "origin", "HEAD"],
        upstream ? "Push failed" : "Publish failed",
      );
      break;
    case "RESET": {
      if (!branch || !upstream)
        throw new Error("Reset requires a branch with an upstream");
      const remote = upstream.split("/")[0] || "origin";
      await runGit(["fetch", remote], `Could not fetch ${remote}`);
      await runGit(["reset", "--hard", "@{upstream}"], "Reset failed");
      await runGit(["clean", "-fd"], "Could not remove untracked files");
      break;
    }
    case "STASH_ALL":
      await runGit(["stash", "push", "--include-untracked"], "Stash failed");
      break;
    case "STAGE_ALL":
      await runGit(["add", "--all"], "Stage failed");
      break;
    case "UNSTAGE_ALL":
      await runGit(["reset", "--mixed", "HEAD"], "Unstage failed");
      break;
  }

  return {
    ...successfulProcess,
    worktree: await inspectWorktreeItem(
      folder,
      folder,
      input.baseBranch,
      false,
      Math.min(timeoutMs, 30_000),
      signal,
    ),
  };
};
