import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { WorktreeBranchForm } from "./worktree-branch-form";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const target = {
  codebaseId: "codebase-1",
  defaultBranch: "main",
  currentBranch: null,
  currentBaseBranch: null,
  localBranches: ["main", "feature/local"],
  remoteBranches: ["main", "feature/remote"],
  unavailableBranches: [],
};

afterEach(() => {
  cleanup();
  request.mockReset();
  document.cookie = "worktree-branch-mode=; Max-Age=0; Path=/";
});

describe("WorktreeBranchForm", () => {
  test("remembers the selected tab in a shared cookie", () => {
    render(
      <WorktreeBranchForm
        busy={false}
        onSubmit={vi.fn()}
        submitLabel="Create worktree"
        target={target}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "From ticket" }));
    expect(document.cookie).toContain("worktree-branch-mode=TICKET");
  });

  test("fetches and displays a ticket branch preview", async () => {
    request.mockResolvedValue({
      previewWorktreeTicketBranch: {
        ticketKey: "APP-123",
        ticketTitle: "Add search",
        ticketType: "Story",
        projectKey: "APP",
        branchName: "feature/APP-123-add-search",
      },
    } as never);
    render(
      <WorktreeBranchForm
        busy={false}
        onSubmit={vi.fn()}
        submitLabel="Create worktree"
        target={target}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "From ticket" }));
    fireEvent.change(screen.getByLabelText("Ticket key"), {
      target: { value: "app-123" },
    });
    const previewTitle = await screen.findByText(
      "Add search",
      {},
      { timeout: 2_000 },
    );
    expect(previewTitle.closest('[data-slot="item"]')).not.toBeNull();
    expect(screen.getByText("feature/APP-123-add-search")).toBeDefined();
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("PreviewWorktreeTicketBranch"),
      {
        input: {
          codebaseId: "codebase-1",
          worktreeId: null,
          ticketKey: "APP-123",
        },
      },
    );
  });
});
