import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  pinnedForcePushArguments,
  readSyncPushLease,
  saveSyncPushLease,
  snapshotPushLease,
} from "./git-sync-snapshot.js";

const execute = promisify(execFile);
let directory: string;
let folder: string;
let origin: string;
let fork: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}

const snapshot = () =>
  snapshotPushLease(folder, 10_000, new AbortController().signal);

async function commit(message: string): Promise<string> {
  await writeFile(join(folder, "README.md"), `${message}\n`);
  await git(folder, "add", "README.md");
  await git(folder, "commit", "-m", message);
  return git(folder, "rev-parse", "HEAD");
}

beforeEach(async () => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  directory = await mkdtemp(join(tmpdir(), "aide-push-lease-"));
  folder = join(directory, "worktree");
  origin = join(directory, "origin.git");
  fork = join(directory, "fork.git");
  await execute("git", ["init", "-b", "main", folder]);
  for (const remote of [origin, fork])
    await execute("git", ["init", "--bare", "-b", "main", remote]);
  await git(folder, "config", "user.name", "Test User");
  await git(folder, "config", "user.email", "test@example.com");
  await git(folder, "config", "commit.gpgsign", "false");
  await git(folder, "config", "push.default", "simple");
  await commit("Initial commit");
  await git(folder, "remote", "add", "origin", origin);
  await git(folder, "remote", "add", "fork", fork);
  await git(folder, "push", "--set-upstream", "origin", "main");
  await git(folder, "push", "fork", "main");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("configured force-push destinations", () => {
  test("preserves simple push protection when a feature branch tracks main", async () => {
    const originalMain = await git(origin, "rev-parse", "main");
    await git(
      folder,
      "switch",
      "--create",
      "feature/test",
      "--track",
      "origin/main",
    );
    await commit("Feature change");

    await expect(snapshot()).rejects.toThrow(
      /upstream branch.*does not match/s,
    );
    expect(await git(origin, "rev-parse", "main")).toBe(originalMain);
  });

  test.each(["branch.main.pushRemote", "remote.pushDefault"])(
    "honors %s without updating the upstream repository",
    async (setting) => {
      const originalMain = await git(origin, "rev-parse", "main");
      await git(folder, "config", setting, "fork");
      const nextHead = await commit("Feature change");
      const lease = await snapshot();

      expect(lease).toMatchObject({
        remote: "fork",
        ref: "refs/heads/main",
        sha: originalMain,
      });
      await git(folder, ...pinnedForcePushArguments(lease));

      expect(await git(fork, "rev-parse", "main")).toBe(nextHead);
      expect(await git(origin, "rev-parse", "main")).toBe(originalMain);
    },
  );

  test("gives the branch push remote precedence over the default push remote", async () => {
    await git(folder, "config", "remote.pushDefault", "fork");
    await git(folder, "config", "branch.main.pushRemote", "origin");
    expect((await snapshot()).remote).toBe("origin");
  });

  test.each(["refs/heads/main", "HEAD"])(
    "pins the configured %s destination using its custom fetch mapping",
    async (source) => {
      const originalMain = await git(origin, "rev-parse", "main");
      await git(folder, "config", "branch.main.pushRemote", "fork");
      await git(
        folder,
        "config",
        "remote.fork.push",
        `${source}:refs/heads/release`,
      );
      await git(
        folder,
        "config",
        "remote.fork.fetch",
        "+refs/heads/*:refs/fork-tracking/*",
      );
      await git(folder, "push", "fork", "HEAD:refs/heads/release");
      await git(folder, "fetch", "fork");
      const nextHead = await commit("Release change");
      const lease = await snapshot();

      expect(lease).toMatchObject({
        remote: "fork",
        ref: "refs/heads/release",
        sha: originalMain,
      });
      await git(folder, ...pinnedForcePushArguments(lease));

      expect(await git(fork, "rev-parse", "release")).toBe(nextHead);
      expect(await git(fork, "rev-parse", "main")).toBe(originalMain);
      expect(await git(origin, "rev-parse", "main")).toBe(originalMain);
    },
  );

  test("keeps a fork lease pinned after a sibling fetch sees a remote update", async () => {
    await git(folder, "config", "branch.main.pushRemote", "fork");
    const nextHead = await commit("Feature change");
    const lease = await snapshot();
    const concurrentHead = await commit("Concurrent change");
    await git(fork, "fetch", folder, "main");
    await git(fork, "update-ref", "refs/heads/main", concurrentHead);
    await git(folder, "reset", "--hard", nextHead);
    await git(folder, "fetch", "fork");

    await expect(
      git(folder, ...pinnedForcePushArguments(lease)),
    ).rejects.toThrow(/stale info/);
    expect(await git(fork, "rev-parse", "main")).toBe(concurrentHead);
  });

  test("supports push.default=current creating a same-name feature branch", async () => {
    const originalMain = await git(origin, "rev-parse", "main");
    await git(
      folder,
      "switch",
      "--create",
      "feature/test",
      "--track",
      "origin/main",
    );
    await git(folder, "config", "push.default", "current");
    const nextHead = await commit("Feature change");
    const lease = await snapshot();

    expect(lease).toMatchObject({ ref: "refs/heads/feature/test", sha: "" });
    await git(folder, ...pinnedForcePushArguments(lease));

    expect(await git(origin, "rev-parse", "feature/test")).toBe(nextHead);
    expect(await git(origin, "rev-parse", "main")).toBe(originalMain);
  });

  test("respects push.default=nothing", async () => {
    await git(folder, "config", "push.default", "nothing");
    await expect(snapshot()).rejects.toThrow(/push.default is "nothing"/);
  });

  test("rejects multiple refspecs instead of selecting an arbitrary destination", async () => {
    await git(folder, "branch", "another");
    await git(folder, "config", "--add", "remote.origin.push", "main:main");
    await git(
      folder,
      "config",
      "--add",
      "remote.origin.push",
      "another:another",
    );
    await expect(snapshot()).rejects.toThrow("Configure a single push refspec");
  });

  test("rejects multiple push URLs before submission", async () => {
    await git(folder, "config", "--add", "remote.origin.pushurl", origin);
    await git(folder, "config", "--add", "remote.origin.pushurl", fork);
    await expect(snapshot()).rejects.toThrow(
      "Configure a single push destination",
    );
  });

  test("runs pre-push hooks only during the actual push", async () => {
    const hook = join(folder, ".git", "hooks", "pre-push");
    const marker = join(folder, ".git", "push-hook-ran");
    await writeFile(
      hook,
      '#!/bin/sh\nprintf ran >> "$(git rev-parse --git-dir)/push-hook-ran"\n',
    );
    await chmod(hook, 0o755);
    await commit("Feature change");
    const lease = await snapshot();
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await git(folder, ...pinnedForcePushArguments(lease));
    expect(await readFile(marker, "utf8")).toBe("ran");
  });

  test("round-trips new leases and requires a fresh Sync for old destination selection", async () => {
    const gitDirectory = join(folder, ".git");
    const lease = await snapshot();
    await saveSyncPushLease(gitDirectory, lease);
    await expect(readSyncPushLease(gitDirectory, "main")).resolves.toEqual(
      lease,
    );

    const { version: _version, ...legacy } = lease;
    await writeFile(
      join(gitDirectory, "aide-sync-push-lease.json"),
      JSON.stringify(legacy),
    );
    await expect(readSyncPushLease(gitDirectory, "main")).rejects.toThrow(
      "sync again before pushing",
    );
  });
});
