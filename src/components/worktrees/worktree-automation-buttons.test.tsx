import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { Worktree } from "./types";
import { AutoMergeButton, AutoSyncButton } from "./worktree-automation-buttons";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("./worktree-jobs", () => ({
  waitForWorktreeJob: vi.fn(async () => undefined),
}));

vi.mock("@/components/github/merge-pull-request-button", () => ({
  MergePullRequestButton: () => <button type="button">Manual merge</button>,
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

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

describe("AutoSyncButton", () => {
  test("offers a confirmed force retry only for preparation conflicts", async () => {
    const worktree = {
      id: "worktree-1",
      autoSync: {
        worktreeId: "worktree-1",
        state: "PAUSED",
        conflictWorkflowId: null,
        conflictWorkflowChoice: null,
        lastError: "Repository preparations block the rebase: .env.local",
        pauseReason: "PREPARATION_CONFLICT",
        lastSyncedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    } as Worktree;
    request.mockResolvedValue({
      forceWorktreeAutoSync: { id: "job-1" },
    } as never);

    render(
      <AutoSyncButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn(async () => undefined)}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Auto Sync paused" }));
    expect(await screen.findByText(/\.env\.local/)).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Force Sync and reapply" }),
    );
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Force Sync" }));

    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("mutation ForceWorktreeAutoSync"),
        ),
      ).toBe(true),
    );
  });

  test("does not expose force sync for other pause reasons", async () => {
    const worktree = {
      id: "worktree-1",
      autoSync: {
        worktreeId: "worktree-1",
        state: "PAUSED",
        conflictWorkflowId: null,
        conflictWorkflowChoice: null,
        lastError: "The worktree branch changed",
        pauseReason: "BRANCH_CHANGED",
        lastSyncedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    } as Worktree;

    render(
      <AutoSyncButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn(async () => undefined)}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Auto Sync paused" }));
    expect(
      screen.queryByRole("button", { name: "Force Sync and reapply" }),
    ).toBeNull();
  });
});
