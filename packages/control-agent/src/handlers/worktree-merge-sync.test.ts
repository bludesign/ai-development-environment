import { chmod, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { autoSyncWorktree } from "./worktrees.js";
import {
  git,
  localRemote,
  repository,
  temporaryDirectories,
  useHostedRemote as configureHostedRemote,
  registerWorktreeFixtures,
} from "./worktree-fixtures.js";

registerWorktreeFixtures();

async function fixture(conflict = false) {
  const folder = await repository();
  const sourceRemote = await localRemote(),
    targetRemote = await localRemote();
  const sourceUrl = `ssh://git@example.test${sourceRemote}`,
    targetUrl = `ssh://git@example.test${targetRemote}`;
  await configureHostedRemote(folder, sourceRemote, sourceUrl);
  await git(folder, "push", "-u", "origin", "main");
  const originalBase = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  const linked = `${folder}-merge-sync`;
  temporaryDirectories.push(linked);
  await git(folder, "worktree", "add", "-b", "feature", linked);
  await writeFile(
    join(linked, conflict ? "README.md" : "feature.txt"),
    "feature change\n",
  );
  await git(linked, "add", "--all");
  await git(linked, "commit", "-m", "Add feature");
  await git(linked, "push", "-u", "origin", "feature");
  const expectedHeadSha = (
    await git(linked, "rev-parse", "HEAD")
  ).stdout.trim();
  await writeFile(
    join(folder, conflict ? "README.md" : "target.txt"),
    "target change\n",
  );
  await git(folder, "add", "--all");
  await git(folder, "commit", "-m", "Advance target");
  await git(folder, "push", targetUrl, "main:release");
  const targetSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  const payload = {
    codebaseId: "cb",
    folder: linked,
    gitDirectory: await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    ),
    expectedOrigin: normalizeGitOrigin(sourceUrl).canonicalOrigin,
    expectedBranch: "feature",
    baseBranch: "main",
    phase: "SYNC",
    mergeGuard: {
      expectedHeadSha,
      targetUrl,
      targetBranch: "release",
      targetSha,
    },
  };
  const run = () =>
    autoSyncWorktree(
      payload,
      10_000,
      new AbortController().signal,
      async () => undefined,
    ) as unknown as Promise<{
      outcome: string;
      previousHeadSha: string;
      syncedHeadSha: string;
      syncedTargetSha: string;
    }>;
  return {
    folder,
    linked,
    sourceRemote,
    expectedHeadSha,
    targetSha,
    originalBase,
    run,
  };
}

describe("reviewed Auto Merge sync", () => {
  test("rebases onto a fork target without changing configured remotes", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      outcome: "SYNCED",
      previousHeadSha: f.expectedHeadSha,
      syncedTargetSha: f.targetSha,
    });
    expect(result.syncedHeadSha).not.toBe(f.expectedHeadSha);
    expect(
      (
        await git(f.sourceRemote, "rev-parse", "refs/heads/feature")
      ).stdout.trim(),
    ).toBe(result.syncedHeadSha);
    expect(
      (await git(f.sourceRemote, "rev-parse", "refs/heads/main")).stdout.trim(),
    ).toBe(f.originalBase);
    expect((await git(f.linked, "remote")).stdout.trim()).toBe("origin");
    await expect(
      git(f.linked, "merge-base", "--is-ancestor", f.targetSha, "HEAD"),
    ).resolves.toBeDefined();
  });
  test("rejects local commits that were not reviewed", async () => {
    const f = await fixture();
    await writeFile(join(f.linked, "extra.txt"), "new work\n");
    await git(f.linked, "add", "extra.txt");
    await git(f.linked, "commit", "-m", "Unreviewed change");
    await expect(f.run()).rejects.toThrow("worktree source commit changed");
    expect(
      (
        await git(f.sourceRemote, "rev-parse", "refs/heads/feature")
      ).stdout.trim(),
    ).toBe(f.expectedHeadSha);
  });
  test("rejects remote commits that were not reviewed", async () => {
    const f = await fixture();
    await git(
      f.sourceRemote,
      "update-ref",
      "refs/heads/feature",
      f.originalBase,
    );
    await expect(f.run()).rejects.toThrow("remote source commit changed");
    expect((await git(f.linked, "rev-parse", "HEAD")).stdout.trim()).toBe(
      f.expectedHeadSha,
    );
  });
  test("the explicit lease rejects a source change between fetch and push", async () => {
    const f = await fixture();
    const hook = join(f.folder, ".git", "hooks", "pre-push");
    await writeFile(
      hook,
      `#!/bin/sh\ngit --git-dir='${f.sourceRemote}' update-ref refs/heads/feature '${f.originalBase}'\n`,
    );
    await chmod(hook, 0o755);
    await expect(f.run()).rejects.toThrow("Auto Merge push failed");
    expect(
      (
        await git(f.sourceRemote, "rev-parse", "refs/heads/feature")
      ).stdout.trim(),
    ).toBe(f.originalBase);
  });
  test("leaves conflicts for manual resolution without pushing", async () => {
    const f = await fixture(true);
    expect((await f.run()).outcome).toBe("CONFLICT");
    expect(
      (
        await git(f.sourceRemote, "rev-parse", "refs/heads/feature")
      ).stdout.trim(),
    ).toBe(f.expectedHeadSha);
    expect((await git(f.linked, "status", "--porcelain")).stdout).toContain(
      "UU README.md",
    );
  });
  test("refuses to sync a dirty worktree", async () => {
    const f = await fixture();
    await writeFile(join(f.linked, "untracked.txt"), "uncommitted\n");
    await expect(f.run()).rejects.toThrow("Stash or commit changes");
  });
});
