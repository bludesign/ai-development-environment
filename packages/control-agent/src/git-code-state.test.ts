import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { worktreeCodeStateHash } from "./git-code-state.js";

const execute = promisify(execFile);
const git = (folder: string, ...args: string[]) =>
  execute("git", ["-C", folder, ...args]);

async function initializeRepository(folder: string) {
  await git(folder, "init", "-b", "main");
  await git(folder, "config", "user.email", "test@example.com");
  await git(folder, "config", "user.name", "Test");
  await git(folder, "config", "commit.gpgSign", "false");
}

test("hashes tracked and untracked content and returns to the original state", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ade-code-state-"));
  const signal = new AbortController().signal;
  try {
    await initializeRepository(folder);
    await writeFile(join(folder, "tracked.txt"), "original\n");
    await git(folder, "add", "tracked.txt");
    await git(folder, "commit", "-m", "initial");

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

    await writeFile(join(folder, "script.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(folder, "script.sh"), 0o644);
    const nonExecutable = await worktreeCodeStateHash(folder, 10_000, signal);
    await chmod(join(folder, "script.sh"), 0o755);
    expect(await worktreeCodeStateHash(folder, 10_000, signal)).not.toBe(
      nonExecutable,
    );
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
}, 15_000);

test("hashes raw tracked content instead of textconv output", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ade-code-state-textconv-"));
  const signal = new AbortController().signal;
  try {
    await initializeRepository(folder);
    const converter = join(folder, "normalize.sh");
    await writeFile(converter, "#!/bin/sh\nprintf 'normalized\\n'\n");
    await chmod(converter, 0o755);
    await writeFile(join(folder, ".gitattributes"), "*.bin diff=normalized\n");
    await writeFile(join(folder, "tracked.bin"), "original\n");
    await git(folder, "config", "diff.normalized.textconv", converter);
    await git(folder, "add", ".gitattributes", "normalize.sh", "tracked.bin");
    await git(folder, "commit", "-m", "initial");

    await writeFile(join(folder, "tracked.bin"), "first\n");
    const firstDiff = (await git(folder, "diff", "HEAD", "--", "tracked.bin"))
      .stdout;
    const firstHash = await worktreeCodeStateHash(folder, 10_000, signal);

    await writeFile(join(folder, "tracked.bin"), "second\n");
    expect(
      (await git(folder, "diff", "HEAD", "--", "tracked.bin")).stdout,
    ).toBe(firstDiff);
    expect(await worktreeCodeStateHash(folder, 10_000, signal)).not.toBe(
      firstHash,
    );
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
}, 15_000);

test("recursively hashes dirty submodule contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "ade-code-state-submodule-"));
  const parent = join(root, "parent");
  const source = join(root, "source");
  const signal = new AbortController().signal;
  try {
    await mkdir(parent);
    await mkdir(source);
    await initializeRepository(source);
    await writeFile(join(source, "tracked.txt"), "original\n");
    await git(source, "add", "tracked.txt");
    await git(source, "commit", "-m", "initial");

    await initializeRepository(parent);
    await git(
      parent,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      source,
      "dependency",
    );
    await git(parent, "commit", "-m", "add submodule");

    const trackedPath = join(parent, "dependency", "tracked.txt");
    await writeFile(trackedPath, "first\n");
    const firstTracked = await worktreeCodeStateHash(parent, 10_000, signal);
    await writeFile(trackedPath, "second\n");
    expect(await worktreeCodeStateHash(parent, 10_000, signal)).not.toBe(
      firstTracked,
    );

    await writeFile(trackedPath, "original\n");
    const untrackedPath = join(parent, "dependency", "untracked.txt");
    await writeFile(untrackedPath, "first\n");
    const firstUntracked = await worktreeCodeStateHash(parent, 10_000, signal);
    await writeFile(untrackedPath, "second\n");
    expect(await worktreeCodeStateHash(parent, 10_000, signal)).not.toBe(
      firstUntracked,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

test("stops streaming untracked files on cancellation or timeout", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ade-code-state-abort-"));
  try {
    await initializeRepository(folder);
    await writeFile(join(folder, "tracked.txt"), "tracked\n");
    await git(folder, "add", "tracked.txt");
    await git(folder, "commit", "-m", "initial");

    const largeFile = await open(join(folder, "large.bin"), "w");
    await largeFile.truncate(8 * 1024 ** 3);
    await largeFile.close();

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 100);
    try {
      expect(
        await worktreeCodeStateHash(folder, 10_000, controller.signal),
      ).toBeNull();
    } finally {
      clearTimeout(abortTimer);
    }

    expect(
      await worktreeCodeStateHash(folder, 100, new AbortController().signal),
    ).toBeNull();
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
}, 5_000);
