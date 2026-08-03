import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import {
  git,
  localRemote,
  repository,
  temporaryDirectories,
  useHostedRemote,
  registerWorktreeFixtures,
} from "./worktree-fixtures.js";
import {
  discoverWorktrees,
  operateWorktree,
  watchWorktree,
} from "./worktrees.js";

registerWorktreeFixtures();

describe("worktree pull, sync, and rebase", () => {
  test("fast-forwards the branch onto its upstream", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "config", "commit.gpgsign", "false");
    await git(folder, "push", "-u", "origin", "main");
    await writeFile(join(folder, "base.txt"), "base\n");
    await git(folder, "add", "base.txt");
    await git(folder, "commit", "-m", "Advance base");
    const advanced = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "push", "origin", "main");
    // Rewind the checkout so it is behind the upstream it just published.
    await git(folder, "reset", "--hard", "HEAD~1");
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
        expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
        baseBranch: "main",
        operation: "PULL",
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect(result.exitCode).toBe(0);
    expect((await git(folder, "rev-parse", "HEAD")).stdout.trim()).toBe(
      advanced,
    );
  }, 15_000);

  test("refuses to pull a branch that has diverged from its upstream", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "config", "commit.gpgsign", "false");
    await git(folder, "push", "-u", "origin", "main");
    await writeFile(join(folder, "remote.txt"), "remote\n");
    await git(folder, "add", "remote.txt");
    await git(folder, "commit", "-m", "Advance remote");
    await git(folder, "push", "origin", "main");
    await git(folder, "reset", "--hard", "HEAD~1");
    await writeFile(join(folder, "local.txt"), "local\n");
    await git(folder, "add", "local.txt");
    await git(folder, "commit", "-m", "Advance local");
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
          expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
          baseBranch: "main",
          operation: "PULL",
        },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
      // Git's own explanation, which names the divergence, survives to the UI.
    ).rejects.toThrow(/fast-forward/);
  }, 15_000);

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

  test("rebases onto the base branch without pushing", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    // The handler runs Git with the developer's own global config, so the
    // rebase it performs would otherwise block on commit signing.
    await git(folder, "config", "commit.gpgsign", "false");
    await git(folder, "push", "-u", "origin", "main");
    const linked = `${folder}-rebase`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/rebase", linked);
    await writeFile(join(linked, "feature.txt"), "feature\n");
    await git(linked, "add", "feature.txt");
    await git(linked, "commit", "-m", "Add feature");
    await writeFile(join(folder, "base.txt"), "base\n");
    await git(folder, "add", "base.txt");
    await git(folder, "commit", "-m", "Advance base");
    await git(folder, "push", "origin", "main");
    const baseHead = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );

    await operateWorktree(
      {
        codebaseId: "codebase-1",
        folder: linked,
        gitDirectory,
        expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
        baseBranch: "main",
        operation: "REBASE",
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect((await git(linked, "rev-parse", "HEAD~1")).stdout.trim()).toBe(
      baseHead,
    );
    expect(
      (await git(remote, "branch", "--list", "feature/rebase")).stdout.trim(),
    ).toBe("");
  }, 15_000);
  test("retains a conflicted rebase until it is cancelled", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "config", "commit.gpgsign", "false");
    await git(folder, "push", "-u", "origin", "main");
    const linked = `${folder}-conflicted-rebase`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/conflict", linked);
    const linkedRealPath = await realpath(linked);
    await writeFile(join(linked, "README.md"), "feature change\n");
    await git(linked, "add", "README.md");
    await git(linked, "commit", "-m", "Change feature readme");
    await writeFile(join(folder, "README.md"), "base change\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Change base readme");
    await git(folder, "push", "origin", "main");
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const operation = {
      codebaseId: "codebase-1",
      folder: linked,
      gitDirectory,
      expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
      baseBranch: "main",
    };
    const reportWorktreeActivity = vi.fn(async () => ({}));
    await watchWorktree(
      { ...operation, action: "START", watchId: "conflicted-rebase-watch" },
      10_000,
      new AbortController().signal,
      async () => undefined,
      { agentId: "agent-1", reportWorktreeActivity },
    );
    await vi.waitFor(() => expect(reportWorktreeActivity).toHaveBeenCalled(), {
      timeout: 3_000,
    });
    reportWorktreeActivity.mockClear();

    await expect(
      operateWorktree(
        { ...operation, operation: "REBASE" },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow();
    await vi.waitFor(
      () =>
        expect(reportWorktreeActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "feature/conflict",
            rebaseInProgress: true,
            hasConflicts: true,
          }),
        ),
      { timeout: 3_000 },
    );

    const paused = await discoverWorktrees(
      folder,
      new Map(),
      "main",
      10_000,
      new AbortController().signal,
    );
    expect(
      paused.worktrees.find((worktree) => worktree.folder === linkedRealPath),
    ).toMatchObject({
      branch: "feature/conflict",
      rebaseInProgress: true,
      hasConflicts: true,
    });

    await operateWorktree(
      { ...operation, operation: "CANCEL_REBASE" },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    const restored = await discoverWorktrees(
      folder,
      new Map(),
      "main",
      10_000,
      new AbortController().signal,
    );
    expect(
      restored.worktrees.find((worktree) => worktree.folder === linkedRealPath),
    ).toMatchObject({ rebaseInProgress: false, hasConflicts: false });
    expect(await readFile(join(linked, "README.md"), "utf8")).toBe(
      "feature change\n",
    );
  }, 15_000);
  test("blocks rebase when the worktree is dirty", async () => {
    const folder = await repository();
    await git(folder, "checkout", "-b", "feature/dirty-rebase");
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
          operation: "REBASE",
        },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow("Stash or commit changes before rebasing");
  });
});
