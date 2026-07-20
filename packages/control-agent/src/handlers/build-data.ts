import { lstat, opendir, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  buildDataScanPayload,
  buildDataTargetsPayload,
  type BuildDataDeleteResult,
  type BuildDataScanEntry,
  type BuildDataSizeResult,
} from "@ai-development-environment/agent-contract/build-data";

import { captureCommand } from "../capture-command.js";
import type { AgentJobHandler } from "./index.js";

const successfulProcess = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized !== "." &&
    normalized.split("/").every((part) => part && part !== ".." && part !== ".")
  );
}

async function configuredRoots(
  payload: ReturnType<typeof buildDataScanPayload>,
): Promise<string[]> {
  if (payload.mode === "DEFAULT") {
    return [join(homedir(), "Library", "Developer", "Xcode", "DerivedData")];
  }
  if (payload.mode === "ABSOLUTE") {
    if (!payload.path || !isAbsolute(payload.path)) {
      throw new Error("Absolute Derived Data mode requires an absolute path");
    }
    return [resolve(payload.path)];
  }
  if (!payload.path || !safeRelativePath(payload.path)) {
    throw new Error("Relative Derived Data mode requires a safe relative path");
  }
  return payload.worktrees.map((worktree) =>
    resolve(worktree.folder, payload.path!),
  );
}

async function workspacePath(
  plistPath: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  try {
    const result = await captureCommand({
      command: "/usr/bin/plutil",
      args: ["-extract", "WorkspacePath", "raw", "-o", "-", plistPath],
      timeoutMs: Math.min(timeoutMs, 5_000),
      signal,
    });
    signal.throwIfAborted();
    const value = result.stdout.trim();
    return result.exitCode === 0 && value ? value : null;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function scanRoot(
  configuredRoot: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ entries: BuildDataScanEntry[]; warning: string | null }> {
  signal.throwIfAborted();
  let rootPath: string;
  try {
    rootPath = await realpath(configuredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], warning: null };
    }
    return {
      entries: [],
      warning: `${configuredRoot}: ${errorMessage(error)}`,
    };
  }

  let children;
  try {
    children = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    return {
      entries: [],
      warning: `${rootPath}: ${errorMessage(error)}`,
    };
  }

  const entries: BuildDataScanEntry[] = [];
  for (const child of children) {
    signal.throwIfAborted();
    if (!child.isDirectory()) continue;
    const path = join(rootPath, child.name);
    const projectPath = await workspacePath(
      join(path, "info.plist"),
      timeoutMs,
      signal,
    );
    entries.push({
      path,
      rootPath,
      name: child.name,
      kind: projectPath
        ? "PROJECT"
        : child.name.toLocaleLowerCase().endsWith(".noindex")
          ? "SHARED_CACHE"
          : "PENDING",
      workspacePath: projectPath,
    });
  }
  entries.sort((first, second) => first.name.localeCompare(second.name));
  return { entries, warning: null };
}

async function scanDeviceSupport(
  signal: AbortSignal,
): Promise<{ entries: BuildDataScanEntry[]; warning: string | null }> {
  const configuredRoot = join(
    process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY ?? homedir(),
    ...(process.env.ADE_IOS_DEVICE_SUPPORT_DIRECTORY
      ? []
      : ["Library", "Developer", "Xcode", "iOS DeviceSupport"]),
  );
  signal.throwIfAborted();
  let rootPath: string;
  try {
    rootPath = await realpath(configuredRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], warning: null };
    }
    return {
      entries: [],
      warning: `${configuredRoot}: ${errorMessage(error)}`,
    };
  }
  try {
    const children = await readdir(rootPath, { withFileTypes: true });
    return {
      entries: children
        .filter((child) => child.isDirectory() && !child.isSymbolicLink())
        .map((child) => ({
          path: join(rootPath, child.name),
          rootPath,
          name: child.name,
          kind: "DEVICE_SUPPORT" as const,
          workspacePath: null,
        }))
        .sort((first, second) => first.name.localeCompare(second.name)),
      warning: null,
    };
  } catch (error) {
    return {
      entries: [],
      warning: `${rootPath}: ${errorMessage(error)}`,
    };
  }
}

