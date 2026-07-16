import { describe, expect, test } from "vitest";

import {
  parseCodebaseWorktreeReport,
  parseWorktreeActivityReport,
  worktreeJobPayload,
  worktreeWatchJobPayload,
} from "@ai-development-environment/agent-contract/worktrees";

describe("worktree agent contract", () => {
  test("parses authoritative inventory reports", () => {
    expect(
      parseCodebaseWorktreeReport({
        codebaseId: "codebase-1",
        complete: true,
        defaultBranch: "main",
        remoteBranches: ["main", "release"],
        fetchedAt: null,
        fetchAttemptedAt: null,
        fetchError: null,
        worktrees: [
          {
            gitDirectory: "/repo/.git",
            folder: "/repo",
            relativePath: ".",
            primary: true,
            branch: "main",
            headSha: "abc",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            syncState: "IN_SYNC",
            baseAhead: 0,
            baseBehind: 0,
            hasUnstagedChanges: false,
            availability: "AVAILABLE",
            error: null,
            checkedAt: new Date(0).toISOString(),
          },
        ],
      }),
    ).toMatchObject({
      codebaseId: "codebase-1",
      complete: true,
      defaultBranch: "main",
    });
  });

  test("rejects arbitrary operation names and payload fields", () => {
    const base = {
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      expectedOrigin: "github.com/openai/codex",
      baseBranch: "main",
    };
    expect(() => worktreeJobPayload({ ...base, operation: "SHELL" })).toThrow(
      "operation is invalid",
    );
    expect(() => worktreeJobPayload({ ...base, command: "rm -rf /" })).toThrow(
      "Unexpected worktree payload field",
    );
  });

  test("validates watcher jobs and activity reports", () => {
    const watch = worktreeWatchJobPayload({
      codebaseId: "codebase-1",
      folder: "/repo",
      gitDirectory: "/repo/.git",
      expectedOrigin: "github.com/openai/codex",
      baseBranch: "main",
      action: "START",
      watchId: "watch-1",
    });
    expect(watch).toMatchObject({ action: "START", watchId: "watch-1" });
    expect(() =>
      worktreeWatchJobPayload({ ...watch, action: "SHELL" }),
    ).toThrow("action is invalid");
    expect(
      parseWorktreeActivityReport({
        codebaseId: "codebase-1",
        gitDirectory: "/repo/.git",
        hasUnstagedChanges: true,
        observedAt: new Date(0).toISOString(),
      }),
    ).toMatchObject({
      codebaseId: "codebase-1",
      hasUnstagedChanges: true,
    });
  });
});
