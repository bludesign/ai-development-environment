import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { worktreeCodeStateHash } from "./git-code-state.js";

const execute = promisify(execFile);

test("hashes tracked and untracked content and returns to the original state", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ade-code-state-"));
  const signal = new AbortController().signal;
  const git = (...args: string[]) => execute("git", ["-C", folder, ...args]);
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("config", "commit.gpgSign", "false");
    await writeFile(join(folder, "tracked.txt"), "original\n");
    await git("add", "tracked.txt");
    await git("commit", "-m", "initial");

    const original = await worktreeCodeStateHash(folder, 10_000, signal);
    expect(original).toMatch(/^[a-f0-9]{64}$/);

    await writeFile(join(folder, "tracked.txt"), "changed\n");
    expect(await worktreeCodeStateHash(folder, 10_000, signal)).not.toBe(
      original,
    );
    await writeFile(join(folder, "tracked.txt"), "original\n");
    expect(await worktreeCodeStateHash(folder, 10_000, signal)).toBe(original);

    await writeFile(join(folder, "untracked.txt"), "first\n");
    const firstUntracked = await worktreeCodeStateHash(folder, 10_000, signal);
    expect(firstUntracked).not.toBe(original);
    await writeFile(join(folder, "untracked.txt"), "second\n");
    expect(await worktreeCodeStateHash(folder, 10_000, signal)).not.toBe(
      firstUntracked,
    );
    await unlink(join(folder, "untracked.txt"));
    expect(await worktreeCodeStateHash(folder, 10_000, signal)).toBe(original);
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
}, 15_000);
