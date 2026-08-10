import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach } from "vitest";

import { closeAllWorktreeWatches } from "./worktrees.js";

const execute = promisify(execFile);
const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };

/**
 * Folders removed after each test. Tests push the worktrees and clones they
 * derive themselves; the fixture helpers register what they create.
 */
export const temporaryDirectories: string[] = [];

export async function git(folder: string, ...args: string[]) {
  return execute("git", ["-c", "commit.gpgsign=false", "-C", folder, ...args], {
    env: gitEnvironment,
  });
}

export async function cloneRepository(remote: string, destination: string) {
  return execute("git", ["clone", remote, destination], {
    env: gitEnvironment,
  });
}

async function buildTemplate() {
  const folder = await mkdtemp(join(tmpdir(), "worktree-template-"));
  await git(folder, "init", "-b", "main");
  await git(folder, "config", "user.email", "test@example.com");
  await git(folder, "config", "user.name", "Test User");
  await git(folder, "config", "commit.gpgsign", "false");
  await writeFile(join(folder, "README.md"), "base\n");
  await git(folder, "add", "README.md");
  await git(folder, "commit", "-m", "Initial commit");
  await git(
    folder,
    "remote",
    "add",
    "origin",
    "git@github.com:OpenAI/Codex.git",
  );
  const head = (await git(folder, "rev-parse", "HEAD")).stdout.trim();
  await git(folder, "update-ref", "refs/remotes/origin/main", head);
  await git(
    folder,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  await git(folder, "branch", "--set-upstream-to=origin/main", "main");
  return folder;
}

// Replaying the eleven setup commands costs ~170ms per test, so each file
// builds the repository once and copies it for every test that asks. Nothing
// git writes here records an absolute path, so a copy works from any folder.
let template: Promise<string> | null = null;

export async function repository() {
  template ??= buildTemplate();
  const folder = await mkdtemp(join(tmpdir(), "worktree-agent-"));
  temporaryDirectories.push(folder);
  await cp(await template, folder, { recursive: true });
  return folder;
}

export async function localRemote() {
  const folder = await mkdtemp(join(tmpdir(), "worktree-remote-"));
  temporaryDirectories.push(folder);
  await execute("git", ["init", "--bare", "-b", "main", folder], {
    env: gitEnvironment,
  });
  return folder;
}

export async function useHostedRemote(
  folder: string,
  remote: string,
  url: string,
) {
  const wrapperDirectory = await mkdtemp(join(tmpdir(), "worktree-ssh-"));
  temporaryDirectories.push(wrapperDirectory);
  const wrapper = join(wrapperDirectory, "ssh");
  await writeFile(
    wrapper,
    '#!/bin/sh\nfor argument do command="$argument"; done\nexec sh -c "$command"\n',
  );
  await chmod(wrapper, 0o755);
  await git(folder, "config", "core.sshCommand", wrapper);
  await git(folder, "remote", "set-url", "origin", url);
}

/** Registers the cleanup every worktree test file shares. */
export function registerWorktreeFixtures(): void {
  afterEach(async () => {
    closeAllWorktreeWatches();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((folder) => rm(folder, { recursive: true, force: true })),
    );
  });
  afterAll(async () => {
    const built = template;
    template = null;
    if (built) await rm(await built, { recursive: true, force: true });
  });
}
