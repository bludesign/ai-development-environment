import { describe, expect, test } from "vitest";

import {
  codebaseGitInspectPayload,
  codebaseGitOperationPayload,
  codebaseJobPayload,
  normalizeGitOrigin,
  parseCodebaseGitState,
  parseCodebaseStashDiff,
  parseCodebaseSnapshot,
} from "@ai-development-environment/agent-contract/codebases";

describe("Git origin normalization", () => {
  test("matches common SSH and HTTPS forms for case-insensitive hosts", () => {
    const ssh = normalizeGitOrigin("git@github.com:OpenAI/Codex.git");
    const https = normalizeGitOrigin("https://github.com/openai/codex");

    expect(ssh.canonicalOrigin).toBe("github.com/openai/codex");
    expect(https.canonicalOrigin).toBe(ssh.canonicalOrigin);
  });

  test("removes credentials and default ports without merging custom ports", () => {
    expect(
      normalizeGitOrigin("https://user:secret@example.com:443/Team/Repo.git"),
    ).toMatchObject({
      canonicalOrigin: "example.com/Team/Repo",
      sanitizedOrigin: "https://example.com/Team/Repo.git",
    });
    expect(
      normalizeGitOrigin("ssh://git@example.com:2222/Team/Repo.git")
        .canonicalOrigin,
    ).toBe("example.com:2222/Team/Repo");
  });

  test.each(["/tmp/repository", "../repository", "file:///tmp/repository"])(
    "rejects non-portable local origin %s",
    (origin) => expect(() => normalizeGitOrigin(origin)).toThrow("remote"),
  );
});

describe("codebase snapshot contract", () => {
  test("accepts a complete status and rejects invalid counts", () => {
    const snapshot = {
      folder: "/Users/test/repository",
      observedOrigin: "git@github.com:openai/codex.git",
      canonicalOrigin: "github.com/openai/codex",
      displayOrigin: "github.com/openai/codex",
      branch: "main",
      headSha: "abc123",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      syncState: "IN_SYNC",
      availability: "AVAILABLE",
      error: null,
      checkedAt: new Date(0).toISOString(),
      fetchedAt: null,
      linkedWorktree: false,
    };

    expect(parseCodebaseSnapshot(snapshot).syncState).toBe("IN_SYNC");
    expect(() => parseCodebaseSnapshot({ ...snapshot, ahead: -1 })).toThrow(
      "non-negative integer",
    );
  });
});

describe("codebase job payload contract", () => {
  test("accepts base branch update settings and validates the toggle", () => {
    expect(
      codebaseJobPayload({
        folder: "/Users/test/repository",
        baseBranch: "main",
        keepBaseBranchUpToDate: true,
      }),
    ).toMatchObject({
      baseBranch: "main",
      keepBaseBranchUpToDate: true,
    });
    expect(() =>
      codebaseJobPayload({
        folder: "/Users/test/repository",
        keepBaseBranchUpToDate: "yes",
      }),
    ).toThrow("must be a boolean");
  });
});

describe("codebase Git management contract", () => {
  const base = {
    codebaseId: "codebase-1",
    folder: "/Users/test/repository",
    expectedOrigin: "github.com/openai/codex",
  };
  const oid = "a".repeat(40);

  test("accepts discriminated inspection and operation payloads", () => {
    expect(codebaseGitInspectPayload({ ...base, action: "STATE" })).toEqual({
      ...base,
      action: "STATE",
    });
    expect(
      codebaseGitOperationPayload({
        ...base,
        defaultBranch: "main",
        operation: "SWITCH_BRANCH",
        branch: "feature/detail",
        stashChanges: true,
      }),
    ).toMatchObject({ branch: "feature/detail", stashChanges: true });
    expect(
      codebaseGitOperationPayload({
        ...base,
        operation: "APPLY_STASH",
        stashOid: oid,
      }),
    ).toMatchObject({ stashOid: oid });
  });

  test("rejects invalid or operation-inappropriate fields", () => {
    expect(() =>
      codebaseGitInspectPayload({
        ...base,
        action: "STATE",
        stashOid: oid,
      }),
    ).toThrow("cannot include stashOid");
    expect(() =>
      codebaseGitOperationPayload({
        ...base,
        operation: "DELETE_BRANCH",
        branch: "-force",
      }),
    ).toThrow("Invalid Git branch name");
    expect(() =>
      codebaseGitOperationPayload({
        ...base,
        operation: "DELETE_STASH",
        stashOid: "stash@{0}",
      }),
    ).toThrow("Git object ID");
  });

  test("parses live state and bounded stash patches", () => {
    expect(
      parseCodebaseGitState({
        dirty: true,
        branches: [
          {
            name: "main",
            local: true,
            remote: true,
            current: true,
            checkedOutPath: "/Users/test/repository",
          },
        ],
        branchesTruncated: false,
        stashes: [
          {
            oid,
            selector: "stash@{0}",
            message: "WIP on main",
            createdAt: new Date(0).toISOString(),
          },
        ],
        stashesTruncated: false,
      }),
    ).toMatchObject({ dirty: true, branches: [{ name: "main" }] });
    expect(
      parseCodebaseStashDiff({
        oid,
        patch: "diff --git a/a b/a\n",
        truncated: false,
      }),
    ).toMatchObject({ oid, truncated: false });
  });
});
