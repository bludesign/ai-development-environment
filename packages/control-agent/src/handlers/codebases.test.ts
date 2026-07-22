import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  deleteCodebaseRemoteBranch,
  inspectCodebaseGit,
  inspectCodebaseGitState,
  inspectCodebase,
  inspectCodebaseFolder,
  operateCodebaseGit,
  pullCodebaseBranch,
  updateBaseBranchAfterFetch,
} from "./codebases.js";

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

async function repositoryWithLocalOrigin() {
  const remote = await mkdtemp(join(tmpdir(), "codebase-agent-origin-"));
  temporaryDirectories.push(remote);
  await execute("git", ["init", "--bare", "--initial-branch=main", remote], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  const folder = await repository();
  const origin = "ssh://example.test/team/repo.git";
  await git(folder, "remote", "set-url", "origin", origin);
  await git(folder, "config", `url.${remote}.insteadOf`, origin);
  await git(folder, "push", "--set-upstream", "origin", "main");
  return { folder, remote };
}

async function advanceRemoteMain(folder: string) {
  const initialHead = (await git(folder, "rev-parse", "main")).stdout.trim();
  await git(folder, "checkout", "-b", "remote-change");
  await git(folder, "commit", "--allow-empty", "-m", "Remote change");
  const remoteHead = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  await git(folder, "checkout", "main");
  await git(folder, "update-ref", "refs/remotes/origin/main", remoteHead);
  return { initialHead, remoteHead };
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

  test("fast-forwards the checked-out base branch after a fetch", async () => {
    const folder = await repository();
    const { remoteHead } = await advanceRemoteMain(folder);

    await expect(
      updateBaseBranchAfterFetch(
        folder,
        "main",
        10_000,
        new AbortController().signal,
      ),
    ).resolves.toBe(true);

    expect((await git(folder, "rev-parse", "main")).stdout.trim()).toBe(
      remoteHead,
    );
  });

  test("updates an inactive base branch without switching branches", async () => {
    const folder = await repository();
    const { initialHead, remoteHead } = await advanceRemoteMain(folder);
    await git(folder, "checkout", "-b", "feature");

    await expect(
      updateBaseBranchAfterFetch(
        folder,
        "main",
        10_000,
        new AbortController().signal,
      ),
    ).resolves.toBe(true);

    expect((await git(folder, "branch", "--show-current")).stdout.trim()).toBe(
      "feature",
    );
    expect((await git(folder, "rev-parse", "HEAD")).stdout.trim()).toBe(
      initialHead,
    );
    expect((await git(folder, "rev-parse", "main")).stdout.trim()).toBe(
      remoteHead,
    );
  });

  test("does not update the base branch when changes are staged", async () => {
    const folder = await repository();
    const { initialHead } = await advanceRemoteMain(folder);
    await writeFile(join(folder, "staged.txt"), "staged\n");
    await git(folder, "add", "staged.txt");

    await expect(
      updateBaseBranchAfterFetch(
        folder,
        "main",
        10_000,
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
    expect((await git(folder, "rev-parse", "main")).stdout.trim()).toBe(
      initialHead,
    );
  });

  test("does not overwrite a divergent base branch", async () => {
    const folder = await repository();
    await advanceRemoteMain(folder);
    await git(folder, "commit", "--allow-empty", "-m", "Local change");
    const localHead = (await git(folder, "rev-parse", "HEAD")).stdout.trim();

    await expect(
      updateBaseBranchAfterFetch(
        folder,
        "main",
        10_000,
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
    expect((await git(folder, "rev-parse", "main")).stdout.trim()).toBe(
      localHead,
    );
  });

  test("lists, previews, applies, and deletes stashes by stable object ID", async () => {
    const folder = await repository();
    await writeFile(join(folder, "tracked.txt"), "before\n");
    await git(folder, "add", "tracked.txt");
    await git(folder, "commit", "-m", "Add tracked file");
    await writeFile(join(folder, "tracked.txt"), "after\n");
    await writeFile(join(folder, "untracked.txt"), "new\n");
    await git(
      folder,
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "Detail screen stash",
    );

    const state = await inspectCodebaseGitState(
      folder,
      10_000,
      new AbortController().signal,
    );
    expect(state.stashes).toHaveLength(1);
    expect(state.stashes[0]).toMatchObject({
      selector: "stash@{0}",
      message: "On main: Detail screen stash",
    });
    const oid = state.stashes[0]!.oid;
    const preview = await inspectCodebaseGit(
      {
        action: "STASH_DIFF",
        codebaseId: "codebase-1",
        folder,
        expectedOrigin: "github.com/openai/codex",
        stashOid: oid,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect(preview).toMatchObject({
      exitCode: 0,
      diff: { oid, truncated: false },
    });
    expect(
      String((preview as unknown as { diff: { patch: string } }).diff.patch),
    ).toContain("tracked.txt");

    await operateCodebaseGit(
      {
        codebaseId: "codebase-1",
        folder,
        expectedOrigin: "github.com/openai/codex",
        defaultBranch: "main",
        operation: "APPLY_STASH",
        stashOid: oid,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect((await git(folder, "stash", "list")).stdout).toContain(
      "Detail screen stash",
    );

    await operateCodebaseGit(
      {
        codebaseId: "codebase-1",
        folder,
        expectedOrigin: "github.com/openai/codex",
        defaultBranch: "main",
        operation: "DELETE_STASH",
        stashOid: oid,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect((await git(folder, "stash", "list")).stdout).toBe("");
  });

  test("auto-stashes dirty changes when switching and safely deletes branches", async () => {
    const folder = await repository();
    await writeFile(join(folder, "tracked.txt"), "before\n");
    await git(folder, "add", "tracked.txt");
    await git(folder, "commit", "-m", "Add tracked file");
    await git(folder, "branch", "feature/detail");
    await git(folder, "branch", "old-branch");
    await writeFile(join(folder, "tracked.txt"), "dirty\n");

    await operateCodebaseGit(
      {
        codebaseId: "codebase-1",
        folder,
        expectedOrigin: "github.com/openai/codex",
        defaultBranch: "main",
        operation: "SWITCH_BRANCH",
        branch: "feature/detail",
        stashChanges: true,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect((await git(folder, "branch", "--show-current")).stdout.trim()).toBe(
      "feature/detail",
    );
    expect((await git(folder, "stash", "list")).stdout).toContain(
      "Automatic stash before switching",
    );

    await operateCodebaseGit(
      {
        codebaseId: "codebase-1",
        folder,
        expectedOrigin: "github.com/openai/codex",
        defaultBranch: "main",
        operation: "DELETE_BRANCH",
        branch: "old-branch",
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );
    await expect(
      git(folder, "show-ref", "--verify", "refs/heads/old-branch"),
    ).rejects.toThrow();
    await expect(
      operateCodebaseGit(
        {
          codebaseId: "codebase-1",
          folder,
          expectedOrigin: "github.com/openai/codex",
          defaultBranch: "main",
          operation: "DELETE_BRANCH",
          branch: "main",
        },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow("default branch");
  });

  test("checks out origin-only branches as tracking local branches", async () => {
    const folder = await repository();
    const head = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "update-ref", "refs/remotes/origin/remote-only", head);

    await operateCodebaseGit(
      {
        codebaseId: "codebase-1",
        folder,
        expectedOrigin: "github.com/openai/codex",
        defaultBranch: "main",
        operation: "SWITCH_BRANCH",
        branch: "remote-only",
        stashChanges: false,
      },
      10_000,
      new AbortController().signal,
      async () => undefined,
    );

    expect((await git(folder, "branch", "--show-current")).stdout.trim()).toBe(
      "remote-only",
    );
    expect(
      (await git(folder, "rev-parse", "--abbrev-ref", "@{upstream}")).stdout,
    ).toContain("origin/remote-only");
  });

  test("reports each branch's tip commit", async () => {
    const folder = await repository();
    await git(folder, "checkout", "-b", "tip-branch");
    await git(folder, "commit", "--allow-empty", "-m", "Tip of the branch");
    await git(folder, "checkout", "main");

    const state = await inspectCodebaseGitState(
      folder,
      10_000,
      new AbortController().signal,
    );
    const branch = state.branches.find(
      (candidate) => candidate.name === "tip-branch",
    );
    expect(branch?.lastCommitMessage).toBe("Tip of the branch");
    expect(Number.isNaN(Date.parse(branch?.lastCommitAt ?? ""))).toBe(false);
  });

  test("blocks branches checked out in another worktree", async () => {
    const folder = await repository();
    await git(folder, "branch", "linked-branch");
    const linked = `${folder}-branch-linked`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", linked, "linked-branch");

    const state = await inspectCodebaseGitState(
      folder,
      10_000,
      new AbortController().signal,
    );
    expect(
      state.branches.find((branch) => branch.name === "linked-branch"),
    ).toMatchObject({ checkedOutPath: await realpath(linked), current: false });
    await expect(
      operateCodebaseGit(
        {
          codebaseId: "codebase-1",
          folder,
          expectedOrigin: "github.com/openai/codex",
          defaultBranch: "main",
          operation: "DELETE_BRANCH",
          branch: "linked-branch",
        },
        10_000,
        new AbortController().signal,
        async () => undefined,
      ),
    ).rejects.toThrow("another worktree");
  });

  test("pulls by fast-forward only and rejects divergence", async () => {
    const { folder } = await repositoryWithLocalOrigin();
    const initialHead = (await git(folder, "rev-parse", "main")).stdout.trim();
    await git(folder, "checkout", "-b", "remote-advance");
    await git(folder, "commit", "--allow-empty", "-m", "Remote advance");
    const remoteHead = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "push", "origin", "HEAD:main");
    await git(folder, "checkout", "main");
    expect((await git(folder, "rev-parse", "HEAD")).stdout.trim()).toBe(
      initialHead,
    );

    await pullCodebaseBranch(
      folder,
      "main",
      10_000,
      new AbortController().signal,
    );
    expect((await git(folder, "rev-parse", "main")).stdout.trim()).toBe(
      remoteHead,
    );

    await git(folder, "commit", "--allow-empty", "-m", "Local divergence");
    await git(folder, "checkout", "remote-advance");
    await git(folder, "commit", "--allow-empty", "-m", "More remote work");
    await git(folder, "push", "origin", "HEAD:main");
    await git(folder, "checkout", "main");
    await expect(
      pullCodebaseBranch(folder, "main", 10_000, new AbortController().signal),
    ).rejects.toThrow("cannot be fast-forwarded");
  });

  test("deletes remote branches while protecting main and the configured default", async () => {
    const { folder } = await repositoryWithLocalOrigin();
    await git(folder, "checkout", "-b", "feature/delete-remote");
    await git(
      folder,
      "push",
      "--set-upstream",
      "origin",
      "feature/delete-remote",
    );
    await git(folder, "checkout", "main");

    await deleteCodebaseRemoteBranch(
      folder,
      "feature/delete-remote",
      "main",
      10_000,
      new AbortController().signal,
    );

    await expect(
      git(
        folder,
        "ls-remote",
        "--exit-code",
        "--heads",
        "origin",
        "refs/heads/feature/delete-remote",
      ),
    ).rejects.toThrow();
    expect(
      (
        await git(
          folder,
          "show-ref",
          "--verify",
          "refs/heads/feature/delete-remote",
        )
      ).stdout,
    ).toBeTruthy();
    await expect(
      deleteCodebaseRemoteBranch(
        folder,
        "main",
        null,
        10_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow("origin/main cannot be deleted");
    await expect(
      deleteCodebaseRemoteBranch(
        folder,
        "release",
        "release",
        10_000,
        new AbortController().signal,
      ),
    ).rejects.toThrow("default remote branch");
  });
});
