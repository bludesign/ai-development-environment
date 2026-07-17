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
            hasStagedChanges: false,
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
        branch: "feature/AIDE-24",
        headSha: "def",
        upstream: "origin/feature/AIDE-24",
        ahead: 1,
        behind: 0,
        syncState: "AHEAD",
        baseAhead: 2,
        baseBehind: 0,
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        observedAt: new Date(0).toISOString(),
      }),
    ).toMatchObject({
      codebaseId: "codebase-1",
      headSha: "def",
      syncState: "AHEAD",
      baseAhead: 2,
      hasStagedChanges: false,
      hasUnstagedChanges: true,
    });
    expect(() =>
      parseWorktreeActivityReport({
        codebaseId: "codebase-1",
        gitDirectory: "/repo/.git",
        headSha: "def",
        ahead: -1,
        observedAt: new Date(0).toISOString(),
      }),
    ).toThrow("non-negative integer");
  });
});
