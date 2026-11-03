import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { parseWorktreeRefreshState } from "@ai-development-environment/agent-contract/worktrees";

import {
  git,
  registerWorktreeFixtures,
  repository,
  temporaryDirectories,
} from "./worktree-fixtures.js";
import { inspectWorktreeGit } from "./worktrees.js";

registerWorktreeFixtures();

const clean = {
  dirty: false,
  hasConflicts: false,
  rebaseInProgress: false,
  mergeInProgress: false,
};

async function linkedWorktree() {
  const folder = await repository();
  const linked = `${folder}-refresh tree`;
  temporaryDirectories.push(linked);
  await git(folder, "worktree", "add", "-b", "feature/refresh", linked);
  const gitDirectory = await realpath(
    (
      await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
    ).stdout.trim(),
  );
  const payload = {
    action: "REFRESH",
    codebaseId: "codebase-1",
    folder: linked,
    gitDirectory,
    expectedOrigin: "github.com/openai/codex",
  };
  return {
    folder,
    linked,
    gitDirectory,
    refresh: async () => {
      const result = await inspectWorktreeGit(
        payload,
        10_000,
        new AbortController().signal,
        async () => undefined,
      );
      expect(result.exitCode).toBe(0);
      if (!("state" in result)) throw new Error("Missing refresh state");
      return parseWorktreeRefreshState(result.state);
    },
  };
}

describe("targeted worktree Git refresh", () => {
  test("reads untracked, staged, and unstaged changes from a linked worktree", async () => {
    const { linked, refresh } = await linkedWorktree();
    expect(await refresh()).toEqual(clean);

    await writeFile(join(linked, "untracked.txt"), "new\n");
    expect(await refresh()).toEqual({ ...clean, dirty: true });

    await git(linked, "add", "untracked.txt");
    expect(await refresh()).toEqual({ ...clean, dirty: true });

    await git(linked, "commit", "-m", "Add file");
    expect(await refresh()).toEqual(clean);

    await writeFile(join(linked, "README.md"), "edited\n");
    expect(await refresh()).toEqual({ ...clean, dirty: true });
  });

  test("distinguishes resolved index conflicts from a finished merge", async () => {
    const { folder, linked, refresh } = await linkedWorktree();
    await writeFile(join(folder, "README.md"), "main\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Change main");
    await writeFile(join(linked, "README.md"), "feature\n");
    await git(linked, "add", "README.md");
    await git(linked, "commit", "-m", "Change feature");
    await expect(git(linked, "merge", "main")).rejects.toThrow();

    expect(await refresh()).toEqual({
      ...clean,
      dirty: true,
      hasConflicts: true,
      mergeInProgress: true,
    });

    await writeFile(join(linked, "README.md"), "resolved\n");
    await git(linked, "add", "README.md");
    expect(await refresh()).toEqual({
      ...clean,
      dirty: true,
      mergeInProgress: true,
    });

    await git(linked, "commit", "-m", "Resolve merge");
    expect(await refresh()).toEqual(clean);
  });

  test("detects an unfinished rebase even with a clean working tree", async () => {
    const { folder, linked, refresh } = await linkedWorktree();
    await writeFile(join(folder, "base.txt"), "main\n");
    await git(folder, "add", "base.txt");
    await git(folder, "commit", "-m", "Advance main");
    await writeFile(join(linked, "feature.txt"), "feature\n");
    await git(linked, "add", "feature.txt");
    await git(linked, "commit", "-m", "Add feature");
    await expect(
      git(linked, "rebase", "main", "--exec", "false"),
    ).rejects.toThrow();

    expect(await refresh()).toEqual({ ...clean, rebaseInProgress: true });

    await git(linked, "rebase", "--continue");
    expect(await refresh()).toEqual(clean);
  });

  test("fails when Git cannot read the index instead of reporting a clean tree", async () => {
    const { gitDirectory, refresh } = await linkedWorktree();
    await writeFile(join(gitDirectory, "index"), "invalid index");

    await expect(refresh()).rejects.toThrow(/index/i);
  });
});
