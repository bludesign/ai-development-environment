import { lstat, realpath } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";

const cleanup = vi.hoisted(() => ({ inspect: vi.fn(), remove: vi.fn() }));
vi.mock("./build-data.js", () => ({
  ownedWorktreeBuildData: cleanup.inspect,
  deleteBuildData: cleanup.remove,
}));

import { deleteWorktree } from "./worktrees.js";
import {
  git,
  registerWorktreeFixtures,
  repository,
  temporaryDirectories,
} from "./worktree-fixtures.js";

registerWorktreeFixtures();

describe("worktree deletion Xcode cleanup", () => {
  test("inspects ownership before Git removal and reports cleanup failure after successful removal", async () => {
    const root = await repository();
    const linked = `${root}-deleted`;
    temporaryDirectories.push(linked);
    await git(
      root,
      "worktree",
      "add",
      "-b",
      "feature/delete-with-data",
      linked,
    );
    const folder = await realpath(linked);
    const gitDirectory = await realpath(
      (
        await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
      ).stdout.trim(),
    );
    cleanup.inspect.mockImplementation(async (path) => {
      expect((await lstat(path)).isDirectory()).toBe(true);
      return {
        targets: [{ path: "/DerivedData/App-owned", rootPath: "/DerivedData" }],
        warnings: [],
      };
    });
    cleanup.remove.mockImplementation(async () => {
      await expect(lstat(folder)).rejects.toMatchObject({ code: "ENOENT" });
      throw new Error("Cleanup filesystem unavailable");
    });
    const result = await deleteWorktree(
      {
        moveId: null,
        codebaseId: "codebase-1",
        rootFolder: root,
        folder,
        gitDirectory,
        expectedOrigin: normalizeGitOrigin(
          (await git(root, "remote", "get-url", "origin")).stdout.trim(),
        ).canonicalOrigin,
        branch: "feature/delete-with-data",
        defaultBranch: "main",
        deleteRemoteBranch: false,
        requireClean: false,
        expectedHeadSha: null,
        derivedData: { mode: "ABSOLUTE", path: "/DerivedData" },
      },
      20_000,
      new AbortController().signal,
      async () => undefined,
    );
    expect(result).toMatchObject({
      exitCode: 0,
      deleted: true,
      buildDataCleanup: {
        warnings: [expect.stringContaining("Cleanup filesystem unavailable")],
      },
    });
    expect(cleanup.inspect).toHaveBeenCalledWith(
      folder,
      { mode: "ABSOLUTE", path: "/DerivedData" },
      20_000,
      expect.any(AbortSignal),
    );
    expect(cleanup.remove).toHaveBeenCalledOnce();
  });
});
