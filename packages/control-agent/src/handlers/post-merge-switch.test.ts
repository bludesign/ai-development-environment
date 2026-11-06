import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import {
  WORKTREE_POST_MERGE_SWITCH_JOB_KIND,
  type WorktreePostMergeSwitchPayload,
} from "@ai-development-environment/agent-contract/worktrees";
import * as capture from "../capture-command.js";
import { postMergeSwitch } from "./post-merge-switch.js";
import { handlers } from "./index.js";
import {
  git,
  localRemote,
  repository,
  registerWorktreeFixtures,
  temporaryDirectories,
  useHostedRemote as configureHostedRemote,
} from "./worktree-fixtures.js";

registerWorktreeFixtures();
afterEach(() => vi.restoreAllMocks());

async function fixture(newer = false) {
  const folder = await repository();
  const remote = await localRemote();
  await git(folder, "push", remote, "main");
  const initial = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  const url = `ssh://git@example.test${remote}`;
  await configureHostedRemote(folder, remote, url);
  await git(folder, "switch", "-c", "feature/reviewed");
  await writeFile(join(folder, "feature.txt"), "feature\n");
  await git(folder, "add", "feature.txt");
  await git(folder, "commit", "-m", "Reviewed source");
  const source = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  // Squashing produces a new commit; source HEAD is not its ancestor.
  const merge = (
    await git(
      folder,
      "commit-tree",
      `${source}^{tree}`,
      "-p",
      initial,
      "-m",
      "Squashed merge",
    )
  ).stdout.trim();
  const target = newer
    ? (
        await git(
          folder,
          "commit-tree",
          `${merge}^{tree}`,
          "-p",
          merge,
          "-m",
          "Later origin commit",
        )
      ).stdout.trim()
    : merge;
  await git(folder, "push", remote, `${target}:main`);
  const payload: WorktreePostMergeSwitchPayload = {
    codebaseId: "codebase-1",
    folder: await realpath(folder),
    gitDirectory: await realpath(join(folder, ".git")),
    expectedOrigin: normalizeGitOrigin(url).canonicalOrigin,
    expectedBranch: "feature/reviewed",
    expectedHeadSha: source,
    branch: "main",
    mergeCommitSha: merge,
  };
  return { folder, remote, initial, source, merge, target, payload };
}

async function run(
  payload: WorktreePostMergeSwitchPayload,
  onLog = vi.fn(async () => {}),
) {
  return postMergeSwitch(payload, 15_000, new AbortController().signal, onLog);
}

