import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import type { WorktreePreparationDefinition } from "@ai-development-environment/agent-contract/worktrees";

import {
  git,
  registerWorktreeFixtures,
  repository,
  temporaryDirectories,
} from "./worktree-fixtures.js";
import { executeWorktreePreparations } from "./worktree-preparations.js";
import { prepareWorktree } from "./worktrees.js";

registerWorktreeFixtures();

const signal = new AbortController().signal;
const definition = (
  id: string,
  kind: WorktreePreparationDefinition["kind"],
  path: string,
  contents?: Uint8Array,
): WorktreePreparationDefinition => ({
  id,
  kind,
  path,
  contentBase64: contents ? Buffer.from(contents).toString("base64") : null,
  definitionHash: `hash-${id}`,
});

describe("worktree preparations", () => {
  test("runs a codebase batch sequentially across linked worktrees", async () => {
    const folder = await repository();
    const linked = `${folder}-batch`;
    temporaryDirectories.push(linked);
    await git(folder, "worktree", "add", "-b", "feature/batch", linked);
    const gitDirectory = async (worktree: string) =>
      realpath(
        (
          await git(
            worktree,
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
          )
        ).stdout.trim(),
      );
    const definitions = [
      definition("local", "WRITE", ".env.local", Buffer.from("local\n")),
    ];

    const result = (await prepareWorktree(
      {
        codebaseId: "codebase-1",
        expectedOrigin: "github.com/openai/codex",
        action: "APPLY",
        preparations: definitions,
        worktrees: [
          {
            worktreeId: "worktree-1",
            folder,
            gitDirectory: await gitDirectory(folder),
          },
          {
            worktreeId: "worktree-2",
            folder: linked,
            gitDirectory: await gitDirectory(linked),
          },
        ],
      },
      10_000,
      signal,
      async () => undefined,
    )) as unknown as {
      worktrees: Array<{
        worktreeId: string;
        preparations: Array<{ state: string }>;
      }>;
    };

    expect(result.worktrees).toMatchObject([
      { worktreeId: "worktree-1", preparations: [{ state: "APPLIED" }] },
      { worktreeId: "worktree-2", preparations: [{ state: "APPLIED" }] },
    ]);
    expect(await readFile(join(folder, ".env.local"), "utf8")).toBe("local\n");
    expect(await readFile(join(linked, ".env.local"), "utf8")).toBe("local\n");
  });

  test("applies binary writes, deletes, assume flags, and exact exclusions", async () => {
    const folder = await repository();
    await writeFile(join(folder, "delete.txt"), "remove me\n");
    await git(folder, "add", "delete.txt");
    await git(folder, "commit", "-m", "Add delete fixture");
    await chmod(join(folder, "README.md"), 0o755);
    const binary = Uint8Array.from([0, 1, 2, 255]);
    const definitions = [
      definition("tracked-write", "WRITE", "README.md", binary),
      definition("new-write", "WRITE", "config/local.bin", binary),
      definition("delete", "DELETE", "delete.txt"),
      definition("assume", "ASSUME_UNCHANGED", "missing.txt"),
    ];

    const results = await executeWorktreePreparations(
      folder,
      definitions,
      "APPLY",
      10_000,
      signal,
    );

    expect(results.map((result) => result.state)).toEqual([
      "APPLIED",
      "APPLIED",
      "APPLIED",
      "NOT_APPLICABLE",
    ]);
    expect(await readFile(join(folder, "README.md"))).toEqual(
      Buffer.from(binary),
    );
    expect((await stat(join(folder, "README.md"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(folder, "config/local.bin"))).toEqual(
      Buffer.from(binary),
    );
    await expect(readFile(join(folder, "delete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await git(folder, "ls-files", "-v", "README.md")).stdout[0]).toBe(
      "h",
    );
    expect((await git(folder, "ls-files", "-v", "delete.txt")).stdout[0]).toBe(
      "h",
    );
    expect((await git(folder, "status", "--porcelain")).stdout).toBe("");

    const excludePath = (
      await git(folder, "rev-parse", "--git-path", "info/exclude")
    ).stdout.trim();
    expect(await readFile(join(folder, excludePath), "utf8")).toContain(
      "/config/local.bin",
    );
  });

  test("detects drift and forcibly restores or removes managed files on undo", async () => {
    const folder = await repository();
    const definitions = [
      definition("tracked", "WRITE", "README.md", Buffer.from("prepared\n")),
      definition("new", "WRITE", "local.txt", Buffer.from("local\n")),
      definition("assume", "ASSUME_UNCHANGED", "README.md"),
    ];
    // One rule per path is enforced by the server; use the assume rule only for
    // the second half of the test so the agent behavior stays independently testable.
    await executeWorktreePreparations(
      folder,
      definitions.slice(0, 2),
      "APPLY",
      10_000,
      signal,
    );
    await writeFile(join(folder, "README.md"), "drifted\n");
    const inspected = await executeWorktreePreparations(
      folder,
      definitions.slice(0, 2),
      "INSPECT",
      10_000,
      signal,
    );
    expect(inspected[0]?.state).toBe("DRIFTED");

    const undone = await executeWorktreePreparations(
      folder,
      definitions.slice(0, 2),
      "UNDO",
      10_000,
      signal,
    );
    expect(undone.map((result) => result.state)).toEqual(["UNDONE", "UNDONE"]);
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe("base\n");
    await expect(readFile(join(folder, "local.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await executeWorktreePreparations(
      folder,
      [definitions[2]!],
      "APPLY",
      10_000,
      signal,
    );
    await writeFile(join(folder, "README.md"), "private edit\n");
    await executeWorktreePreparations(
      folder,
      [definitions[2]!],
      "UNDO",
      10_000,
      signal,
    );
    expect(await readFile(join(folder, "README.md"), "utf8")).toBe(
      "private edit\n",
    );
    expect((await git(folder, "ls-files", "-v", "README.md")).stdout[0]).toBe(
      "H",
    );
  });

  test("rejects symlink escapes and keeps reporting independent file results", async () => {
    const folder = await repository();
    const outside = await mkdtemp(join(tmpdir(), "aide-preparation-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "untouched\n");
    await symlink(outside, join(folder, "linked"));
    await writeFile(join(folder, "blocked"), "not a directory\n");

    const results = await executeWorktreePreparations(
      folder,
      [
        definition(
          "escape",
          "WRITE",
          "linked/secret.txt",
          Buffer.from("changed\n"),
        ),
        definition(
          "blocked",
          "WRITE",
          "blocked/file.txt",
          Buffer.from("changed\n"),
        ),
        definition("valid", "WRITE", "valid.txt", Buffer.from("valid\n")),
      ],
      "APPLY",
      10_000,
      signal,
    );

    expect(results.map((result) => result.state)).toEqual([
      "ERROR",
      "ERROR",
      "APPLIED",
    ]);
    expect(results[0]?.message).toContain("symbolic link");
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "untouched\n",
    );
    expect(await readFile(join(folder, "valid.txt"), "utf8")).toBe("valid\n");
  });
});
