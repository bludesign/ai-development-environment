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
import { executeWorktreePreparations } from "./worktree-preparations.js";

registerWorktreeFixtures();

describe("worktree pull, sync, and rebase", () => {
  test("fast-forwards the branch onto its upstream", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
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

  test("reports preparation conflicts without changes, then force rebases and reapplies", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "push", "-u", "origin", "main");
    const linked = `${folder}-prepared-rebase`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/prepared", linked);
    await writeFile(join(linked, "feature.txt"), "feature\n");
    await git(linked, "add", "feature.txt");
    await git(linked, "commit", "-m", "Add feature");
    const featureHead = (await git(linked, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(join(folder, "README.md"), "base change\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Change base readme");
    await git(folder, "push", "origin", "main");
    const baseHead = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const preparations = [
      {
        id: "prepared-readme",
        kind: "WRITE" as const,
        path: "README.md",
        contentBase64: Buffer.from("local configuration\n").toString("base64"),
        definitionHash: "prepared-readme-v1",
      },
    ];
    await executeWorktreePreparations(
      linked,
      preparations,
      "APPLY",
      10_000,
      new AbortController().signal,
    );
    const operation = {
      codebaseId: "codebase-1",
      folder: linked,
      gitDirectory,
      expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
      baseBranch: "main",
      operation: "REBASE" as const,
      preparations,
    };

    await expect(
      operateWorktree(
        operation,
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "PREPARATION_CONFLICT",
      preparationConflictPaths: ["README.md"],
    });
    expect((await git(linked, "rev-parse", "HEAD")).stdout.trim()).toBe(
      featureHead,
    );
    expect(await readFile(join(linked, "README.md"), "utf8")).toBe(
      "local configuration\n",
    );

    await expect(
      operateWorktree(
        { ...operation, forcePreparations: true },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "COMPLETED",
      preparations: [{ id: "prepared-readme", state: "APPLIED" }],
    });
    expect((await git(linked, "rev-parse", "HEAD~1")).stdout.trim()).toBe(
      baseHead,
    );
    expect(await readFile(join(linked, "README.md"), "utf8")).toBe(
      "local configuration\n",
    );
    expect((await git(linked, "status", "--porcelain")).stdout).toBe("");
  }, 20_000);

  test("reconciles delete and assume rules for paths newly added by the base", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "push", "-u", "origin", "main");
    const linked = `${folder}-base-added-preparations`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/prepared", linked);
    await writeFile(join(linked, "feature.txt"), "feature\n");
    await git(linked, "add", "feature.txt");
    await git(linked, "commit", "-m", "Add feature");
    await writeFile(join(folder, "delete-on-base.txt"), "delete me\n");
    await writeFile(join(folder, "assume-on-base.txt"), "keep me\n");
    await git(folder, "add", "delete-on-base.txt", "assume-on-base.txt");
    await git(folder, "commit", "-m", "Add prepared paths on base");
    await git(folder, "push", "origin", "main");
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const preparations = [
      {
        id: "delete-base-path",
        kind: "DELETE" as const,
        path: "delete-on-base.txt",
        contentBase64: null,
        definitionHash: "delete-base-path-v1",
      },
      {
        id: "assume-base-path",
        kind: "ASSUME_UNCHANGED" as const,
        path: "assume-on-base.txt",
        contentBase64: null,
        definitionHash: "assume-base-path-v1",
      },
    ];
    const operation = {
      codebaseId: "codebase-1",
      folder: linked,
      gitDirectory,
      expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
      baseBranch: "main",
      operation: "REBASE" as const,
      preparations,
    };

    await expect(
      operateWorktree(
        operation,
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "PREPARATION_CONFLICT",
      preparationConflictPaths: ["delete-on-base.txt", "assume-on-base.txt"],
    });

    await expect(
      operateWorktree(
        { ...operation, forcePreparations: true },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      outcome: "COMPLETED",
      preparations: [
        { id: "delete-base-path", state: "APPLIED" },
        { id: "assume-base-path", state: "APPLIED" },
      ],
    });
    await expect(
      readFile(join(linked, "delete-on-base.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await git(linked, "ls-files", "-v", "assume-on-base.txt")).stdout[0],
    ).toBe("h");
    expect((await git(linked, "status", "--porcelain")).stdout).toBe("");
  }, 20_000);

  test("retains a conflicted rebase until it is cancelled", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
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
    ).resolves.toMatchObject({
      outcome: "REBASE_CONFLICT",
      preparationConflictPaths: ["README.md"],
    });
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
