import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AUTO_BUILD_CHECKOUT_CHANGED,
  genericBuildDestinations,
} from "@ai-development-environment/agent-contract/builds";
import { normalizeGitOrigin } from "@ai-development-environment/agent-contract/codebases";
import { runAndroidBuild } from "./android-builds.js";
import { runIosBuild, verifyQueuedBuildCheckout } from "./builds.js";
import { inspectWorktreeItem } from "./worktrees.js";
import {
  git,
  registerWorktreeFixtures,
  repository,
} from "./worktree-fixtures.js";

registerWorktreeFixtures();

test("inventory and automatic execution agree on ignored submodule changes and clean-index merges", async () => {
  const folder = await repository();
  const dependency = await repository();
  await git(
    folder,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    dependency,
    "module",
  );
  await git(folder, "commit", "-m", "Add submodule");
  await git(folder, "config", "submodule.module.ignore", "dirty");
  const headSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  const signal = new AbortController().signal;
  const check = async (eligible: boolean) => {
    const item = await inspectWorktreeItem(
      folder,
      folder,
      null,
      true,
      10_000,
      signal,
    );
    expect(item).toMatchObject({
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      cleanForAutoBuild: eligible,
    });
    const result = await verifyQueuedBuildCheckout(
      folder,
      { branch: "main", headSha, requireCleanWorktree: true },
      10_000,
      signal,
    );
    expect(result?.errorCode).toBe(
      eligible ? undefined : AUTO_BUILD_CHECKOUT_CHANGED,
    );
  };
  await writeFile(join(folder, "module", "README.md"), "dirty");
  await check(false);
  await git(join(folder, "module"), "restore", "README.md");
  await check(true);
  const mergeHead = join(folder, ".git", "MERGE_HEAD");
  await writeFile(mergeHead, `${headSha}\n`);
  await check(false);
  await rm(mergeHead);
  await check(true);
});

test("checks branch, HEAD, staged files, untracked files and in-progress merges before a clean build", async () => {
  const folder = await repository();
  const headSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  const expected = { branch: "main", headSha, requireCleanWorktree: true };
  const signal = new AbortController().signal;
  const verify = (overrides = {}) =>
    verifyQueuedBuildCheckout(
      folder,
      { ...expected, ...overrides },
      10_000,
      signal,
    );
  const skip = { exitCode: 1, errorCode: AUTO_BUILD_CHECKOUT_CHANGED };

  await expect(verify()).resolves.toBeUndefined();
  await expect(verify({ branch: "other" })).resolves.toMatchObject(skip);
  await git(folder, "commit", "--allow-empty", "-m", "Updated locally");
  await expect(verify()).resolves.toMatchObject(skip);
  await git(folder, "reset", "--hard", headSha);

  const untracked = join(folder, "untracked");
  await writeFile(untracked, "untracked");
  await expect(verify()).resolves.toMatchObject(skip);
  await rm(untracked);
  await writeFile(join(folder, "README.md"), "edited");
  await expect(verify()).resolves.toMatchObject(skip);
  await git(folder, "add", "README.md");
  await expect(verify()).resolves.toMatchObject(skip);
  await git(folder, "reset", "--hard", headSha);

  await writeFile(join(folder, ".git", "MERGE_HEAD"), `${headSha}\n`);
  await expect(verify()).resolves.toMatchObject(skip);
  await expect(
    verify({ requireCleanWorktree: false }),
  ).resolves.toBeUndefined();
});

test("Apple and Android handlers stop before invoking build tools on a dirty automatic build", async () => {
  const folder = await repository();
  const origin = (
    await git(folder, "remote", "get-url", "origin")
  ).stdout.trim();
  const headSha = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(folder, "untracked"), "dirty after enqueue");
  const common = {
    codebaseId: "codebase",
    worktreeId: "worktree",
    folder,
    gitDirectory: await realpath(join(folder, ".git")),
    expectedOrigin: normalizeGitOrigin(origin).canonicalOrigin,
    branch: "main",
    headSha,
    buildId: "build",
    artifactDirectory: join(folder, "artifacts", "build"),
    requireCleanWorktree: true,
    scripts: [],
  };
  const signal = new AbortController().signal;
  const discardLogs = async () => undefined;
  const skip = { exitCode: 1, errorCode: AUTO_BUILD_CHECKOUT_CHANGED };
  await expect(
    runIosBuild(
      {
        ...common,
        source: { kind: "PROJECT", relativePath: "App.xcodeproj" },
        scheme: "App",
        configuration: "Debug",
        action: "BUILD",
        destination: genericBuildDestinations("BUILD")[0],
        advancedSettings: {},
      },
      10_000,
      signal,
      discardLogs,
    ),
  ).resolves.toMatchObject(skip);
  await expect(
    runAndroidBuild(
      {
        ...common,
        gradleCachePath: join(folder, "cache"),
        settings: { projectPath: ".", module: ":app", variant: "debug" },
      },
      10_000,
      signal,
      discardLogs,
    ),
  ).resolves.toMatchObject(skip);
});
