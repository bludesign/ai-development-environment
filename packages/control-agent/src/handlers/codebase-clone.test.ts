import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  codebaseClonePayload,
  validateCloneRemote,
  validateCloneRelativePath,
} from "@ai-development-environment/agent-contract/codebases";

import { cloneCodebase, inspectCloneDestination } from "./codebase-clone.js";

const execute = promisify(execFile);
let directory: string;
let base: string;
let remote: string;
let wrapper: string;
const remoteUrl = "ssh://fixture.example/acme/repository.git";
const expectedOrigin = "fixture.example/acme/repository";
const signal = () => new AbortController().signal;
const logs = async () => undefined;
const payload = (relativePath = "repository") => ({
  operationId: "operation",
  itemId: "item",
  codebaseId: "codebase",
  baseDirectory: base,
  relativePath,
  remoteUrl,
  expectedOrigin,
});
const git = (folder: string, ...args: string[]) =>
  execute("git", ["-c", "commit.gpgsign=false", "-C", folder, ...args]);

beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "aide-clone-fixture-")),
  );
  base = join(directory, "repositories");
  remote = join(directory, "remote");
  await mkdir(remote);
  await git(remote, "init", "-b", "main");
  await git(remote, "config", "user.name", "Fixture");
  await git(remote, "config", "user.email", "fixture@example.test");
  await writeFile(join(remote, "README.md"), "fixture\n");
  await git(remote, "add", "README.md");
  await git(remote, "commit", "-m", "Fixture");
  wrapper = join(directory, "ssh");
  await writeFile(
    wrapper,
    '#!/bin/sh\nexec git-upload-pack "$AIDE_TEST_REMOTE"\n',
  );
  await chmod(wrapper, 0o755);
  vi.stubEnv("GIT_SSH_COMMAND", wrapper);
  vi.stubEnv("GIT_SSH_VARIANT", "ssh");
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("AIDE_TEST_REMOTE", remote);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("repository clone", () => {
  test("preflights without creating directories, then clones and reports the canonical origin", async () => {
    const preview = await inspectCloneDestination(
      payload("nested/repository"),
      10_000,
      signal(),
      logs,
    );
    expect(preview).toMatchObject({
      status: "MISSING",
      destinationPath: join(base, "nested/repository"),
    });
    await expect(lstat(base)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await cloneCodebase(
      payload("nested/repository"),
      10_000,
      signal(),
      logs,
    );
    expect(result).toMatchObject({
      exitCode: 0,
      reused: false,
      snapshot: {
        canonicalOrigin: expectedOrigin,
        folder: join(base, "nested/repository"),
        availability: "AVAILABLE",
        branch: "main",
      },
    });
    expect(
      await readFile(join(base, "nested/repository/README.md"), "utf8"),
    ).toBe("fixture\n");
    expect(await readdir(join(base, "nested"))).toEqual(["repository"]);
  });

  test("reuses a matching checkout after interrupted completion and preserves uncommitted work", async () => {
    await cloneCodebase(payload(), 10_000, signal(), logs);
    await writeFile(join(base, "repository/README.md"), "local changes\n");
    expect(
      await inspectCloneDestination(payload(), 10_000, signal(), logs),
    ).toMatchObject({ status: "REUSE" });
    expect(
      await cloneCodebase(payload(), 10_000, signal(), logs),
    ).toMatchObject({ reused: true });
    expect(await readFile(join(base, "repository/README.md"), "utf8")).toBe(
      "local changes\n",
    );
  });

  test("refuses an existing empty directory or wrong-origin checkout", async () => {
    await mkdir(join(base, "repository"), { recursive: true });
    expect(
      await inspectCloneDestination(payload(), 10_000, signal(), logs),
    ).toMatchObject({ status: "CONFLICT" });
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toThrow("already exists");
    await rm(join(base, "repository"), { recursive: true });
    await cloneCodebase(payload(), 10_000, signal(), logs);
    await git(
      join(base, "repository"),
      "remote",
      "set-url",
      "origin",
      "https://example.test/other/repo.git",
    );
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toThrow("matching repository");
    expect(await readFile(join(base, "repository/README.md"), "utf8")).toBe(
      "fixture\n",
    );
  });

  test("does not follow a destination parent or final symbolic link", async () => {
    const outside = join(directory, "outside");
    await mkdir(outside);
    await mkdir(base);
    await symlink(outside, join(base, "nested"));
    expect(
      await inspectCloneDestination(
        payload("nested/repository"),
        10_000,
        signal(),
        logs,
      ),
    ).toMatchObject({ status: "CONFLICT" });
    await expect(
      cloneCodebase(payload("nested/repository"), 10_000, signal(), logs),
    ).rejects.toThrow("symbolic link");
    await symlink(outside, join(base, "repository"));
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toThrow("already exists");
    expect(await readdir(outside)).toEqual([]);
  });

  test("serializes concurrent clones to the same folder", async () => {
    const results = await Promise.all([
      cloneCodebase(payload(), 10_000, signal(), logs),
      cloneCodebase({ ...payload(), itemId: "second" }, 10_000, signal(), logs),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reused: false }),
        expect.objectContaining({ reused: true }),
      ]),
    );
    expect(await readdir(base)).toEqual(["repository"]);
  });

  test("preserves a folder created by another process during clone", async () => {
    await writeFile(
      wrapper,
      '#!/bin/sh\nmkdir -p "$AIDE_TEST_COLLISION"\nprintf "keep me" > "$AIDE_TEST_COLLISION/sentinel"\nexec git-upload-pack "$AIDE_TEST_REMOTE"\n',
    );
    vi.stubEnv("AIDE_TEST_COLLISION", join(base, "repository"));
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(base, "repository/sentinel"), "utf8")).toBe(
      "keep me",
    );
    expect(await readdir(base)).toEqual(["repository"]);
  });

  test("does not clean a foreign staging folder through a replaced parent symlink", async () => {
    const outside = join(directory, "outside");
    const moved = join(directory, "original-repositories");
    await mkdir(outside);
    await writeFile(
      wrapper,
      '#!/bin/sh\nfor folder in "$AIDE_TEST_BASE"/.aide-clone-*; do stage=${folder##*/}; done\nmv "$AIDE_TEST_BASE" "$AIDE_TEST_MOVED"\nln -s "$AIDE_TEST_OUTSIDE" "$AIDE_TEST_BASE"\nmkdir "$AIDE_TEST_OUTSIDE/$stage"\nprintf "keep me" > "$AIDE_TEST_OUTSIDE/$stage/sentinel"\nexit 1\n',
    );
    vi.stubEnv("AIDE_TEST_BASE", base);
    vi.stubEnv("AIDE_TEST_MOVED", moved);
    vi.stubEnv("AIDE_TEST_OUTSIDE", outside);
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toThrow();
    const [stage] = await readdir(moved);
    expect(stage).toMatch(/^\.aide-clone-/);
    expect(await readFile(join(outside, stage!, "sentinel"), "utf8")).toBe(
      "keep me",
    );
    expect(await readdir(outside)).toEqual([stage]);
  });

  test("does not clean a replacement staging directory with a different owner", async () => {
    const moved = join(directory, "original-staging");
    await writeFile(
      wrapper,
      '#!/bin/sh\nfor stage in "$AIDE_TEST_BASE"/.aide-clone-*; do break; done\nmv "$stage" "$AIDE_TEST_MOVED"\nmkdir "$stage"\nprintf "keep me" > "$stage/sentinel"\nexit 1\n',
    );
    vi.stubEnv("AIDE_TEST_BASE", base);
    vi.stubEnv("AIDE_TEST_MOVED", moved);
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toThrow();
    const [stage] = await readdir(base);
    expect(stage).toMatch(/^\.aide-clone-/);
    expect(await readFile(join(base, stage!, "sentinel"), "utf8")).toBe(
      "keep me",
    );
    expect((await lstat(moved)).isDirectory()).toBe(true);
  });

  test("cleans staging files after failure, timeout, and cancellation", async () => {
    vi.stubEnv("AIDE_TEST_REMOTE", join(directory, "missing"));
    await expect(
      cloneCodebase(payload(), 10_000, signal(), logs),
    ).rejects.toThrow();
    expect(await readdir(base)).toEqual([]);
    await writeFile(wrapper, "#!/bin/sh\nsleep 30\n");
    expect(await cloneCodebase(payload(), 30, signal(), logs)).toMatchObject({
      timedOut: true,
    });
    expect(await readdir(base)).toEqual([]);
    const abort = new AbortController();
    abort.abort();
    expect(
      await cloneCodebase(payload(), 10_000, abort.signal, logs),
    ).toMatchObject({ cancelled: true });
    expect(await readdir(base)).toEqual([]);
  });
});

describe("portable clone validation", () => {
  test.each([
    "../repo",
    "/repo",
    "a/../../repo",
    "a//repo",
    "a\\repo",
    ".git",
    "a/.git",
    "C:/repo",
    "repo\u0000",
  ])("rejects unsafe destination %s", (value) => {
    expect(() => validateCloneRelativePath(value)).toThrow();
  });
  test.each([
    "file:///tmp/repo",
    "/tmp/repo",
    "ext::shell",
    "https://token@example.com/repo",
    "https://example.com/repo?token=abc",
    "ssh://git:secret@example.com/repo",
    "https://example.com/repo\n",
  ])("rejects unsafe remote %s", (value) => {
    expect(() => validateCloneRemote(value)).toThrow();
  });
  test("accepts SSH identity and credential-free HTTPS but verifies expected origin", () => {
    expect(validateCloneRemote("git@github.com:acme/repo.git")).toBe(
      "git@github.com:acme/repo.git",
    );
    expect(validateCloneRemote("https://github.com/acme/repo.git")).toBe(
      "https://github.com/acme/repo.git",
    );
    expect(() =>
      codebaseClonePayload({ ...payload(), expectedOrigin: "other/repo" }),
    ).toThrow("expected repository");
  });
});
