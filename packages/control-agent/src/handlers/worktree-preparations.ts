import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type {
  WorktreePreparationAction,
  WorktreePreparationDefinition,
  WorktreePreparationState,
} from "@ai-development-environment/agent-contract/worktrees";

import { captureCommand, type CaptureResult } from "../capture-command.js";

const EXCLUDE_BEGIN = "# BEGIN AIDE PREPARATIONS";
const EXCLUDE_END = "# END AIDE PREPARATIONS";

export type WorktreePreparationResult = {
  id: string;
  definitionHash: string;
  state: WorktreePreparationState;
  message?: string;
};

function cleanError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
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
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function requireSuccess(
  result: CaptureResult,
  fallback: string,
): CaptureResult {
  if (result.cancelled) throw new Error("Preparation was cancelled");
  if (result.timedOut) throw new Error("Preparation timed out");
  if (result.exitCode !== 0) {
    throw new Error(cleanError(result.stderr || fallback));
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function safeTarget(folder: string, path: string): Promise<string> {
  const root = await realpath(folder);
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (
    !fromRoot ||
    fromRoot.startsWith("..") ||
    isAbsolute(fromRoot) ||
    path.includes("\0")
  ) {
    throw new Error(
      "Preparation path must be an exact file inside the worktree",
    );
  }

  let current = root;
  const segments = fromRoot.split(/[\\/]/);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Preparation path crosses symbolic link: ${path}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`Preparation parent is not a directory: ${path}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        break;
      }
      throw error;
    }
  }
  return target;
}

async function isTracked(
  folder: string,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await git(
    folder,
    ["ls-files", "--error-unmatch", "--", path],
    timeoutMs,
    signal,
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  requireSuccess(result, `Could not inspect tracked path ${path}`);
  return false;
}

async function isAssumeUnchanged(
  folder: string,
  path: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const result = requireSuccess(
    await git(folder, ["ls-files", "-v", "--", path], timeoutMs, signal),
    `Could not inspect assume-unchanged state for ${path}`,
  );
  const marker = result.stdout[0];
  return Boolean(marker && /[a-z]/.test(marker));
}

async function setAssumeUnchanged(
  folder: string,
  path: string,
  assumed: boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  requireSuccess(
    await git(
      folder,
      [
        "update-index",
        assumed ? "--assume-unchanged" : "--no-assume-unchanged",
        "--",
        path,
      ],
      timeoutMs,
      signal,
    ),
    `Could not ${assumed ? "mark" : "unmark"} ${path} as assume unchanged`,
  );
}

function excludeEntry(path: string): string {
  return `/${path}`;
}

function withoutAideExcludeBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  const output: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === EXCLUDE_BEGIN) {
      inBlock = true;
      continue;
    }
    if (line === EXCLUDE_END) {
      inBlock = false;
      continue;
    }
    if (!inBlock) output.push(line);
  }
  return output.join("\n").replace(/\n+$/, "");
}

async function excludeFile(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const result = requireSuccess(
    await git(
      folder,
      ["rev-parse", "--git-path", "info/exclude"],
      timeoutMs,
      signal,
    ),
    "Could not locate the repository exclude file",
  );
  const candidate = result.stdout.trim();
  return isAbsolute(candidate) ? candidate : resolve(folder, candidate);
}

async function readExcludeEntries(
  folder: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Set<string>> {
  const path = await excludeFile(folder, timeoutMs, signal);
  let value = "";
  try {
    value = await readFile(path, "utf8");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const start = value.split(/\r?\n/).indexOf(EXCLUDE_BEGIN);
  const end = value.split(/\r?\n/).indexOf(EXCLUDE_END);
  if (start < 0 || end <= start) return new Set();
  return new Set(value.split(/\r?\n/).slice(start + 1, end));
}

async function reconcileExcludeFile(
  folder: string,
  definitions: WorktreePreparationDefinition[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const path = await excludeFile(folder, timeoutMs, signal);
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const base = withoutAideExcludeBlock(existing);
  const entries = definitions
    .filter((definition) => definition.kind === "WRITE")
    .map((definition) => excludeEntry(definition.path))
    .sort((left, right) => left.localeCompare(right));
  const block = entries.length
    ? [EXCLUDE_BEGIN, ...entries, EXCLUDE_END].join("\n")
    : "";
  const next = [base, block].filter(Boolean).join("\n\n");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next ? `${next}\n` : "", "utf8");
}

function decodeContents(definition: WorktreePreparationDefinition): Buffer {
  if (definition.contentBase64 === null) {
    throw new Error(`Write preparation ${definition.path} has no contents`);
  }
  const contents = Buffer.from(definition.contentBase64, "base64");
  const canonicalInput = definition.contentBase64.replace(/=+$/, "");
  if (contents.toString("base64").replace(/=+$/, "") !== canonicalInput) {
    throw new Error(
      `Write preparation ${definition.path} has invalid base64 contents`,
    );
  }
  return contents;
}

async function removeTarget(target: string, path: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      throw new Error(`Preparation path is a directory: ${path}`);
    }
    await rm(target, { force: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function restoreFromHead(
  folder: string,
  definition: WorktreePreparationDefinition,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const target = await safeTarget(folder, definition.path);
  if (await isTracked(folder, definition.path, timeoutMs, signal)) {
    await setAssumeUnchanged(folder, definition.path, false, timeoutMs, signal);
    const atHead = await git(
      folder,
      ["cat-file", "-e", `HEAD:${definition.path}`],
      timeoutMs,
      signal,
    );
    if (atHead.exitCode === 0) {
      requireSuccess(
        await git(
          folder,
          ["restore", "--source=HEAD", "--worktree", "--", definition.path],
          timeoutMs,
          signal,
        ),
        `Could not restore ${definition.path} from HEAD`,
      );
      return;
    }
    if (atHead.exitCode !== 1 && atHead.exitCode !== 128) {
      requireSuccess(atHead, `Could not inspect ${definition.path} in HEAD`);
    }
  }
  await removeTarget(target, definition.path);
}

async function applyOne(
  folder: string,
  definition: WorktreePreparationDefinition,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreePreparationState> {
  const target = await safeTarget(folder, definition.path);
  const tracked = await isTracked(folder, definition.path, timeoutMs, signal);
  if (definition.kind === "ASSUME_UNCHANGED") {
    if (!tracked) return "NOT_APPLICABLE";
    await setAssumeUnchanged(folder, definition.path, true, timeoutMs, signal);
    return "APPLIED";
  }
  if (definition.kind === "DELETE") {
    await removeTarget(target, definition.path);
  } else {
    const contents = decodeContents(definition);
    let executable = false;
    try {
      const info = await lstat(target);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        throw new Error(`Preparation path is a directory: ${definition.path}`);
      }
      executable = info.isFile() && (info.mode & 0o111) !== 0;
      if (info.isSymbolicLink()) await rm(target, { force: true });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await safeTarget(folder, definition.path);
    await writeFile(target, contents, { mode: executable ? 0o755 : 0o644 });
    if (executable) await chmod(target, 0o755);
  }
  if (tracked) {
    await setAssumeUnchanged(folder, definition.path, true, timeoutMs, signal);
  }
  return "APPLIED";
}

async function undoOne(
  folder: string,
  definition: WorktreePreparationDefinition,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreePreparationState> {
  if (definition.kind === "ASSUME_UNCHANGED") {
    if (!(await isTracked(folder, definition.path, timeoutMs, signal))) {
      return "NOT_APPLICABLE";
    }
    await setAssumeUnchanged(folder, definition.path, false, timeoutMs, signal);
    return "UNDONE";
  }
  await restoreFromHead(folder, definition, timeoutMs, signal);
  return "UNDONE";
}

async function inspectOne(
  folder: string,
  definition: WorktreePreparationDefinition,
  excludeEntries: Set<string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreePreparationState> {
  const target = await safeTarget(folder, definition.path);
  const tracked = await isTracked(folder, definition.path, timeoutMs, signal);
  const assumed = tracked
    ? await isAssumeUnchanged(folder, definition.path, timeoutMs, signal)
    : false;
  if (definition.kind === "ASSUME_UNCHANGED") {
    return tracked ? (assumed ? "APPLIED" : "DRIFTED") : "NOT_APPLICABLE";
  }
  if (definition.kind === "DELETE") {
    return !(await exists(target)) && (!tracked || assumed)
      ? "APPLIED"
      : "DRIFTED";
  }
  let matches = false;
  try {
    const info = await lstat(target);
    if (info.isFile()) {
      const expected = createHash("sha256")
        .update(decodeContents(definition))
        .digest("hex");
      const actual = createHash("sha256")
        .update(await readFile(target))
        .digest("hex");
      matches = actual === expected;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const hidden = tracked
    ? assumed
    : excludeEntries.has(excludeEntry(definition.path));
  return matches && hidden ? "APPLIED" : "DRIFTED";
}

export async function executeWorktreePreparations(
  folder: string,
  definitions: WorktreePreparationDefinition[],
  action: WorktreePreparationAction,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreePreparationResult[]> {
  let excludeError: string | null = null;
  if (action !== "INSPECT") {
    try {
      await reconcileExcludeFile(folder, definitions, timeoutMs, signal);
    } catch (error) {
      excludeError = cleanError(error);
    }
  }
  let excludeEntries = new Set<string>();
  try {
    excludeEntries = await readExcludeEntries(folder, timeoutMs, signal);
  } catch (error) {
    excludeError ??= cleanError(error);
  }
  const results: WorktreePreparationResult[] = [];
  for (const definition of definitions) {
    if (definition.kind === "WRITE" && excludeError) {
      results.push({
        id: definition.id,
        definitionHash: definition.definitionHash,
        state: "ERROR",
        message: excludeError,
      });
      continue;
    }
    try {
      const state =
        action === "APPLY"
          ? await applyOne(folder, definition, timeoutMs, signal)
          : action === "UNDO"
            ? await undoOne(folder, definition, timeoutMs, signal)
            : await inspectOne(
                folder,
                definition,
                excludeEntries,
                timeoutMs,
                signal,
              );
      results.push({
        id: definition.id,
        definitionHash: definition.definitionHash,
        state,
      });
    } catch (error) {
      results.push({
        id: definition.id,
        definitionHash: definition.definitionHash,
        state: "ERROR",
        message: cleanError(error),
      });
    }
  }
  return results;
}

export async function suspendWorktreePreparations(
  folder: string,
  definitions: WorktreePreparationDefinition[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WorktreePreparationResult[]> {
  let excludeError: string | null = null;
  try {
    await reconcileExcludeFile(folder, definitions, timeoutMs, signal);
  } catch (error) {
    excludeError = cleanError(error);
  }
  const results: WorktreePreparationResult[] = [];
  for (const definition of definitions) {
    if (definition.kind === "WRITE" && excludeError) {
      results.push({
        id: definition.id,
        definitionHash: definition.definitionHash,
        state: "ERROR",
        message: excludeError,
      });
      continue;
    }
    try {
      if (definition.kind === "ASSUME_UNCHANGED") {
        if (await isTracked(folder, definition.path, timeoutMs, signal)) {
          await restoreFromHead(folder, definition, timeoutMs, signal);
          results.push({
            id: definition.id,
            definitionHash: definition.definitionHash,
            state: "SUSPENDED",
          });
        } else {
          results.push({
            id: definition.id,
            definitionHash: definition.definitionHash,
            state: "NOT_APPLICABLE",
          });
        }
      } else {
        await restoreFromHead(folder, definition, timeoutMs, signal);
        results.push({
          id: definition.id,
          definitionHash: definition.definitionHash,
          state: "SUSPENDED",
        });
      }
    } catch (error) {
      results.push({
        id: definition.id,
        definitionHash: definition.definitionHash,
        state: "ERROR",
        message: cleanError(error),
      });
    }
  }
  return results;
}

export async function preparationConflictPaths(
  folder: string,
  definitions: WorktreePreparationDefinition[],
  remoteBase: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string[]> {
  const paths: string[] = [];
  for (const definition of definitions) {
    const changedByBase = await git(
      folder,
      ["diff", "--quiet", `HEAD...${remoteBase}`, "--", definition.path],
      timeoutMs,
      signal,
    );
    if (changedByBase.exitCode === 1) {
      const tracked = await isTracked(
        folder,
        definition.path,
        timeoutMs,
        signal,
      );
      let managedChange = false;
      if (tracked) {
        const head = await git(
          folder,
          ["rev-parse", `HEAD:${definition.path}`],
          timeoutMs,
          signal,
        );
        const working = await git(
          folder,
          ["hash-object", "--", definition.path],
          timeoutMs,
          signal,
        );
        managedChange =
          head.exitCode !== 0 ||
          working.exitCode !== 0 ||
          head.stdout.trim() !== working.stdout.trim();
      } else if (definition.kind === "WRITE") {
        managedChange = await exists(await safeTarget(folder, definition.path));
      }
      if (managedChange) paths.push(definition.path);
      continue;
    }
    requireSuccess(
      changedByBase,
      `Could not inspect preparation conflict for ${definition.path}`,
    );
  }
  return paths;
}
