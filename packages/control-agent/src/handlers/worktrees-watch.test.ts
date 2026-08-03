import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  git,
  repository,
  registerWorktreeFixtures,
} from "./worktree-fixtures.js";
import { watchWorktree } from "./worktrees.js";

registerWorktreeFixtures();

describe("worktree activity watching", () => {
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
      { agentId: "agent-1", reportWorktreeActivity },
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
  }, 10_000);

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
      { agentId: "agent-1", reportWorktreeActivity },
    );
    await vi.waitFor(() => expect(reportWorktreeActivity).toHaveBeenCalled(), {
      timeout: 3_000,
    });
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
  }, 10_000);
});
