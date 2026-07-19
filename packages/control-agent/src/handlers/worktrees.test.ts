import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import {
  branchWorktree,
  checkoutMovedWorktree,
  closeAllWorktreeWatches,
  deleteWorktree,
  discoverWorktrees,
  inspectWorktreeDetail,
  operateWorktree,
  pushMovedWorktree,
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

async function localRemote() {
  const folder = await mkdtemp(join(tmpdir(), "worktree-remote-"));
  temporaryDirectories.push(folder);
  await execute("git", ["init", "--bare", "-b", "main", folder], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return folder;
}

async function useHostedRemote(folder: string, remote: string, url: string) {
  const wrapperDirectory = await mkdtemp(join(tmpdir(), "worktree-ssh-"));
  temporaryDirectories.push(wrapperDirectory);
  const wrapper = join(wrapperDirectory, "ssh");
  await writeFile(
    wrapper,
    '#!/bin/sh\nfor argument do command="$argument"; done\nexec sh -c "$command"\n',
  );
  await chmod(wrapper, 0o755);
  await git(folder, "config", "core.sshCommand", wrapper);
  await git(folder, "remote", "set-url", "origin", url);
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
    const remote = await localRemote();
    await git(folder, "remote", "set-url", "origin", remote);
    await git(folder, "push", "-u", "origin", "main");
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
      localBranches: ["feature/AIDE-24", "main"],
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

  test("refreshes the remote default branch when origin HEAD changes", async () => {
    const folder = await repository();
    const remote = await localRemote();
    await git(folder, "remote", "set-url", "origin", remote);
    await git(folder, "push", "-u", "origin", "main");
    await git(folder, "checkout", "-b", "release");
    await git(folder, "push", "origin", "release");
    await git(folder, "checkout", "main");
    await git(remote, "symbolic-ref", "HEAD", "refs/heads/release");

    expect(
      (
        await git(folder, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
      ).stdout.trim(),
    ).toBe("origin/main");

    const inventory = await discoverWorktrees(
      folder,
      new Map(),
      "main",
      10_000,
      new AbortController().signal,
    );

    expect(inventory.defaultBranch).toBe("release");
  });

  test("creates a sibling worktree without tracking its base branch", async () => {
    const folder = await repository();
    const target = `${folder}-feature-APP-123`;
    temporaryDirectories.push(target);
    const result = (await branchWorktree(
      {
        codebaseId: "codebase-1",
        rootFolder: folder,
        folder: null,
        gitDirectory: null,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        action: "CREATE",
        mode: "NEW",
        candidates: ["feature/APP-123"],
        stashOnFailure: false,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as {
      branch: string;
      worktree: { folder: string; upstream: string | null };
    };

    expect(result.branch).toBe("feature/APP-123");
    expect(result.worktree.folder).toBe(await realpath(target));
    expect(result.worktree.upstream).toBeNull();
    expect((await git(target, "branch", "--show-current")).stdout.trim()).toBe(
      "feature/APP-123",
    );
  });

  test("stashes and retries a branch switch after Git rejects dirty changes", async () => {
    const folder = await repository();
    await git(folder, "switch", "-c", "release");
    await writeFile(join(folder, "README.md"), "release\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Release change");
    await git(folder, "switch", "main");
    await writeFile(join(folder, "README.md"), "dirty main\n");
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const payload = {
      codebaseId: "codebase-1",
      rootFolder: folder,
      folder,
      gitDirectory,
      expectedOrigin: "github.com/openai/codex",
      baseBranch: "main",
      action: "CHANGE",
      mode: "EXISTING",
      candidates: ["release"],
    };

    await expect(
      branchWorktree(
        { ...payload, stashOnFailure: false },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow();
    await branchWorktree(
      { ...payload, stashOnFailure: true },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect((await git(folder, "branch", "--show-current")).stdout.trim()).toBe(
      "release",
    );
    expect((await git(folder, "stash", "list")).stdout).toContain(
      "Automatic stash before switching to release",
    );
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
    expect(detail.branchChanges).toContainEqual(
      expect.objectContaining({
        path: "committed.txt",
        changeType: "A",
        additions: 1,
      }),
    );
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

  test("associates rename numstat counts with the destination path", async () => {
    const folder = await repository();
    await writeFile(join(folder, "rename-me.txt"), "one\ntwo\nthree\nfour\n");
    await git(folder, "add", "rename-me.txt");
    await git(folder, "commit", "-m", "Add rename source");
    await git(folder, "mv", "rename-me.txt", "renamed.txt");
    await writeFile(
      join(folder, "renamed.txt"),
      "one\ntwo\nthree\nfour\nfive\n",
    );
    await git(folder, "add", "renamed.txt");

    const detail = await inspectWorktreeDetail(
      folder,
      "main",
      10_000,
      new AbortController().signal,
    );

    expect(detail.changes).toContainEqual(
      expect.objectContaining({
        path: "renamed.txt",
        staged: true,
        stagedAdditions: 1,
        stagedDeletions: 0,
      }),
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

    const unstageResult = await operateWorktree(
      {
        codebaseId: "codebase-1",
        folder,
        gitDirectory,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        operation: "UNSTAGE_ALL",
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect(unstageResult.exitCode).toBe(0);
    expect((await git(folder, "status", "--porcelain")).stdout).toContain(
      "?? new.txt",
    );
  });

  test("debounces live worktree activity and stops watching on demand", async () => {
    const folder = await repository();
    const initialHead = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
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
          expect.objectContaining({
            codebaseId: "codebase-1",
            gitDirectory,
            headSha: initialHead,
            syncState: "IN_SYNC",
            baseAhead: 0,
            baseBehind: 0,
            hasStagedChanges: false,
            hasUnstagedChanges: true,
          }),
        ),
      { timeout: 3_000 },
    );

    reportWorktreeActivity.mockClear();
    await git(folder, "add", "watched.txt");
    await git(folder, "commit", "-m", "Add watched file");
    const committedHead = (
      await git(folder, "rev-parse", "HEAD")
    ).stdout.trim();
    await vi.waitFor(
      () =>
        expect(reportWorktreeActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: "main",
            headSha: committedHead,
            upstream: "origin/main",
            ahead: 1,
            behind: 0,
            syncState: "AHEAD",
            baseAhead: 1,
            baseBehind: 0,
            hasStagedChanges: false,
            hasUnstagedChanges: false,
          }),
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

  test("reports switching to a same-commit branch", async () => {
    const folder = await repository();
    const head = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
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
      watchId: "branch-watch",
    };
    await watchWorktree(
      { ...payload, action: "START" },
      10_000,
      new AbortController().signal,
      async () => undefined,
      { reportWorktreeActivity },
    );
    await vi.waitFor(() => expect(reportWorktreeActivity).toHaveBeenCalled());
    await git(folder, "branch", "alternate");
    await git(folder, "switch", "alternate");
    await vi.waitFor(
      () =>
        expect(reportWorktreeActivity).toHaveBeenCalledWith(
          expect.objectContaining({ branch: "alternate", headSha: head }),
        ),
      { timeout: 3_000 },
    );
    await watchWorktree(
      { ...payload, action: "STOP" },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
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

  test("pushes a clean branch, checks it out on another clone, and deletes the linked worktree", async () => {
    const source = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(source, remote, remoteUrl);
    await git(source, "push", "-u", "origin", "main");
    const linked = `${source}-feature-move`;
    temporaryDirectories.push(linked);
    await git(source, "worktree", "add", "-b", "feature/move", linked);
    await writeFile(join(linked, "move.txt"), "move\n");
    await git(linked, "add", "move.txt");
    await git(linked, "commit", "-m", "Move me");
    const linkedGitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const headSha = (await git(linked, "rev-parse", "HEAD")).stdout.trim();
    const expectedOrigin = normalizeGitOrigin(remoteUrl).canonicalOrigin;

    await pushMovedWorktree(
      {
        moveId: "move-1",
        codebaseId: "source-codebase",
        folder: linked,
        gitDirectory: linkedGitDirectory,
        expectedOrigin,
        branch: "feature/move",
        expectedHeadSha: headSha,
      },
      20_000,
      new AbortController().signal,
      async () => undefined,
    );

    const cloneParent = await mkdtemp(join(tmpdir(), "worktree-clone-parent-"));
    temporaryDirectories.push(cloneParent);
    const clone = join(cloneParent, "destination");
    await execute("git", ["clone", remote, clone], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    await git(clone, "config", "user.email", "test@example.com");
    await git(clone, "config", "user.name", "Test User");
    await useHostedRemote(clone, remote, remoteUrl);
    const destination = `${clone}-feature-move`;
    const checkout = (await checkoutMovedWorktree(
      {
        moveId: "move-1",
        codebaseId: "target-codebase",
        rootFolder: clone,
        folder: null,
        gitDirectory: null,
        expectedOrigin,
        branch: "feature/move",
        expectedHeadSha: headSha,
        baseBranch: "main",
        mode: "NEW",
        stashOnFailure: false,
      },
      20_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as {
      outcome: string;
      worktree: { folder: string; gitDirectory: string };
    };
    expect(checkout.outcome).toBe("CHECKED_OUT");
    expect(checkout.worktree.folder).toBe(await realpath(destination));
    expect((await git(destination, "rev-parse", "HEAD")).stdout.trim()).toBe(
      headSha,
    );
    await writeFile(join(destination, "dirty.txt"), "dirty\n");

    await deleteWorktree(
      {
        moveId: null,
        codebaseId: "target-codebase",
        rootFolder: clone,
        folder: destination,
        gitDirectory: checkout.worktree.gitDirectory,
        expectedOrigin,
        branch: "feature/move",
        defaultBranch: "main",
        deleteRemoteBranch: false,
        requireClean: false,
        expectedHeadSha: null,
      },
      20_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect((await git(clone, "branch", "--list", "feature/move")).stdout).toBe(
      "",
    );
    expect((await git(clone, "worktree", "list")).stdout).not.toContain(
      destination,
    );
  });

  test("pauses a dirty destination switch and leaves a recovery stash after retry", async () => {
    const source = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(source, remote, remoteUrl);
    await git(source, "push", "-u", "origin", "main");
    await git(source, "switch", "-c", "feature/conflict");
    await writeFile(join(source, "README.md"), "incoming\n");
    await git(source, "add", "README.md");
    await git(source, "commit", "-m", "Incoming change");
    await git(source, "push", "-u", "origin", "feature/conflict");
    const headSha = (await git(source, "rev-parse", "HEAD")).stdout.trim();
    const expectedOrigin = normalizeGitOrigin(remoteUrl).canonicalOrigin;
    const cloneParent = await mkdtemp(join(tmpdir(), "worktree-dirty-target-"));
    temporaryDirectories.push(cloneParent);
    const clone = join(cloneParent, "destination");
    await execute("git", ["clone", remote, clone], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    await git(clone, "config", "user.email", "test@example.com");
    await git(clone, "config", "user.name", "Test User");
    await useHostedRemote(clone, remote, remoteUrl);
    await writeFile(join(clone, "README.md"), "destination changes\n");
    const gitDirectory = await realpath(
      (
        await git(clone, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const payload = {
      moveId: "move-dirty",
      codebaseId: "target-codebase",
      rootFolder: clone,
      folder: clone,
      gitDirectory,
      expectedOrigin,
      branch: "feature/conflict",
      expectedHeadSha: headSha,
      baseBranch: "main",
      mode: "EXISTING" as const,
    };
    const paused = (await checkoutMovedWorktree(
      { ...payload, stashOnFailure: false },
      20_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as { outcome: string };
    expect(paused.outcome).toBe("NEEDS_STASH");
    await checkoutMovedWorktree(
      { ...payload, stashOnFailure: true },
      20_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect((await git(clone, "branch", "--show-current")).stdout.trim()).toBe(
      "feature/conflict",
    );
    expect((await git(clone, "stash", "list")).stdout).toContain(
      "Automatic stash before moving to feature/conflict",
    );
  });

  test("rejects dirty source moves and preserves a worktree when remote deletion is rejected", async () => {
    const source = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(source, remote, remoteUrl);
    await git(source, "push", "-u", "origin", "main");
    const linked = `${source}-delete-protected`;
    temporaryDirectories.push(linked);
    await git(source, "worktree", "add", "-b", "feature/protected", linked);
    await git(linked, "push", "-u", "origin", "feature/protected");
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const headSha = (await git(linked, "rev-parse", "HEAD")).stdout.trim();
    const expectedOrigin = normalizeGitOrigin(remoteUrl).canonicalOrigin;
    await writeFile(join(linked, "dirty.txt"), "dirty\n");
    await expect(
      pushMovedWorktree(
        {
          moveId: "move-dirty-source",
          codebaseId: "source-codebase",
          folder: linked,
          gitDirectory,
          expectedOrigin,
          branch: "feature/protected",
          expectedHeadSha: headSha,
        },
        20_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow("Commit or discard source changes");
    await git(remote, "config", "receive.denyDeletes", "true");
    await expect(
      deleteWorktree(
        {
          moveId: null,
          codebaseId: "source-codebase",
          rootFolder: source,
          folder: linked,
          gitDirectory,
          expectedOrigin,
          branch: "feature/protected",
          defaultBranch: "main",
          deleteRemoteBranch: true,
          requireClean: false,
          expectedHeadSha: null,
        },
        20_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect((await git(linked, "rev-parse", "HEAD")).stdout.trim()).toBe(
      headSha,
    );
  });
});
