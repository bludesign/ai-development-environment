import { describe, expect, test } from "vitest";

import {
  parseWorktreeRefreshState,
  worktreeCommitJobPayload,
  worktreeDiffPayload,
  worktreeGitInspectPayload,
  worktreePreparationJobPayload,
} from "./worktrees.js";

const identity = {
  codebaseId: "codebase-1",
  folder: "/repo",
  gitDirectory: "/repo/.git",
  expectedOrigin: "github.com/openai/codex",
};

describe("worktree Git refresh contract", () => {
  const clean = {
    dirty: false,
    hasConflicts: false,
    rebaseInProgress: false,
    mergeInProgress: false,
  };

  test("accepts targeted refreshes and requires explicit boolean results", () => {
    expect(
      worktreeGitInspectPayload({ ...identity, action: "REFRESH" }),
    ).toEqual({
      ...identity,
      action: "REFRESH",
    });
    expect(parseWorktreeRefreshState(clean)).toEqual(clean);
    expect(parseWorktreeRefreshState({ ...clean, hasConflicts: true })).toEqual(
      { ...clean, hasConflicts: true },
    );
  });

  test.each(Object.keys(clean))(
    "rejects missing or invalid %s flags",
    (key) => {
      const missing: Record<string, unknown> = { ...clean };
      delete missing[key];
      for (const state of [
        missing,
        { ...clean, [key]: "false" },
        { ...clean, [key]: null },
      ]) {
        expect(() => parseWorktreeRefreshState(state)).toThrow(
          `worktree refresh state.${key} must be a boolean`,
        );
      }
    },
  );

  test("rejects stash arguments on refresh requests", () => {
    expect(() =>
      worktreeGitInspectPayload({
        ...identity,
        action: "REFRESH",
        stashOid: "a".repeat(40),
      }),
    ).toThrow("REFRESH inspection cannot include stashOid");
  });
});

describe("worktree payload paths", () => {
  test("accepts literal bracketed Git paths in diffs and partial commits", () => {
    const path = "src/app/[locale]/page.tsx";

    expect(
      worktreeCommitJobPayload({
        ...identity,
        baseBranch: "main",
        message: "Update locale page",
        signed: null,
        stageAll: false,
        paths: [path],
      }).paths,
    ).toEqual([path]);
    expect(
      worktreeDiffPayload({
        ...identity,
        baseBranch: "main",
        scope: "UNSTAGED",
        path,
        previousPath: null,
        commitSha: null,
        uploadId: null,
        side: null,
      }).path,
    ).toBe(path);
  });

  test("keeps glob characters forbidden for preparation definitions", () => {
    expect(() =>
      worktreePreparationJobPayload({
        ...identity,
        action: "APPLY",
        preparations: [
          {
            id: "preparation-1",
            kind: "DELETE",
            path: "src/app/[locale]/page.tsx",
            contentBase64: null,
            definitionHash: "hash-1",
          },
        ],
      }),
    ).toThrow("exact file inside the worktree");
  });

  test("accepts empty write contents and codebase-batched worktrees", () => {
    expect(
      worktreePreparationJobPayload({
        codebaseId: identity.codebaseId,
        expectedOrigin: identity.expectedOrigin,
        action: "APPLY",
        preparations: [
          {
            id: "preparation-1",
            kind: "WRITE",
            path: "empty.txt",
            contentBase64: "",
            definitionHash: "hash-1",
          },
        ],
        worktrees: [
          {
            worktreeId: "worktree-1",
            folder: identity.folder,
            gitDirectory: identity.gitDirectory,
          },
        ],
      }),
    ).toMatchObject({
      preparations: [{ contentBase64: "" }],
      worktrees: [{ worktreeId: "worktree-1" }],
    });
  });
});
