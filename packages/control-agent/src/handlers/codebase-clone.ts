import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import { codebaseClonePayload } from "@ai-development-environment/agent-contract/codebases";

import { captureCommand } from "../capture-command.js";
import { RepositoryCoordinator } from "../repository-coordinator.js";
import { inspectCodebase } from "./codebases.js";
import type { AgentJobHandler } from "./index.js";

const destinations = new RepositoryCoordinator();
const success = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

type DirectoryIdentity = { dev: number; ino: number };

function sameDirectory(
  info: Awaited<ReturnType<typeof lstat>>,
  identity: DirectoryIdentity,
): boolean {
  return (
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    info.dev === identity.dev &&
    info.ino === identity.ino
  );
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Walk every component without following a symbolic link, including the configured base. */
async function safeDirectory(path: string, create: boolean): Promise<string> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of absolute
    .slice(current.length)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!missing(error) || !create) throw error;
      await mkdir(current).catch((failure: unknown) => {
        if (
          !(failure instanceof Error) ||
          !("code" in failure) ||
          failure.code !== "EEXIST"
        )
          throw failure;
      });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        "Clone destination contains a symbolic link or a non-directory path",
      );
    }
  }
  return realpath(absolute);
}

async function ownsDirectory(
  parent: string,
  parentIdentity: DirectoryIdentity,
  directory: string,
  identity: DirectoryIdentity,
): Promise<boolean> {
  try {
    // A rename or symlink replacement must not redirect cleanup to another tree. Check
    // both the original parent and the operation-owned directory, including all ancestors.
    if ((await safeDirectory(parent, false)) !== parent) return false;
    if (!sameDirectory(await lstat(parent), parentIdentity)) return false;
    return sameDirectory(await lstat(directory), identity);
  } catch {
    return false;
  }
}

export const inspectCloneDestination: AgentJobHandler = async (
  value,
  timeoutMs,
  signal,
) => {
  const payload = codebaseClonePayload(value);
  if (!isAbsolute(payload.baseDirectory))
    throw new Error("Clone base directory must be absolute on this agent");
  const destination = resolve(payload.baseDirectory, payload.relativePath);
  try {
    // A missing component is cloneable. Check every existing ancestor before accepting it.
    await safeDirectory(dirname(destination), false);
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(
        "Destination is already occupied by a file or symbolic link",
      );
    const snapshot = await inspectCodebase(
      destination,
      timeoutMs,
      signal,
      payload.expectedOrigin,
    );
    if (
      snapshot.availability !== "AVAILABLE" ||
      snapshot.canonicalOrigin !== payload.expectedOrigin ||
      snapshot.linkedWorktree ||
      (await realpath(destination)) !== snapshot.folder
    ) {
      throw new Error(
        "Destination already exists and is not a matching primary repository checkout",
      );
    }
    return {
      ...success,
      destinationPath: destination,
      status: "REUSE",
      snapshot,
      error: null,
    };
  } catch (error) {
    if (missing(error))
      return {
        ...success,
        destinationPath: destination,
        status: "MISSING",
        error: null,
      };
    return {
      ...success,
      destinationPath: destination,
      status: "CONFLICT",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const cloneCodebase: AgentJobHandler = async (
  value,
  timeoutMs,
  signal,
) => {
  const payload = codebaseClonePayload(value);
  if (!isAbsolute(payload.baseDirectory))
    throw new Error("Clone base directory must be absolute on this agent");
  const destination = resolve(payload.baseDirectory, payload.relativePath);
  const scope = relative(resolve(payload.baseDirectory), destination);
  if (
    !scope ||
    scope.startsWith(`..${sep}`) ||
    scope === ".." ||
    isAbsolute(scope)
  ) {
    throw new Error("Clone destination escapes the configured base directory");
  }
  return destinations.run(destination, async () => {
    if (signal.aborted) return { ...success, exitCode: null, cancelled: true };
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    await safeDirectory(payload.baseDirectory, true);
    const parent = await safeDirectory(dirname(destination), true);
    const parentIdentity = await lstat(parent);
    const existing = await lstat(destination).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(
          "Clone destination already exists and is not a repository directory",
        );
      }
      const snapshot = await inspectCodebase(
        destination,
        remaining(),
        signal,
        payload.expectedOrigin,
      );
      if (
        snapshot.availability !== "AVAILABLE" ||
        snapshot.canonicalOrigin !== payload.expectedOrigin ||
        snapshot.linkedWorktree ||
        (await realpath(destination)) !== snapshot.folder
      ) {
        throw new Error(
          "Clone destination already exists; only a matching repository checkout can be reused",
        );
      }
      return { ...success, snapshot, reused: true };
    }

    const staging = await mkdtemp(join(parent, ".aide-clone-"));
    const stagingIdentity = await lstat(staging);
    const checkout = join(staging, "checkout");
    const verifyStaging = async () => {
      if (
        !(await ownsDirectory(parent, parentIdentity, staging, stagingIdentity))
      ) {
        throw new Error(
          "Clone staging directory changed during checkout creation",
        );
      }
    };
    let reservation: DirectoryIdentity | null = null;
    try {
      await verifyStaging();
      const result = await captureCommand({
        command: "git",
        args: [
          "-c",
          "core.hooksPath=",
          "clone",
          "--no-recurse-submodules",
          "--",
          payload.remoteUrl,
          checkout,
        ],
        cwd: parent,
        timeoutMs: remaining(),
        signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      if (result.cancelled || result.timedOut) return result;
      if (result.exitCode !== 0) {
        throw new Error(
          (result.stderr || "Git clone failed")
            .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1")
            .slice(0, 2_000),
        );
      }
      await verifyStaging();
      const inspected = await inspectCodebase(
        checkout,
        remaining(),
        signal,
        payload.expectedOrigin,
      );
      if (
        inspected.availability !== "AVAILABLE" ||
        inspected.canonicalOrigin !== payload.expectedOrigin ||
        inspected.linkedWorktree
      ) {
        throw new Error(
          "Cloned repository does not match the requested origin",
        );
      }
      if (signal.aborted || !remaining())
        return {
          ...success,
          exitCode: null,
          cancelled: signal.aborted,
          timedOut: !signal.aborted,
        };
      // Reserve exclusively before promotion. Never rename over a pre-existing destination.
      // Rename only replaces our still-empty directory; another writer adding content causes
      // ENOTEMPTY and leaves that content untouched. The staging checkout is on the same volume.
      await verifyStaging();
      await mkdir(destination);
      reservation = await lstat(destination);
      const current = await lstat(destination);
      if (
        current.isSymbolicLink() ||
        current.dev !== reservation.dev ||
        current.ino !== reservation.ino
      ) {
        throw new Error("Clone destination changed during checkout creation");
      }
      await rename(checkout, destination);
      reservation = null;
      return {
        ...success,
        snapshot: { ...inspected, folder: destination },
        reused: false,
      };
    } finally {
      if (reservation) {
        if (
          await ownsDirectory(parent, parentIdentity, destination, reservation)
        ) {
          // Only remove our empty reservation, never recursively remove destination contents.
          await rmdir(destination).catch(() => undefined);
        }
      }
      if (
        await ownsDirectory(parent, parentIdentity, staging, stagingIdentity)
      ) {
        await rm(staging, { recursive: true, force: true });
      }
    }
  });
};
