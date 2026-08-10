import { describe, expect, test } from "vitest";

import {
  worktreeCommitJobPayload,
  worktreeDiffPayload,
  worktreePreparationJobPayload,
} from "./worktrees.js";

const identity = {
  codebaseId: "codebase-1",
  folder: "/repo",
  gitDirectory: "/repo/.git",
  expectedOrigin: "github.com/openai/codex",
};

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
