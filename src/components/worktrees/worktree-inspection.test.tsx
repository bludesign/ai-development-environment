import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";

import { useLiveWorktree, type WorktreeActivity } from "./worktree-inspection";
import type { Worktree, WorktreeCodebaseGroup } from "./types";

const source = {
  branch: "release/1",
  headSha: "abc",
  updatedAt: "2026-11-04T12:00:00Z",
  isDefaultBranch: true,
  defaultBranchUpdateEnabled: true,
  defaultBranchUpdatePaused: false,
  hasStagedChanges: false,
  hasUnstagedChanges: false,
  hasConflicts: false,
  rebaseInProgress: false,
  pushStatus: "READY",
  availability: "AVAILABLE",
  missingAt: null,
} as Worktree;
const group = {
  repository: {
    defaultBranchPatterns: ["release/*"],
    keepBaseBranchUpToDate: true,
  },
  codebase: {
    defaultBranch: "main",
    remoteBranches: ["main", "release/1"],
    availability: "AVAILABLE",
  },
} as WorktreeCodebaseGroup;
const agent = {
  capabilities: ["codebase.default-branches.v1"],
  connectionStatus: "ONLINE" as const,
};

test("live branch changes immediately restore ordinary controls and default maintenance eligibility", () => {
  const { result } = renderHook(() => useLiveWorktree(source, group, agent));
  const report = (branch: string) =>
    ({
      branch,
      headSha: "def",
      hasStagedChanges: false,
      hasUnstagedChanges: false,
      hasConflicts: false,
      rebaseInProgress: false,
      pushStatus: "READY",
    }) as WorktreeActivity;
  act(() => result.current.applyActivity(report("feature/search")));
  expect(result.current.worktree).toMatchObject({
    branch: "feature/search",
    isDefaultBranch: false,
    defaultBranchUpdateEnabled: false,
    defaultBranchUpdatePaused: false,
  });
  expect(source.isDefaultBranch).toBe(true);
  act(() => result.current.applyActivity(report("release/1")));
  expect(result.current.worktree).toMatchObject({
    isDefaultBranch: true,
    defaultBranchUpdateEnabled: true,
    defaultBranchUpdatePaused: false,
  });
});

test("local inspection pauses and resumes default maintenance before an overview refresh", () => {
  const { result } = renderHook(() => useLiveWorktree(source, group, agent));
  act(() => result.current.setUnstagedChanges(true));
  expect(result.current.worktree.defaultBranchUpdatePaused).toBe(true);
  act(() => result.current.setUnstagedChanges(false));
  expect(result.current.worktree.defaultBranchUpdatePaused).toBe(false);
});
