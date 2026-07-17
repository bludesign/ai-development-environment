import { describe, expect, test } from "vitest";

import {
  codebaseJobPayload,
  normalizeGitOrigin,
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
