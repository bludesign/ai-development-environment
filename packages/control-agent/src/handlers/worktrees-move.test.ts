import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import {
  cloneRepository,
  git,
  localRemote,
  repository,
  temporaryDirectories,
  useHostedRemote,
  registerWorktreeFixtures,
} from "./worktree-fixtures.js";
import {
  checkoutMovedWorktree,
  deleteWorktree,
  pushMovedWorktree,
} from "./worktrees.js";

registerWorktreeFixtures();

describe("worktree moves between codebases", () => {
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
    await cloneRepository(remote, clone);
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
    await cloneRepository(remote, clone);
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
