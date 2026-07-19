import { describe, expect, test } from "vitest";

import { buildOutOfDate } from "./build-freshness";

const worktree = {
  headSha: "head-1",
  codeStateHash: "state-1",
  hasStagedChanges: false,
  hasUnstagedChanges: false,
};

describe("buildOutOfDate", () => {
  test("compares completed builds with the current exact code state", () => {
    expect(
      buildOutOfDate({
        status: "SUCCEEDED",
        snapshotJson: JSON.stringify({
          worktree: { headSha: "head-1", codeStateHash: "state-1" },
        }),
        worktree,
      }),
    ).toBe(false);
    expect(
      buildOutOfDate({
        status: "SUCCEEDED",
        snapshotJson: JSON.stringify({
          worktree: { headSha: "head-1", codeStateHash: "older-state" },
        }),
        worktree,
      }),
    ).toBe(true);
  });

  test("never marks active builds out of date during pre-build scripts", () => {
    expect(
      buildOutOfDate({
        status: "RUNNING",
        snapshotJson: JSON.stringify({
          worktree: { headSha: "head-1", codeStateHash: "state-before-hook" },
        }),
        worktree: { ...worktree, codeStateHash: "temporary-hook-state" },
      }),
    ).toBe(false);
  });

  test("suppresses older build freshness while another build runs hooks", () => {
    expect(
      buildOutOfDate({
        status: "SUCCEEDED",
        snapshotJson: JSON.stringify({
          worktree: { headSha: "head-1", codeStateHash: "state-before-hook" },
        }),
        worktree: {
          ...worktree,
          codeStateHash: "temporary-hook-state",
          _count: { builds: 1 },
        },
      }),
    ).toBe(false);
  });

  test("waits for a stable post-build worktree observation", () => {
    const build = {
      status: "SUCCEEDED",
      finishedAt: new Date("2026-07-18T20:00:00Z"),
      snapshotJson: JSON.stringify({
        worktree: { headSha: "head-1", codeStateHash: "state-before-hook" },
      }),
    };
    expect(
      buildOutOfDate({
        ...build,
        worktree: {
          ...worktree,
          codeStateHash: "temporary-hook-state",
          lastCheckedAt: new Date("2026-07-18T19:59:59Z"),
        },
      }),
    ).toBe(false);
    expect(
      buildOutOfDate({
        ...build,
        worktree: {
          ...worktree,
          codeStateHash: "changed-after-build",
          lastCheckedAt: new Date("2026-07-18T20:00:01Z"),
        },
      }),
    ).toBe(true);
  });

  test("falls back to the captured commit and dirty state for older builds", () => {
    expect(
      buildOutOfDate({
        status: "FAILED",
        snapshotJson: JSON.stringify({
          worktree: {
            headSha: "head-1",
            hasStagedChanges: false,
            hasUnstagedChanges: false,
          },
        }),
        worktree: { ...worktree, codeStateHash: null, headSha: "head-2" },
      }),
    ).toBe(true);
  });
});
