import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  closeAllWorktreeWatches,
  discoverWorktrees,
  inspectWorktreeDetail,
  operateWorktree,
  watchWorktree,
} from "./worktrees.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

async function git(folder: string, ...args: string[]) {
  return execute("git", ["-c", "commit.gpgsign=false", "-C", folder, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

async function repository() {
  const folder = await mkdtemp(join(tmpdir(), "worktree-agent-"));
  temporaryDirectories.push(folder);
  await git(folder, "init", "-b", "main");
  await git(folder, "config", "user.email", "test@example.com");
  await git(folder, "config", "user.name", "Test User");
  await writeFile(join(folder, "README.md"), "base\n");
  await git(folder, "add", "README.md");
  await git(folder, "commit", "-m", "Initial commit");
  await git(
    folder,
    "remote",
    "add",
    "origin",
    "git@github.com:OpenAI/Codex.git",
  );
  const head = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  await git(folder, "update-ref", "refs/remotes/origin/main", head);
  await git(
    folder,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  await git(folder, "branch", "--set-upstream-to=origin/main", "main");
  return folder;
}

afterEach(async () => {
  closeAllWorktreeWatches();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("worktree inventory and inspection", () => {
  test("discovers the primary checkout and linked worktrees", async () => {
    const folder = await repository();
    const linked = `${folder}-linked tree`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/AIDE-24", linked);
    await writeFile(join(linked, "feature.txt"), "one\ntwo\n");
    await git(linked, "add", "feature.txt");
    await git(linked, "commit", "-m", "Add feature");

    const inventory = await discoverWorktrees(
      folder,
      new Map(),
      null,
      10_000,
      new AbortController().signal,
    );

    expect(inventory).toMatchObject({
      complete: true,
      defaultBranch: "main",
      remoteBranches: ["main"],
    });
    expect(inventory.worktrees).toHaveLength(2);
    expect(inventory.worktrees[0]).toMatchObject({
      folder: await realpath(folder),
      relativePath: ".",
      primary: true,
      branch: "main",
      syncState: "IN_SYNC",
    });
    expect(inventory.worktrees[1]).toMatchObject({
      folder: await realpath(linked),
      primary: false,
      branch: "feature/AIDE-24",
      baseAhead: 1,
      baseBehind: 0,
    });
  });

  test("reports base-relative commits and staged, unstaged, and untracked files", async () => {
    const folder = await repository();
    await writeFile(join(folder, "committed.txt"), "committed\n");
    await git(folder, "add", "committed.txt");
    await git(folder, "commit", "-m", "Committed change");
    await writeFile(join(folder, "staged.txt"), "staged\n");
    await git(folder, "add", "staged.txt");
    await writeFile(join(folder, "README.md"), "base\nunstaged\n");
    await writeFile(join(folder, "untracked.txt"), "first\nsecond\n");

    const detail = await inspectWorktreeDetail(
      folder,
      "main",
      10_000,
      new AbortController().signal,
    );

    expect(detail.commits).toHaveLength(1);
    expect(detail.commits[0]).toMatchObject({
      subject: "Committed change",
      additions: 1,
    });
    expect(detail.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "staged.txt", staged: true }),
        expect.objectContaining({ path: "README.md", unstaged: true }),
        expect.objectContaining({
          path: "untracked.txt",
          untracked: true,
          unstagedAdditions: 2,
        }),
      ]),
    );
  });

  test("stages changes through the allow-listed operation handler", async () => {
    const folder = await repository();
    await writeFile(join(folder, "new.txt"), "new\n");
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );

    const result = await operateWorktree(
      {
        codebaseId: "codebase-1",
        folder,
        gitDirectory,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        operation: "STAGE_ALL",
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect(result.exitCode).toBe(0);
    expect((await git(folder, "status", "--porcelain")).stdout).toContain(
      "A  new.txt",
    );
  });

  test("debounces live worktree activity and stops watching on demand", async () => {
    const folder = await repository();
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const reportWorktreeActivity = vi.fn(async () => ({}));
    const payload = {
      codebaseId: "codebase-1",
      folder,
      gitDirectory,
      expectedOrigin: "github.com/openai/codex",
      baseBranch: "main",
      watchId: "watch-1",
    };

    await watchWorktree(
      { ...payload, action: "START" },
      10_000,
      new AbortController().signal,
      async () => undefined,
      { reportWorktreeActivity },
    );
    await writeFile(join(folder, "watched.txt"), "one\ntwo\n");

    await vi.waitFor(
      () =>
        expect(reportWorktreeActivity).toHaveBeenCalledWith(
          expect.objectContaining({ codebaseId: "codebase-1", gitDirectory }),
        ),
      { timeout: 3_000 },
    );

    await watchWorktree(
      { ...payload, action: "STOP" },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    reportWorktreeActivity.mockClear();
    await writeFile(join(folder, "watched.txt"), "stopped\n");
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(reportWorktreeActivity).not.toHaveBeenCalled();
  });

  test("blocks sync when the worktree is dirty", async () => {
    const folder = await repository();
    await git(folder, "checkout", "-b", "feature/dirty");
    await git(
      folder,
      "branch",
      "--set-upstream-to=origin/main",
      "feature/dirty",
    );
    await writeFile(join(folder, "README.md"), "dirty\n");
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );

    await expect(
      operateWorktree(
        {
          codebaseId: "codebase-1",
          folder,
          gitDirectory,
          expectedOrigin: "github.com/openai/codex",
          baseBranch: "main",
          operation: "SYNC",
        },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow("Stash or commit changes before syncing");
  });
});
