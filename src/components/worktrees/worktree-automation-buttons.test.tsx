import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Worktree } from "./types";
import { AutoMergeButton } from "./worktree-automation-buttons";

vi.mock("@/components/github/merge-pull-request-button", () => ({
  MergePullRequestButton: () => <button type="button">Manual merge</button>,
}));

afterEach(cleanup);

function worktreeForLaterPullRequest(
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN",
): Worktree {
  return {
    id: "worktree-1",
    primary: true,
    pullRequest: {
      number: 18,
      repositoryNameWithOwner: "acme/widgets",
      state: "OPEN",
      isDraft: false,
      mergeable,
      mergeStateStatus: mergeable === "MERGEABLE" ? "CLEAN" : "BLOCKED",
    },
    autoMerge: {
      worktreeId: "worktree-1",
      state: "COMPLETED",
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 17,
      mergeMethod: "SQUASH",
      commitHeadline: "Previous pull request",
      commitBody: "",
      authorEmail: null,
      deleteWorktree: false,
      moveTicketToDone: false,
      ticketKey: null,
      lastError: null,
      updatedAt: new Date(0).toISOString(),
    },
  } as Worktree;
}

describe("AutoMergeButton", () => {
  test("allows a later directly mergeable pull request to be merged manually", () => {
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktreeForLaterPullRequest("MERGEABLE")}
      />,
    );

    expect(screen.getByRole("button", { name: "Manual merge" })).toBeDefined();
  });

  test("allows Auto Merge to be configured for a later blocked pull request", () => {
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktreeForLaterPullRequest("UNKNOWN")}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Auto Merge" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
