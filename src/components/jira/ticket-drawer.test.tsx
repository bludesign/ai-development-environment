import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { JiraTicketDrawer } from "./ticket-drawer";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("./ticket-worktree-dialog", () => ({
  TicketWorktreeDialog: ({
    issueKey,
    open,
  }: {
    issueKey: string;
    open: boolean;
  }) => (open ? <div>Ticket worktree popup for {issueKey}</div> : null),
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  request.mockReset();
});

describe("JiraTicketDrawer", () => {
  test("opens the ticket worktree popup from the sidebar action", async () => {
    request.mockResolvedValue({
      jiraTicket: {
        id: "10001",
        key: "APP-123",
        summary: "Add searchable worktrees",
        statusId: "1",
        status: "In Progress",
        statusCategory: "indeterminate",
        issueType: "Story",
        priority: "High",
        assignee: null,
        assigneeAccountId: null,
        assigneeAvatarUrl: null,
        projectKey: "APP",
        updatedAt: "2026-07-16T12:00:00.000Z",
        jiraUrl: "https://example.atlassian.net/browse/APP-123",
        description: null,
        reporter: null,
        creator: null,
        labels: [],
        components: [],
        fixVersions: [],
        affectedVersions: [],
        sprintNames: [],
        parent: null,
        subtasks: [],
        issueLinks: [],
        attachments: [],
        comments: [],
        createdAt: "2026-07-15T12:00:00.000Z",
        dueAt: null,
        resolvedAt: null,
        timeTracking: null,
        cache: {
          source: "LIVE",
          stale: false,
          fetchedAt: "2026-07-16T12:00:00.000Z",
        },
        commentsCache: {
          source: "LIVE",
          stale: false,
          fetchedAt: "2026-07-16T12:00:00.000Z",
        },
      },
    } as never);

    render(<JiraTicketDrawer issueKey="APP-123" onClose={vi.fn()} />);

    expect(
      await screen.findByRole("button", {
        name: "Create branch or worktree",
      }),
    ).toBeDefined();
    expect(screen.queryByText(/Ticket worktree popup/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Create branch or worktree" }),
    );
    expect(
      await screen.findByText("Ticket worktree popup for APP-123"),
    ).toBeDefined();
  });
});
