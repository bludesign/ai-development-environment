import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  codebaseBrowsePayload,
  codebaseJobPayload,
  normalizeGitOrigin,
  type CodebaseDirectoryListing,
  type CodebaseSnapshot,
} from "@ai-development-environment/agent-contract/codebases";

import { captureCommand, type CaptureResult } from "../capture-command.js";
import type { AgentJobHandler } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

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
  return captureCommand({
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

export async function inspectCodebase(
  selectedFolder: string,
  timeoutMs: number,
  signal: AbortSignal,
  expectedOrigin?: string,
): Promise<CodebaseSnapshot> {
  const fallbackFolder = resolve(selectedFolder);
  const base = baseSnapshot(fallbackFolder);
  let selected: string;
  try {
    selected = await realpath(fallbackFolder);
    if (!(await stat(selected)).isDirectory())
      throw new Error("Folder is not a directory");
  } catch (error) {
    return {
      ...base,
      availability: "MISSING",
      error: cleanError(error),
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
        ...base,
        folder: selected,
        availability: "NOT_REPOSITORY",
        error: cleanError(
          rootResult.stderr || "Folder is not a Git repository",
        ),
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
        ...base,
        folder,
        availability: "NOT_REPOSITORY",
        error: "Bare repositories are not supported",
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
        ...base,
        folder,
        availability: "ERROR",
        error: "Repository does not have an origin remote",
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
    };
  } catch (error) {
    return {
      ...base,
      folder: selected,
      availability: "ERROR",
      error: cleanError(error),
    };
  }
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
  return {
    ...successfulProcess,
    snapshot: await inspectCodebase(input.folder, timeoutMs, signal),
  };
};

export const refreshCodebase: AgentJobHandler = inspectCodebaseFolder;

export const fetchCodebase: AgentJobHandler = async (
  payload,
  timeoutMs,
  signal,
) => {
  const input = codebaseJobPayload(payload);
  const before = await inspectCodebase(
    input.folder,
    Math.min(timeoutMs, 30_000),
    signal,
    input.expectedOrigin,
  );
  if (before.availability !== "AVAILABLE") {
    return { ...successfulProcess, exitCode: 1, snapshot: before };
  }
  const result = await git(
    input.folder,
    ["fetch", "origin"],
    timeoutMs,
    signal,
  );
  const snapshot = await inspectCodebase(
    input.folder,
    Math.min(timeoutMs, 30_000),
    signal,
    input.expectedOrigin,
  );
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
