import { describe, expect, test } from "vitest";

import {
  parseCodebaseWorktreeReport,
  parseWorktreeActivityReport,
  worktreeBranchJobPayload,
  worktreeDeleteJobPayload,
  worktreeJobPayload,
  worktreeMoveCheckoutJobPayload,
  worktreeMovePushJobPayload,
  worktreeWatchJobPayload,
} from "@ai-development-environment/agent-contract/worktrees";

describe("worktree agent contract", () => {
  test("parses authoritative inventory reports", () => {
    expect(
      parseCodebaseWorktreeReport({
        codebaseId: "codebase-1",
        complete: true,
        defaultBranch: "main",
        localBranches: ["main"],
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
            pushStatus: "READY",
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
      worktrees: [expect.objectContaining({ pushStatus: "READY" })],
    });

    expect(
      parseCodebaseWorktreeReport({
        codebaseId: "codebase-1",
        complete: true,
        defaultBranch: "main",
        remoteBranches: ["main"],
        fetchedAt: null,
        fetchAttemptedAt: null,
        fetchError: null,
        worktrees: [],
      }),
    ).toMatchObject({ localBranches: [] });
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
        pushStatus: "DIRTY",
        observedAt: new Date(0).toISOString(),
      }),
    ).toMatchObject({
      codebaseId: "codebase-1",
      headSha: "def",
      syncState: "AHEAD",
      baseAhead: 2,
      hasStagedChanges: false,
      hasUnstagedChanges: true,
      pushStatus: "DIRTY",
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

  test("validates create and change branch job payloads", () => {
    const payload = worktreeBranchJobPayload({
      codebaseId: "codebase-1",
      rootFolder: "/repo",
      folder: null,
      gitDirectory: null,
      expectedOrigin: "github.com/openai/codex",
      baseBranch: "main",
      action: "CREATE",
      mode: "NEW",
      candidates: ["feature/APP-123", "feature/APP-123-2"],
      stashOnFailure: false,
    });
    expect(payload.candidates).toHaveLength(2);
    expect(() =>
      worktreeBranchJobPayload({
        ...payload,
        candidates: ["invalid..branch"],
      }),
    ).toThrow("Invalid Git branch name");
  });

  test("strictly validates move and delete job payloads", () => {
    const push = worktreeMovePushJobPayload({
      moveId: "move-1",
      codebaseId: "codebase-1",
      folder: "/repo-linked",
      gitDirectory: "/repo/.git/worktrees/repo-linked",
      expectedOrigin: "github.com/openai/codex",
      branch: "feature/move",
      expectedHeadSha: "abc",
    });
    expect(push.branch).toBe("feature/move");
    expect(() => worktreeMovePushJobPayload({ ...push, force: true })).toThrow(
      "Unexpected worktree move push payload field",
    );

    const checkout = worktreeMoveCheckoutJobPayload({
      moveId: "move-1",
      codebaseId: "codebase-2",
      rootFolder: "/destination",
      folder: null,
      gitDirectory: null,
      expectedOrigin: "github.com/openai/codex",
      branch: "feature/move",
      expectedHeadSha: "abc",
      baseBranch: "main",
      mode: "NEW",
      stashOnFailure: false,
    });
    expect(checkout.mode).toBe("NEW");
    expect(() =>
      worktreeMoveCheckoutJobPayload({
        ...checkout,
        mode: "EXISTING",
        folder: null,
      }),
    ).toThrow("existing destination");

    const deletion = worktreeDeleteJobPayload({
      moveId: null,
      codebaseId: "codebase-1",
      rootFolder: "/repo",
      folder: "/repo-linked",
      gitDirectory: "/repo/.git/worktrees/repo-linked",
      expectedOrigin: "github.com/openai/codex",
      branch: "feature/move",
      defaultBranch: "main",
      deleteRemoteBranch: true,
      requireClean: false,
      expectedHeadSha: null,
    });
    expect(deletion.deleteRemoteBranch).toBe(true);
    expect(() =>
      worktreeDeleteJobPayload({
        ...deletion,
        requireClean: true,
        expectedHeadSha: null,
      }),
    ).toThrow("requires an expected HEAD");
  });
});
