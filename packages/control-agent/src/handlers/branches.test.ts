import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import { scanLocalBranches, deleteLocalBranches } from "./branches.js";
import type { AgentJobHandlerContext } from "./index.js";
import * as capture from "../capture-command.js";

const execute = promisify(execFile);
const folders: string[] = [];
const git = (folder: string, ...args: string[]) =>
  execute("git", ["-c", "commit.gpgsign=false", "-C", folder, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "local-branches-test-"));
  folders.push(root);
  const folder = join(root, "checkout");
  const remote = join(root, "origin.git");
  await mkdir(folder);
  await execute("git", ["init", "--bare", "--initial-branch=main", remote]);
  await git(folder, "init", "-b", "main");
  await git(folder, "config", "user.email", "test@example.com");
  await git(folder, "config", "user.name", "Test");
  await git(folder, "commit", "--allow-empty", "-m", "Initial");
  await git(
    folder,
    "remote",
    "add",
    "origin",
    "ssh://example.test/team/repo.git",
  );
  await git(
    folder,
    "config",
    `url.${remote}.insteadOf`,
    "ssh://example.test/team/repo.git",
  );
  await git(folder, "push", "-u", "origin", "main");
  await git(folder, "config", "--unset", `url.${remote}.insteadOf`);
  const sha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  return { root, folder, remote, sha };
}
async function run(
  folder: string,
  targets: Array<{ branch: string; expectedHeadSha: string }>,
  force = false,
) {
  return deleteLocalBranches(
    {
      codebaseId: "codebase",
      folder,
      expectedOrigin: "example.test/team/repo",
      defaultBranch: "main",
      force,
      targets: targets.map((target) => ({ ...target, codebaseId: "codebase" })),
    },
    30_000,
    new AbortController().signal,
    async () => {},
    {} as AgentJobHandlerContext,
  );
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

describe("local branch cleanup", () => {
  test("uses the local tip even when origin has a newer same-named branch and includes more than 1000 refs", async () => {
    const { folder, sha } = await repository();
    await git(folder, "checkout", "-b", "remote-change");
    await git(folder, "commit", "--allow-empty", "-m", "Newer remote commit");
    const remoteSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "checkout", "main");
    await git(folder, "update-ref", "refs/remotes/origin/main", remoteSha);
    await git(
      folder,
      "update-ref",
      "refs/remotes/origin/remote-only",
      remoteSha,
    );
    await Promise.all(
      Array.from({ length: 1_105 }, (_, index) =>
        writeFile(
          join(folder, ".git", "refs", "heads", `old-${index}`),
          `${sha}\n`,
        ),
      ),
    );
    const inventory = await scanLocalBranches(
      folder,
      30_000,
      new AbortController().signal,
    );
    expect(inventory.branches).toHaveLength(1_107);
    expect(
      inventory.branches.find((branch) => branch.name === "main"),
    ).toMatchObject({
      headSha: sha,
      lastCommitMessage: "Initial",
      current: true,
    });
    expect(
      inventory.branches.some((branch) => branch.name === "remote-only"),
    ).toBe(false);
  });
  test("deletes merged branches, reports unmerged failures, and force-deletes only local refs", async () => {
    const { folder, remote, sha } = await repository();
    await git(folder, "branch", "merged");
    await git(folder, "checkout", "-b", "unmerged");
    await git(folder, "commit", "--allow-empty", "-m", "Unmerged work");
    const unmergedSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "push", remote, "unmerged");
    await git(
      folder,
      "update-ref",
      "refs/remotes/origin/unmerged",
      unmergedSha,
    );
    await git(folder, "checkout", "main");
    const beforeRemote = (await git(remote, "show-ref")).stdout;
    const beforeTracking = (
      await git(
        folder,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/remotes",
      )
    ).stdout;
    const normal = await run(folder, [
      { branch: "merged", expectedHeadSha: sha },
      { branch: "unmerged", expectedHeadSha: unmergedSha },
    ]);
    expect(normal).toMatchObject({
      branchDeletionResults: [
        { branch: "merged", outcome: "DELETED" },
        { branch: "unmerged", outcome: "FAILED" },
      ],
    });
    const forced = await run(
      folder,
      [{ branch: "unmerged", expectedHeadSha: unmergedSha }],
      true,
    );
    expect(forced).toMatchObject({
      branchDeletionResults: [{ outcome: "DELETED" }],
    });
    expect((await git(remote, "show-ref")).stdout).toBe(beforeRemote);
    expect(
      (
        await git(
          folder,
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/remotes",
        )
      ).stdout,
    ).toBe(beforeTracking);
  });
  test("force mode still protects default, current, worktree, and changed-tip branches", async () => {
    const { root, folder, sha } = await repository();
    await git(folder, "branch", "changed");
    await git(folder, "branch", "worktree");
    await git(folder, "worktree", "add", join(root, "linked"), "worktree");
    await git(folder, "checkout", "-b", "current");
    await git(folder, "commit", "--allow-empty", "-m", "New tip");
    const currentSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
    await git(folder, "update-ref", "refs/heads/changed", currentSha);
    const result = await run(
      folder,
      [
        { branch: "main", expectedHeadSha: sha },
        { branch: "current", expectedHeadSha: currentSha },
        { branch: "worktree", expectedHeadSha: sha },
        { branch: "changed", expectedHeadSha: sha },
        { branch: "remote-only", expectedHeadSha: sha },
      ],
      true,
    );
    expect(result).toMatchObject({
      branchDeletionResults: Array.from({ length: 5 }, () => ({
        outcome: "SKIPPED",
      })),
    });
    expect(
      (await scanLocalBranches(folder, 30_000, new AbortController().signal))
        .branches,
    ).toHaveLength(4);
  });
  test("reports each outcome before the next branch and preserves results when reporting disconnects", async () => {
    const { folder, sha } = await repository();
    await git(folder, "branch", "first");
    await git(folder, "branch", "second");
    const report = vi.fn(async (result) => {
      if (result.branch === "first") {
        expect(
          (
            await scanLocalBranches(folder, 1_000, new AbortController().signal)
          ).branches.some((branch) => branch.name === "second"),
        ).toBe(true);
        throw new Error("Disconnected");
      }
    });
    const result = await deleteLocalBranches(
      {
        codebaseId: "codebase",
        folder,
        expectedOrigin: "example.test/team/repo",
        defaultBranch: "main",
        force: false,
        targets: ["first", "second"].map((branch) => ({
          codebaseId: "codebase",
          branch,
          expectedHeadSha: sha,
        })),
      },
      30_000,
      new AbortController().signal,
      async () => {},
      {
        reportBranchDeletionResult: report,
      } as unknown as AgentJobHandlerContext,
    );
    expect(report).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      branchDeletionResults: [
        { branch: "first", outcome: "DELETED" },
        { branch: "second", outcome: "DELETED" },
      ],
    });
  });
  test("blocks an unknown default branch and origin mismatches even in force mode", async () => {
    const { folder, sha } = await repository();
    await git(folder, "branch", "old");
    const input = {
      codebaseId: "codebase",
      folder,
      expectedOrigin: "example.test/team/repo",
      defaultBranch: null,
      force: true,
      targets: [
        { codebaseId: "codebase", branch: "old", expectedHeadSha: sha },
      ],
    };
    const signal = new AbortController().signal;
    expect(
      await deleteLocalBranches(input, 30_000, signal, async () => {}),
    ).toMatchObject({
      branchDeletionResults: [
        {
          outcome: "SKIPPED",
          reason: expect.stringContaining("default branch is unknown"),
        },
      ],
    });
    await git(
      folder,
      "remote",
      "set-url",
      "origin",
      "ssh://other.test/team/repo.git",
    );
    expect(
      await deleteLocalBranches(
        { ...input, defaultBranch: "main" },
        30_000,
        signal,
        async () => {},
      ),
    ).toMatchObject({
      branchDeletionResults: [{ outcome: "FAILED" }],
      snapshot: { availability: "ORIGIN_MISMATCH" },
      localBranchInventory: null,
      localBranchInventoryError: expect.any(String),
    });
    expect(
      (await scanLocalBranches(folder, 30_000, signal)).branches.some(
        (branch) => branch.name === "old",
      ),
    ).toBe(true);
  });
  test("does not hide a truncated inventory or accept remote deletion instructions", async () => {
    const { folder, sha } = await repository();
    vi.spyOn(capture, "captureCommand").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: "",
      outputTruncated: true,
    });
    await expect(
      scanLocalBranches(folder, 1_000, new AbortController().signal),
    ).rejects.toThrow("output limit");
    await expect(
      deleteLocalBranches(
        {
          codebaseId: "codebase",
          folder,
          expectedOrigin: "example.test/team/repo",
          defaultBranch: "main",
          force: true,
          operation: "DELETE_REMOTE_BRANCH",
          targets: [
            { codebaseId: "codebase", branch: "main", expectedHeadSha: sha },
          ],
        },
        1_000,
        new AbortController().signal,
        async () => {},
        {} as AgentJobHandlerContext,
      ),
    ).rejects.toThrow("Unexpected");
  });
});