export const scanBuildData: AgentJobHandler = async (
  rawPayload,
  timeoutMs,
  signal,
) => {
  const payload = buildDataScanPayload(rawPayload);
  const roots = await configuredRoots(payload);
  const canonicalRoots = new Set<string>();
  const entries: BuildDataScanEntry[] = [];
  const warnings: string[] = [];
  for (const root of roots) {
    signal.throwIfAborted();
    let canonical = root;
    try {
      canonical = await realpath(root);
    } catch {
      // scanRoot distinguishes missing roots from actionable warnings.
    }
    if (canonicalRoots.has(canonical)) continue;
    canonicalRoots.add(canonical);
    const result = await scanRoot(root, timeoutMs, signal);
    entries.push(...result.entries);
    if (result.warning) warnings.push(result.warning);
  }
  const deviceSupport = await scanDeviceSupport(signal);
  entries.push(...deviceSupport.entries);
  if (deviceSupport.warning) warnings.push(deviceSupport.warning);
  return { ...successfulProcess, entries, warnings };
};

function assertDirectChild(rootPath: string, path: string): void {
  if (!isAbsolute(rootPath) || !isAbsolute(path)) {
    throw new Error("Build Data targets must use absolute paths");
  }
  const root = resolve(rootPath);
  const target = resolve(path);
  if (
    target === root ||
    dirname(target) !== root ||
    basename(target) !== basename(path)
  ) {
    throw new Error("Build Data target must be a direct child of its root");
  }
}

async function allocatedBytes(
  path: string,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const stats = await lstat(path);
  const ownBytes = Number(stats.blocks) * 512;
  if (stats.isSymbolicLink() || !stats.isDirectory()) return ownBytes;
  let total = ownBytes;
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      signal.throwIfAborted();
      total += await allocatedBytes(join(path, entry.name), signal);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return total;
}

export const sizeBuildData: AgentJobHandler = async (
  rawPayload,
  _timeoutMs,
  signal,
) => {
  const payload = buildDataTargetsPayload(rawPayload);
  const sizes: BuildDataSizeResult["sizes"] = [];
  for (const target of payload.targets) {
    signal.throwIfAborted();
    try {
      assertDirectChild(target.rootPath, target.path);
      const rootPath = await realpath(target.rootPath);
      if (
        rootPath !== resolve(target.rootPath) ||
        dirname(resolve(target.path)) !== rootPath
      ) {
        throw new Error("Build Data root changed since the scan");
      }
      const stats = await lstat(target.path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Build Data target is not a directory");
      }
      sizes.push({
        path: target.path,
        sizeBytes: await allocatedBytes(target.path, signal),
        error: null,
      });
    } catch (error) {
      signal.throwIfAborted();
      sizes.push({
        path: target.path,
        sizeBytes: null,
        error: errorMessage(error),
      });
    }
  }
  return { ...successfulProcess, sizes };
};

export const deleteBuildData: AgentJobHandler = async (
  rawPayload,
  _timeoutMs,
  signal,
) => {
  const payload = buildDataTargetsPayload(rawPayload);
  const deleted: BuildDataDeleteResult["deleted"] = [];
  for (const target of payload.targets) {
    signal.throwIfAborted();
    try {
      assertDirectChild(target.rootPath, target.path);
      const rootPath = await realpath(target.rootPath);
      if (
        rootPath !== resolve(target.rootPath) ||
        dirname(resolve(target.path)) !== rootPath
      ) {
        throw new Error("Build Data root changed since the scan");
      }
      const stats = await lstat(target.path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("Build Data target is not a directory");
      }
      await rm(target.path, { recursive: true, force: false, maxRetries: 3 });
      deleted.push({ path: target.path, deleted: true, error: null });
    } catch (error) {
      signal.throwIfAborted();
      deleted.push({
        path: target.path,
        deleted: false,
        error: errorMessage(error),
      });
    }
  }
  return { ...successfulProcess, deleted };
};
