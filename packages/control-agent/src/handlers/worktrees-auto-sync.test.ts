import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

import {
  git,
  localRemote,
  repository,
  temporaryDirectories,
  useHostedRemote,
  registerWorktreeFixtures,
} from "./worktree-fixtures.js";
import { autoSyncWorktree } from "./worktrees.js";

registerWorktreeFixtures();

describe("worktree Auto Sync", () => {
  test("pauses Auto Sync for conflicts and finalizes after a workflow resolves them", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "config", "commit.gpgsign", "false");
    await git(folder, "push", "-u", "origin", "main");
    const linked = `${folder}-auto-sync`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/auto-sync", linked);
    await writeFile(join(linked, "README.md"), "feature change\n");
    await git(linked, "add", "README.md");
    await git(linked, "commit", "-m", "Change feature readme");
    await git(linked, "push", "-u", "origin", "feature/auto-sync");
    await writeFile(join(folder, "README.md"), "base change\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Change base readme");
    await git(folder, "push", "origin", "main");
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const payload = {
      codebaseId: "codebase-1",
      folder: linked,
      gitDirectory,
      expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
      expectedBranch: "feature/auto-sync",
      baseBranch: "main",
    };

    const conflicted = (await autoSyncWorktree(
      { ...payload, phase: "SYNC" },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as { outcome: string };
    expect(conflicted.outcome).toBe("CONFLICT");

    await writeFile(join(linked, "README.md"), "resolved change\n");
    const finalized = (await autoSyncWorktree(
      { ...payload, phase: "FINALIZE" },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as { outcome: string };

    expect(finalized.outcome).toBe("SYNCED");
    expect((await git(linked, "rev-parse", "HEAD")).stdout.trim()).toBe(
      (
        await git(remote, "rev-parse", "refs/heads/feature/auto-sync")
      ).stdout.trim(),
    );
  }, 15_000);

  test.each(["SYNC", "FINALIZE"] as const)(
    "rejects an Auto Sync %s job after the configured branch changes",
    async (phase) => {
      const folder = await repository();
      const gitDirectory = await realpath(
        (
          await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
        ).stdout.trim(),
      );

      await expect(
        autoSyncWorktree(
          {
            codebaseId: "codebase-1",
            folder,
            gitDirectory,
            expectedOrigin: "github.com/openai/codex",
            expectedBranch: "feature/configured",
            baseBranch: "main",
            phase,
          },
          10_000,
          new AbortController().signal,
          async () => undefined,
        ),
      ).rejects.toThrow("expected branch feature/configured");
    },
  );

  test("retries the push after a successful Auto Sync rebase", async () => {
    const folder = await repository();
    const remote = await localRemote();
    const remoteUrl = `ssh://git@example.test${remote}`;
    await useHostedRemote(folder, remote, remoteUrl);
    await git(folder, "config", "commit.gpgsign", "false");
    await git(folder, "push", "-u", "origin", "main");
    const linked = `${folder}-auto-sync-push-retry`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/push-retry", linked);
    await writeFile(join(linked, "feature.txt"), "feature\n");
    await git(linked, "add", "feature.txt");
    await git(linked, "commit", "-m", "Add feature");
    await git(linked, "push", "-u", "origin", "feature/push-retry");
    await writeFile(join(folder, "base.txt"), "base\n");
    await git(folder, "add", "base.txt");
    await git(folder, "commit", "-m", "Advance base");
    await git(folder, "push", "origin", "main");

    const rejectFirstPush = join(remote, "hooks", "pre-receive");
    await writeFile(
      rejectFirstPush,
      '#!/bin/sh\nmarker="$PWD/auto-sync-push-rejected"\nif [ ! -f "$marker" ]; then touch "$marker"; exit 1; fi\n',
    );
    await chmod(rejectFirstPush, 0o755);
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const payload = {
      codebaseId: "codebase-1",
      folder: linked,
      gitDirectory,
      expectedOrigin: normalizeGitOrigin(remoteUrl).canonicalOrigin,
      expectedBranch: "feature/push-retry",
      baseBranch: "main",
      phase: "SYNC" as const,
    };

    await expect(
      autoSyncWorktree(
        payload,
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow("pre-receive hook declined");

    const retried = (await autoSyncWorktree(
      payload,
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as { outcome: string };
    expect(retried.outcome).toBe("SYNCED");
    expect((await git(linked, "rev-parse", "HEAD")).stdout.trim()).toBe(
      (
        await git(remote, "rev-parse", "refs/heads/feature/push-retry")
      ).stdout.trim(),
    );
  }, 15_000);
});
