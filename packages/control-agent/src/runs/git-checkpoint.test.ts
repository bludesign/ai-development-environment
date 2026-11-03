import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import {
  captureGitCheckpoint,
  compareGitCheckpoint,
  restoreGitCheckpoint,
} from "./git-checkpoint.js";

const execute = promisify(execFile);
const directories: string[] = [];

async function git(cwd: string, ...args: string[]) {
  return (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "aide-run-checkpoint-test-"));
  directories.push(cwd);
  await git(cwd, "init", "--initial-branch=main");
  await git(cwd, "config", "user.name", "Checkpoint Test");
  await git(cwd, "config", "user.email", "checkpoint@example.com");
  await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
  await writeFile(join(cwd, "staged.txt"), "base staged\n");
  await writeFile(join(cwd, "unstaged.txt"), "base unstaged\n");
  await writeFile(join(cwd, "deleted.txt"), "delete me\n");
  await writeFile(join(cwd, "renamed.txt"), "rename me\n");
  await symlink("staged.txt", join(cwd, "link"));
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-m", "base");
  return cwd;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Git run checkpoints", () => {
  test("reports two staged files once in net changes and preserves index rollback details", async () => {
    const cwd = await repository();
    const baseline = await captureGitCheckpoint(cwd, "staged-run", "START");
    await writeFile(join(cwd, "staged.txt"), "changed staged\n");
    await writeFile(join(cwd, "unstaged.txt"), "also staged\n");
    await git(cwd, "add", "staged.txt", "unstaged.txt");
    const final = await captureGitCheckpoint(cwd, "staged-run", "FINAL");

    const comparison = await compareGitCheckpoint(cwd, baseline, final);

    expect(comparison.worktreePatch.match(/^diff --git /gm)).toHaveLength(2);
    expect(comparison.worktreePatch).toContain("+changed staged");
    expect(comparison.worktreePatch).toContain("+also staged");
    expect(comparison.worktreeSummary).toContain("2 files changed");
    expect(comparison.rollbackPatch).toContain(
      "Worktree changes that will be undone:",
    );
    expect(comparison.rollbackPatch).toContain(
      "Index changes that will be undone:",
    );
    expect(comparison.rollbackPatch.match(/^diff --git /gm)).toHaveLength(4);
  });

  test("shows full final content once for a partially staged file", async () => {
    const cwd = await repository();
    const baseline = await captureGitCheckpoint(cwd, "partial-run", "START");
    await writeFile(join(cwd, "staged.txt"), "index content\n");
    await git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "staged.txt"), "final worktree content\n");
    const final = await captureGitCheckpoint(cwd, "partial-run", "FINAL");

    const comparison = await compareGitCheckpoint(cwd, baseline, final);

    expect(comparison.worktreePatch.match(/^diff --git /gm)).toHaveLength(1);
    expect(comparison.worktreePatch).toContain("+final worktree content");
    expect(comparison.worktreePatch).not.toContain("+index content");
    expect(comparison.rollbackPatch).toContain("+index content");
    expect(comparison.worktreeSummary).toContain("1 file changed");
  });

  test("does not count staging pre-existing edits as session content changes", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "staged.txt"), "pre-existing content\n");
    const baseline = await captureGitCheckpoint(cwd, "index-only-run", "START");
    await git(cwd, "add", "staged.txt");
    const final = await captureGitCheckpoint(cwd, "index-only-run", "FINAL");

    const comparison = await compareGitCheckpoint(cwd, baseline, final);

    expect(comparison.worktreePatch).toBe("");
    expect(comparison.worktreeSummary).toBe("");
    expect(comparison.rollbackPatch).not.toContain(
      "Worktree changes that will be undone:",
    );
    expect(comparison.rollbackPatch).toContain(
      "Index changes that will be undone:",
    );
    expect(comparison.rollbackPatch).toContain("+pre-existing content");
  });

  test("compares to the run baseline when pre-existing changes are reverted", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "staged.txt"), "pre-existing content\n");
    const baseline = await captureGitCheckpoint(cwd, "reverted-run", "START");
    await git(cwd, "restore", "staged.txt");
    const final = await captureGitCheckpoint(cwd, "reverted-run", "FINAL");

    const comparison = await compareGitCheckpoint(cwd, baseline, final);

    expect(final.diffPatch).toBeNull();
    expect(final.diffSummary).toBeNull();
    expect(comparison.worktreePatch).toContain("-pre-existing content");
    expect(comparison.worktreePatch).toContain("+base staged");
    expect(comparison.worktreeSummary).toContain("1 file changed");
  });

  test("restores HEAD, index, tracked files, symlinks, and non-ignored untracked files", async () => {
    const cwd = await repository();
    const baseHead = await git(cwd, "rev-parse", "HEAD");
    await writeFile(join(cwd, "staged.txt"), "question staged\n");
    await git(cwd, "add", "staged.txt");
    await writeFile(join(cwd, "unstaged.txt"), "question unstaged\n");
    await unlink(join(cwd, "deleted.txt"));
    await rename(join(cwd, "renamed.txt"), join(cwd, "moved.txt"));
    await unlink(join(cwd, "link"));
    await symlink("unstaged.txt", join(cwd, "link"));
    await writeFile(join(cwd, "untracked.txt"), "question untracked\n");
    await writeFile(join(cwd, "ignored.txt"), "question ignored\n");
    const checkpoint = await captureGitCheckpoint(cwd, "run-1", "QUESTION");

    await git(cwd, "add", "-A");
    await git(cwd, "commit", "-m", "later commit");
    await writeFile(join(cwd, "staged.txt"), "later content\n");
    await writeFile(join(cwd, "later-untracked.txt"), "remove me\n");
    await writeFile(join(cwd, "ignored.txt"), "later ignored\n");
    const current = await captureGitCheckpoint(cwd, "run-1", "CURRENT");
    const preview = await compareGitCheckpoint(cwd, checkpoint, current);
    expect(preview.rollbackPatch).toContain("later content");

    await expect(
      restoreGitCheckpoint(cwd, checkpoint, {
        stash: false,
        message: "unused",
      }),
    ).resolves.toBeNull();

    expect(await git(cwd, "rev-parse", "HEAD")).toBe(baseHead);
    expect(await git(cwd, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await readFile(join(cwd, "staged.txt"), "utf8")).toBe(
      "question staged\n",
    );
    expect(await readFile(join(cwd, "unstaged.txt"), "utf8")).toBe(
      "question unstaged\n",
    );
    await expect(lstat(join(cwd, "deleted.txt"))).rejects.toThrow();
    await expect(lstat(join(cwd, "renamed.txt"))).rejects.toThrow();
    expect(await readFile(join(cwd, "moved.txt"), "utf8")).toBe("rename me\n");
    expect(await readlink(join(cwd, "link"))).toBe("unstaged.txt");
    expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe(
      "question untracked\n",
    );
    await expect(lstat(join(cwd, "later-untracked.txt"))).rejects.toThrow();
    expect(await readFile(join(cwd, "ignored.txt"), "utf8")).toBe(
      "later ignored\n",
    );
    expect(await git(cwd, "diff", "--cached", "--name-only")).toBe(
      "staged.txt",
    );
  });

  test("optionally stashes the state being rolled back", async () => {
    const cwd = await repository();
    const checkpoint = await captureGitCheckpoint(cwd, "run-2", "QUESTION");
    await writeFile(join(cwd, "unstaged.txt"), "later tracked\n");
    await writeFile(join(cwd, "later.txt"), "later untracked\n");

    const stashRef = await restoreGitCheckpoint(cwd, checkpoint, {
      stash: true,
      message: "before answer revision",
    });

    expect(stashRef).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(cwd, "stash", "list", "--format=%s")).toContain(
      "before answer revision",
    );
    expect(await readFile(join(cwd, "unstaged.txt"), "utf8")).toBe(
      "base unstaged\n",
    );
    await expect(lstat(join(cwd, "later.txt"))).rejects.toThrow();
  });

  test("truncates a worktree diff that is larger than the control plane limit", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "huge.txt"), "committed line\n".repeat(3e5));
    await git(cwd, "add", "huge.txt");
    await git(cwd, "commit", "-m", "huge base");
    await writeFile(
      join(cwd, "huge.txt"),
      "large worktree change\n".repeat(3e5),
    );
    // Incompressible, so the binary hunk stays far past execFile's old buffer.
    await writeFile(join(cwd, "huge.bin"), randomBytes(12e6));

    const checkpoint = await captureGitCheckpoint(cwd, "run-3", "START");

    expect(checkpoint.worktreeTree).toMatch(/^[a-f0-9]{40}$/);
    expect(checkpoint.diffPatch).toContain("[Truncated after");
    expect(checkpoint.diffPatch!.length).toBeLessThanOrEqual(2_000_000);
    expect(checkpoint.manifestJson.length).toBeLessThanOrEqual(2_000_000);
    expect(checkpoint.diffSummary!.length).toBeLessThanOrEqual(500_000);

    const current = await captureGitCheckpoint(cwd, "run-3", "FINAL");
    const preview = await compareGitCheckpoint(cwd, checkpoint, current);
    expect(preview.rollbackPatch.length).toBeLessThanOrEqual(2_000_000);
  });
});
