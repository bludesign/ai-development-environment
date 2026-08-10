import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  git,
  localRemote,
  repository,
  temporaryDirectories,
  registerWorktreeFixtures,
} from "./worktree-fixtures.js";
import {
  branchWorktree,
  commitWorktree,
  discoverWorktrees,
  inspectWorktreeDetail,
  inspectWorktreeDiff,
  operateWorktree,
} from "./worktrees.js";
import { executeWorktreePreparations } from "./worktree-preparations.js";

registerWorktreeFixtures();

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

  test("suspends and reapplies tracked preparations around a branch change", async () => {
    const folder = await repository();
    await git(folder, "switch", "-c", "release");
    await writeFile(join(folder, "README.md"), "release contents\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Change release readme");
    await git(folder, "switch", "main");
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
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
      folder,
      preparations,
      "APPLY",
      10_000,
      new AbortController().signal,
    );

    await expect(
      branchWorktree(
        {
          codebaseId: "codebase-1",
          rootFolder: folder,
          folder,
          gitDirectory,
          expectedOrigin: "github.com/openai/codex",
          baseBranch: "main",
          action: "CHANGE",
          mode: "EXISTING",
          candidates: ["release"],
          stashOnFailure: false,
          preparations,
        },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).resolves.toMatchObject({
      branch: "release",
      preparations: [{ id: "prepared-readme", state: "APPLIED" }],
    });
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe(
      "local configuration\n",
    );
    expect((await git(folder, "ls-files", "-v", "README.md")).stdout[0]).toBe(
      "h",
    );
    expect((await git(folder, "status", "--porcelain")).stdout).toBe("");
  });

  test("makes assume-unchanged edits visible to branch-change stashing", async () => {
    const folder = await repository();
    await git(folder, "switch", "-c", "release");
    await writeFile(join(folder, "README.md"), "release contents\n");
    await git(folder, "add", "README.md");
    await git(folder, "commit", "-m", "Change release readme");
    await git(folder, "switch", "main");
    await writeFile(join(folder, "README.md"), "private main contents\n");
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    const preparations = [
      {
        id: "assume-readme",
        kind: "ASSUME_UNCHANGED" as const,
        path: "README.md",
        contentBase64: null,
        definitionHash: "assume-readme-v1",
      },
    ];
    await executeWorktreePreparations(
      folder,
      preparations,
      "APPLY",
      10_000,
      new AbortController().signal,
    );
    const payload = {
      codebaseId: "codebase-1",
      rootFolder: folder,
      folder,
      gitDirectory,
      expectedOrigin: "github.com/openai/codex",
      baseBranch: "main",
      action: "CHANGE" as const,
      mode: "EXISTING" as const,
      candidates: ["release"],
      preparations,
    };

    await expect(
      branchWorktree(
        { ...payload, stashOnFailure: false },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe(
      "private main contents\n",
    );
    expect((await git(folder, "ls-files", "-v", "README.md")).stdout[0]).toBe(
      "h",
    );

    await branchWorktree(
      { ...payload, stashOnFailure: true },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect((await git(folder, "branch", "--show-current")).stdout.trim()).toBe(
      "release",
    );
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe(
      "release contents\n",
    );
    expect((await git(folder, "stash", "list")).stdout).toContain(
      "Automatic stash before switching to release",
    );
    expect((await git(folder, "ls-files", "-v", "README.md")).stdout[0]).toBe(
      "h",
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

  test("preserves staged rename paths for text and before-side comparisons", async () => {
    const folder = await repository();
    await writeFile(join(folder, "before.png"), "image contents");
    await git(folder, "add", "before.png");
    await git(folder, "commit", "-m", "Add image");
    await git(folder, "mv", "before.png", "after.png");
    await git(folder, "add", "after.png");
    const gitDirectory = await realpath(join(folder, ".git"));

    const result = (await inspectWorktreeDiff(
      {
        codebaseId: "codebase-1",
        folder,
        gitDirectory,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        scope: "STAGED",
        path: "after.png",
        previousPath: "before.png",
        commitSha: null,
        uploadId: null,
        side: null,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as {
      diff: {
        patch: string;
        beforeAvailable: boolean;
        afterAvailable: boolean;
      };
    };

    expect(result.diff.patch).toContain("rename from before.png");
    expect(result.diff.patch).toContain("rename to after.png");
    expect(result.diff).toMatchObject({
      beforeAvailable: true,
      afterAvailable: true,
    });
  });

  test("does not read oversized untracked files into the diff", async () => {
    const folder = await repository();
    await writeFile(
      join(folder, "large.bin"),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    const gitDirectory = await realpath(join(folder, ".git"));

    const result = (await inspectWorktreeDiff(
      {
        codebaseId: "codebase-1",
        folder,
        gitDirectory,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        scope: "UNTRACKED",
        path: "large.bin",
        previousPath: null,
        commitSha: null,
        uploadId: null,
        side: null,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as { diff: { patch: string; truncated: boolean } };

    expect(result.diff).toMatchObject({ patch: "", truncated: true });
  });

  test("returns a renderable hunk for an untracked text file", async () => {
    const folder = await repository();
    await writeFile(join(folder, "notes.txt"), "first\nsecond\n");
    const gitDirectory = await realpath(join(folder, ".git"));

    const result = (await inspectWorktreeDiff(
      {
        codebaseId: "codebase-1",
        folder,
        gitDirectory,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        scope: "UNTRACKED",
        path: "notes.txt",
        previousPath: null,
        commitSha: null,
        uploadId: null,
        side: null,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as unknown as { diff: { patch: string; truncated: boolean } };

    expect(result.diff.truncated).toBe(false);
    expect(result.diff.patch).toContain("@@ -0,0 +1,2 @@");
    expect(result.diff.patch).toContain("+first\n+second");
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

  test("commits exactly the selected paths while preserving other changes", async () => {
    const folder = await repository();
    await writeFile(join(folder, "README.md"), "selected\n");
    await writeFile(join(folder, "other.txt"), "not selected\n");
    await git(folder, "add", "other.txt");
    const gitDirectory = await realpath(
      (
        await git(folder, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );

    const result = (await commitWorktree(
      {
        codebaseId: "codebase-1",
        folder,
        gitDirectory,
        expectedOrigin: "github.com/openai/codex",
        baseBranch: "main",
        message: "Commit selected file",
        signed: false,
        stageAll: false,
        paths: ["README.md"],
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    )) as Awaited<ReturnType<typeof commitWorktree>> & {
      commit: { sha: string; subject: string; signed: boolean };
    };

    expect(result.exitCode).toBe(0);
    expect(result.commit).toMatchObject({
      subject: "Commit selected file",
      signed: false,
    });
    expect(
      (
        await git(folder, "show", "--format=", "--name-only", "HEAD")
      ).stdout.trim(),
    ).toBe("README.md");
    expect((await git(folder, "status", "--porcelain")).stdout).toContain(
      "?? other.txt",
    );
  });
});