describe("post-merge primary checkout switching", () => {
  test("registers the capability handler", () => {
    expect(handlers[WORKTREE_POST_MERGE_SWITCH_JOB_KIND]).toBe(postMergeSwitch);
  });

  test.each([false, true])(
    "updates inactive main before switching after a squash, with newer commits: %s",
    async (newer) => {
      const f = await fixture(newer);
      const original = capture.captureCommand;
      const commands: string[][] = [];
      vi.spyOn(capture, "captureCommand").mockImplementation(
        async (options) => {
          commands.push(options.args);
          return original(options);
        },
      );
      const result = await run(f.payload);
      expect(result).toMatchObject({
        exitCode: 0,
        outcome: "SWITCHED",
        worktree: { branch: "main", headSha: f.target, primary: true },
      });
      expect(
        (await git(f.folder, "rev-parse", "feature/reviewed")).stdout.trim(),
      ).toBe(f.source);
      expect(
        commands.findIndex((args) => args.includes("update-ref")),
      ).toBeLessThan(commands.findIndex((args) => args.includes("switch")));
      expect(await run(f.payload)).toMatchObject({
        outcome: "ALREADY_SWITCHED",
      });
    },
  );

  test.each([
    "untracked",
    "staged",
    "head",
    "branch",
    "origin",
    "identity",
    "unfinished",
  ])("preserves the checkout when %s guard fails", async (guard) => {
    const f = await fixture();
    if (guard === "untracked" || guard === "staged") {
      await writeFile(join(f.folder, "dirty.txt"), "keep this\n");
      if (guard === "staged") await git(f.folder, "add", "dirty.txt");
    } else if (guard === "head")
      await git(f.folder, "commit", "--allow-empty", "-m", "New local work");
    else if (guard === "branch")
      await git(f.folder, "switch", "-c", "feature/new");
    else if (guard === "origin")
      f.payload.expectedOrigin = "example.test/another/repository";
    else if (guard === "identity") f.payload.gitDirectory = "/different/.git";
    else
      await writeFile(
        join(f.folder, ".git", "CHERRY_PICK_HEAD"),
        `${f.source}\n`,
      );
    const before = (await git(f.folder, "rev-parse", "HEAD")).stdout.trim();
    await expect(run(f.payload)).rejects.toThrow();
    expect((await git(f.folder, "rev-parse", "HEAD")).stdout.trim()).toBe(
      before,
    );
    expect((await git(f.folder, "rev-parse", "main")).stdout.trim()).toBe(
      f.initial,
    );
  });

  test("does not overwrite a divergent local default branch", async () => {
    const f = await fixture();
    const local = (
      await git(
        f.folder,
        "commit-tree",
        `${f.initial}^{tree}`,
        "-p",
        f.initial,
        "-m",
        "Local main work",
      )
    ).stdout.trim();
    await git(f.folder, "update-ref", "refs/heads/main", local);
    await expect(run(f.payload)).rejects.toThrow("cannot be fast-forwarded");
    expect((await git(f.folder, "rev-parse", "main")).stdout.trim()).toBe(
      local,
    );
    expect(
      (await git(f.folder, "branch", "--show-current")).stdout.trim(),
    ).toBe(f.payload.expectedBranch);
  });

  test("creates a missing local default branch and tracks origin", async () => {
    const f = await fixture();
    await git(f.folder, "branch", "-D", "main");
    expect(await run(f.payload)).toMatchObject({
      outcome: "SWITCHED",
      worktree: { branch: "main", headSha: f.target, upstream: "origin/main" },
    });
    expect(
      (await git(f.folder, "rev-parse", "feature/reviewed")).stdout.trim(),
    ).toBe(f.source);
  });

  test("revalidates source HEAD after fetching without changing inactive main", async () => {
    const f = await fixture();
    const original = capture.captureCommand;
    let changedOnce = false;
    vi.spyOn(capture, "captureCommand").mockImplementation(async (options) => {
      const result = await original(options);
      if (!changedOnce && options.args.includes("fetch")) {
        changedOnce = true;
        await git(
          f.folder,
          "commit",
          "--allow-empty",
          "-m",
          "Source changed while fetching",
        );
      }
      return result;
    });
    await expect(run(f.payload)).rejects.toThrow(
      "source branch or HEAD changed",
    );
    expect((await git(f.folder, "rev-parse", "main")).stdout.trim()).toBe(
      f.initial,
    );
    expect(
      (await git(f.folder, "branch", "--show-current")).stdout.trim(),
    ).toBe(f.payload.expectedBranch);
  });

  test("does not update a destination checked out elsewhere or switch a linked checkout", async () => {
    const f = await fixture();
    const linked = `${f.folder}-main`;
    temporaryDirectories.push(linked);
    await git(f.folder, "worktree", "add", linked, "main");
    await expect(run(f.payload)).rejects.toThrow("another worktree");
    const directory = (
      await git(linked, "rev-parse", "--path-format=absolute", "--git-dir")
    ).stdout.trim();
    await expect(
      run({
        ...f.payload,
        folder: await realpath(linked),
        gitDirectory: await realpath(directory),
      }),
    ).rejects.toThrow("primary worktree identity");
    expect((await git(f.folder, "rev-parse", "main")).stdout.trim()).toBe(
      f.initial,
    );
  });

  test("protects a destination ref changed outside the app between inspection and CAS", async () => {
    const f = await fixture();
    const changed = (
      await git(
        f.folder,
        "commit-tree",
        `${f.initial}^{tree}`,
        "-p",
        f.initial,
        "-m",
        "Concurrent local work",
      )
    ).stdout.trim();
    const original = capture.captureCommand;
    let changedOnce = false;
    vi.spyOn(capture, "captureCommand").mockImplementation(async (options) => {
      if (!changedOnce && options.args.includes("update-ref")) {
        changedOnce = true;
        await git(f.folder, "update-ref", "refs/heads/main", changed);
      }
      return original(options);
    });
    await expect(run(f.payload)).rejects.toThrow();
    expect((await git(f.folder, "rev-parse", "main")).stdout.trim()).toBe(
      changed,
    );
    expect((await git(f.folder, "rev-parse", "HEAD")).stdout.trim()).toBe(
      f.source,
    );
  });

  test("waits for origin to expose the provider-confirmed merge commit", async () => {
    const f = await fixture();
    await git(f.remote, "update-ref", "refs/heads/main", f.initial);
    const onLog = vi.fn(async () => {
      await git(f.remote, "update-ref", "refs/heads/main", f.target);
    });
    expect(await run(f.payload, onLog)).toMatchObject({ outcome: "SWITCHED" });
    expect(onLog).toHaveBeenCalledOnce();
  });
});
