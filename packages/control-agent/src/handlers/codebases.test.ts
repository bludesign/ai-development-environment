import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { inspectCodebase, inspectCodebaseFolder } from "./codebases.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(folder: string, ...args: string[]) {
  return execute("git", ["-c", "commit.gpgsign=false", "-C", folder, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

async function repository() {
  const folder = await mkdtemp(join(tmpdir(), "codebase-agent-"));
  temporaryDirectories.push(folder);
  await git(folder, "init", "-b", "main");
  await git(folder, "config", "user.email", "test@example.com");
  await git(folder, "config", "user.name", "Test User");
  await git(folder, "commit", "--allow-empty", "-m", "Initial commit");
  await git(
    folder,
    "remote",
    "add",
    "origin",
    "git@github.com:OpenAI/Codex.git",
  );
  return folder;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("codebase Git inspection", () => {
  test("resolves a nested folder and reports a normalized origin", async () => {
    const folder = await repository();
    const nested = join(folder, "packages", "example");
    await mkdir(nested, { recursive: true });

    const snapshot = await inspectCodebase(
      nested,
      10_000,
      new AbortController().signal,
    );

    expect(snapshot).toMatchObject({
      folder: await realpath(folder),
      canonicalOrigin: "github.com/openai/codex",
      branch: "main",
      syncState: "NO_UPSTREAM",
      availability: "AVAILABLE",
      linkedWorktree: false,
    });
  });

  test("reports upstream alignment and detached HEAD", async () => {
    const folder = await repository();
    const head = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "update-ref", "refs/remotes/origin/main", head);
    await git(folder, "branch", "--set-upstream-to=origin/main", "main");

    expect(
      await inspectCodebase(folder, 10_000, new AbortController().signal),
    ).toMatchObject({ syncState: "IN_SYNC", ahead: 0, behind: 0 });

    await git(folder, "checkout", "--detach", head);
    expect(
      await inspectCodebase(folder, 10_000, new AbortController().signal),
    ).toMatchObject({ syncState: "DETACHED", branch: null });
  });

  test("detects linked worktrees and origin changes", async () => {
    const folder = await repository();
    const linked = `${folder}-linked`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "--detach", linked);

    expect(
      await inspectCodebase(
        linked,
        10_000,
        new AbortController().signal,
        "github.com/another/repository",
      ),
    ).toMatchObject({
      linkedWorktree: true,
      availability: "ORIGIN_MISMATCH",
    });
  });

  test("distinguishes missing folders and non-repositories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "codebase-agent-empty-"));
    temporaryDirectories.push(parent);

    expect(
      await inspectCodebase(
        join(parent, "missing"),
        10_000,
        new AbortController().signal,
      ),
    ).toMatchObject({ availability: "MISSING" });
    expect(
      await inspectCodebase(parent, 10_000, new AbortController().signal),
    ).toMatchObject({ availability: "NOT_REPOSITORY" });
  });

  test("propagates cancellation from Git inspection without a snapshot", async () => {
    const folder = await repository();
    const controller = new AbortController();
    controller.abort();

    const result = await inspectCodebaseFolder(
      { folder },
      10_000,
      controller.signal,
      async () => undefined,
    );

    expect(result).toMatchObject({ cancelled: true, timedOut: false });
    expect("snapshot" in result).toBe(false);
  });

  test("propagates Git inspection timeouts without a snapshot", async () => {
    const folder = await repository();

    const result = await inspectCodebaseFolder(
      { folder },
      0,
      new AbortController().signal,
      async () => undefined,
    );

    expect(result).toMatchObject({ cancelled: false, timedOut: true });
    expect("snapshot" in result).toBe(false);
  });
});
