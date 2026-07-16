import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import {
  worktreeJobPayload,
  worktreeWatchJobPayload,
  type WorktreeActivityReport,
  type WorktreeChange,
  type WorktreeCommit,
  type WorktreeDetail,
  type WorktreeInventoryItem,
} from "@ai-development-environment/agent-contract/worktrees";

import { captureCommand, type CaptureResult } from "../capture-command.js";
import type { AgentJobHandler, AgentJobHandlerContext } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;
const WATCH_DEBOUNCE_MS = 500;

type ActiveWorktreeWatch = {
  watchId: string;
  codebaseId: string;
  gitDirectory: string;
  folder: string;
  timeoutMs: number;
  watchers: FSWatcher[];
  reporter: AgentJobHandlerContext["reportWorktreeActivity"];
  timer: ReturnType<typeof setTimeout> | null;
  reporting: boolean;
  pending: boolean;
};

const activeWorktreeWatches = new Map<string, ActiveWorktreeWatch>();

function statusHasUnstagedChanges(value: string): boolean {
  const entries = value.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index += 1) {
    const code = entries[index]!.slice(0, 2);
    if (code === "??" || (code[1] !== " " && code[1] !== "!")) return true;
    if ((code[0] === "R" || code[0] === "C") && entries[index + 1]) {
      index += 1;
    }
  }
  return false;
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
    const status = await git(
      entry.folder,
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      entry.timeoutMs,
      new AbortController().signal,
    );
    const report: WorktreeActivityReport = {
      codebaseId: entry.codebaseId,
      gitDirectory: entry.gitDirectory,
      ...(status.exitCode === 0
        ? { hasUnstagedChanges: statusHasUnstagedChanges(status.stdout) }
        : {}),
      observedAt: new Date().toISOString(),
    };
    await entry.reporter(report);
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
    const syncState = !branch
      ? "DETACHED"
      : !upstream
        ? "NO_UPSTREAM"
        : upstreamCounts.ahead === null || upstreamCounts.behind === null
          ? "UNKNOWN"
          : upstreamCounts.ahead > 0 && upstreamCounts.behind > 0
            ? "DIVERGED"
            : upstreamCounts.ahead > 0
              ? "AHEAD"
              : upstreamCounts.behind > 0
                ? "BEHIND"
                : "IN_SYNC";
    return {
      gitDirectory: gitDir,
      folder,
      relativePath: relative(rootFolder, folder) || ".",
      primary,
      branch,
      headSha: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
      upstream,
      ahead: upstreamCounts.ahead,
      behind: upstreamCounts.behind,
      syncState,
      baseAhead: baseCounts.ahead,
      baseBehind: baseCounts.behind,
      hasUnstagedChanges:
        statusResult.exitCode === 0
          ? statusHasUnstagedChanges(statusResult.stdout)
          : false,
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
      upstream: null,
      ahead: null,
      behind: null,
      syncState: "UNKNOWN",
      baseAhead: null,
      baseBehind: null,
      hasUnstagedChanges: false,
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
  const defaultResult = await git(
    rootFolder,
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    timeoutMs,
    signal,
  );
  let defaultBranch =
    defaultResult.exitCode === 0
      ? defaultResult.stdout.trim().replace(/^origin\//, "")
      : knownDefaultBranch;
  if (!defaultBranch) {
    const remoteHead = await git(
      rootFolder,
      ["ls-remote", "--symref", "origin", "HEAD"],
      timeoutMs,
      signal,
    );
    defaultBranch =
      remoteHead.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/m)?.[1] ??
      null;
  }
  const branchesResult = await git(
    rootFolder,
    ["for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin"],
    timeoutMs,
    signal,
  );
  const remoteBranches = branchesResult.stdout
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
  return { complete: true, defaultBranch, remoteBranches, worktrees };
}

function parseNumstat(
  value: string,
): Map<string, [number | null, number | null]> {
  const result = new Map<string, [number | null, number | null]>();
  for (const entry of value.split("\0")) {
    if (!entry) continue;
    const [added, deleted, ...pathParts] = entry.split("\t");
    const path = pathParts.join("\t");
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
    if ((code[0] === "R" || code[0] === "C") && values[index + 1]) index += 1;
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
  const [commitResult, changeResult] = await Promise.all([
    inspectCommits(folder, baseBranch, timeoutMs, signal),
    inspectChanges(folder, timeoutMs, signal),
  ]);
  return {
    commits: commitResult.commits,
    changes: changeResult.changes,
    commitsTruncated: commitResult.truncated,
    changesTruncated: changeResult.truncated,
  };
}

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
    timeoutMs: Math.min(timeoutMs, 30_000),
    watchers: [],
    reporter: context.reportWorktreeActivity,
    timer: null,
    reporting: false,
    pending: false,
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
