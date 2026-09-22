import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CodebaseSnapshot } from "@ai-development-environment/agent-contract/codebases";

vi.mock("./handlers/worktrees.js", () => ({ discoverWorktrees: vi.fn() }));

import { discoverWorktrees } from "./handlers/worktrees.js";
import { refreshFetchedCodebase } from "./refresh-fetched-codebase.js";

const snapshot: CodebaseSnapshot = {
  folder: "/repo",
  observedOrigin: "git@example.com:team/repo.git",
  canonicalOrigin: "example.com/team/repo",
  displayOrigin: "example.com/team/repo",
  branch: "main",
  headSha: "abc",
  upstream: "origin/main",
  ahead: 0,
  behind: 2,
  syncState: "BEHIND",
  availability: "AVAILABLE",
  error: null,
  checkedAt: new Date(20).toISOString(),
  fetchedAt: new Date(10).toISOString(),
  linkedWorktree: false,
};
const input = {
  codebaseId: "codebase-1",
  snapshot,
  fetchAttemptedAt: new Date(5).toISOString(),
  fetchError: null,
};
const inventory = {
  complete: true,
  defaultBranch: "main",
  localBranches: ["main", "feature"],
  remoteBranches: ["main", "new-remote-branch"],
  worktrees: [],
};

function client() {
  return {
    agentCodebases: vi.fn().mockResolvedValue([
      {
        id: input.codebaseId,
        defaultBranch: "main",
        worktrees: [
          { gitDirectory: "/repo/.git", baseBranchOverride: null },
          {
            gitDirectory: "/repo/.git/worktrees/feature",
            baseBranchOverride: "release",
          },
        ],
      },
    ]),
    reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
    reportWorktrees: vi.fn().mockResolvedValue({}),
  };
}

describe("refreshFetchedCodebase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverWorktrees).mockResolvedValue(inventory);
  });

  test("preserves base overrides and waits for both persisted reports", async () => {
    const api = client();
    const statusReport = Promise.withResolvers<unknown>();
    const statusStarted = Promise.withResolvers<void>();
    const worktreeReport = Promise.withResolvers<unknown>();
    const worktreeStarted = Promise.withResolvers<void>();
    api.reportCodebaseStatuses.mockImplementation(() => {
      statusStarted.resolve();
      return statusReport.promise;
    });
    api.reportWorktrees.mockImplementation(() => {
      worktreeStarted.resolve();
      return worktreeReport.promise;
    });
    const signal = new AbortController().signal;
    let settled = false;
    const pending = refreshFetchedCodebase(api, input, 300_000, signal).then(
      (value) => {
        settled = true;
        return value;
      },
    );

    await statusStarted.promise;
    expect(api.reportWorktrees).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(discoverWorktrees).toHaveBeenCalledWith(
      "/repo",
      new Map([
        ["/repo/.git", null],
        ["/repo/.git/worktrees/feature", "release"],
      ]),
      "main",
      30_000,
      signal,
    );
    statusReport.resolve({});
    await worktreeStarted.promise;
    expect(settled).toBe(false);
    expect(api.reportCodebaseStatuses).toHaveBeenCalledWith([
      { codebaseId: input.codebaseId, snapshot },
    ]);
    expect(api.reportWorktrees).toHaveBeenCalledWith([
      {
        ...inventory,
        codebaseId: input.codebaseId,
        fetchedAt: snapshot.fetchedAt,
        fetchAttemptedAt: input.fetchAttemptedAt,
        fetchError: null,
      },
    ]);
    worktreeReport.resolve({});
    expect(Number.isNaN(Date.parse(await pending))).toBe(false);
  });

  test("does not claim success for an incomplete inventory", async () => {
    const api = client();
    vi.mocked(discoverWorktrees).mockResolvedValue({
      ...inventory,
      complete: false,
    });
    await expect(
      refreshFetchedCodebase(api, input, 30_000, new AbortController().signal),
    ).rejects.toThrow("Worktree inventory refresh was incomplete");
    expect(api.reportWorktrees).not.toHaveBeenCalled();
  });

  test("propagates reporting failures instead of returning a freshness marker", async () => {
    const api = client();
    api.reportWorktrees.mockRejectedValue(new Error("HTTP 503"));
    await expect(
      refreshFetchedCodebase(api, input, 30_000, new AbortController().signal),
    ).rejects.toThrow("HTTP 503");
  });

  test("does not persist inventory if discovery was cancelled", async () => {
    const api = client();
    const controller = new AbortController();
    vi.mocked(discoverWorktrees).mockImplementation(async () => {
      controller.abort();
      return inventory;
    });
    await expect(
      refreshFetchedCodebase(api, input, 30_000, controller.signal),
    ).rejects.toThrow();
    expect(api.reportCodebaseStatuses).not.toHaveBeenCalled();
    expect(api.reportWorktrees).not.toHaveBeenCalled();
  });
});
