import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
        assignee: "Ada",
        assigneeAccountId: "ada",
        assigneeAvatarUrl: "https://example.com/ada.png",
        projectKey: "APP",
        updatedAt: "2026-07-16T12:00:00.000Z",
        jiraUrl: "https://example.atlassian.net/browse/APP-123",
        description: "Ticket details",
        reporter: {
          accountId: "grace",
          displayName: "Grace Hopper",
          avatarUrl: "https://example.com/grace.png",
        },
        creator: null,
        labels: [],
        components: [],
        fixVersions: [],
        affectedVersions: [],
        sprintNames: [],
        parent: null,
        subtasks: [],
        issueLinks: [
          {
            relationship: "blocks",
            key: "APP-122",
            summary: "Prepare the repository",
            status: "Done",
          },
        ],
        attachments: [
          {
            id: "attachment-1",
            filename: "notes.txt",
            contentUrl: "https://example.atlassian.net/notes.txt",
            mimeType: "text/plain",
            size: 2048,
            author: null,
            createdAt: "2026-07-16T12:00:00.000Z",
          },
        ],
        comments: [
          {
            id: "comment-1",
            author: {
              accountId: "reviewer-1",
              displayName: "Reviewer",
              avatarUrl: "https://example.com/reviewer.png",
            },
            body: "Looks good",
            createdAt: "2026-07-16T12:00:00.000Z",
            updatedAt: "2026-07-16T12:00:00.000Z",
          },
        ],
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

    const createWorktree = await screen.findByRole("button", {
      name: "Create worktree",
    });
    const openInJira = screen.getByRole("link", { name: "Open in Jira" });
    expect(
      screen
        .getByRole("link", { name: "Open full details" })
        .getAttribute("href"),
    ).toBe("/jira/tickets/APP-123");
    expect(createWorktree.parentElement).toBe(openInJira.parentElement);
    expect(createWorktree.parentElement).not.toBe(
      screen.getAllByText("In Progress")[0]?.parentElement,
    );
    expect(createWorktree.getAttribute("data-variant")).toBe("outline");
    expect(openInJira.getAttribute("data-variant")).toBe("outline");
    expect(createWorktree.getAttribute("data-size")).toBe("sm");
    expect(openInJira.getAttribute("data-size")).toBe("sm");
    expect(
      screen.getByText("Ticket details").closest('[data-slot="card"]'),
    ).not.toBeNull();
    const descriptionTitle = screen.getByText("Description");
    const descriptionViewMenu = screen.getAllByRole("button", {
      name: "Rendered",
    })[0];
    expect(descriptionTitle.parentElement?.parentElement).toBe(
      descriptionViewMenu?.parentElement?.parentElement?.parentElement,
    );
    const relatedItem = screen
      .getByText("APP-122 · Prepare the repository")
      .closest('[data-slot="item"]');
    expect(relatedItem).not.toBeNull();
    expect(relatedItem?.getAttribute("data-size")).toBe("xs");
    expect(
      screen.getByText("APP-122 · Prepare the repository").className,
    ).toContain("leading-tight");
    expect(
      screen
        .getByRole("link", {
          name: /APP-122 · Prepare the repository blocks Done/,
        })
        .getAttribute("href"),
    ).toBe("/jira/tickets/APP-122");
    expect(
      screen
        .getByRole("link", { name: /notes\.txt/ })
        .closest('[data-slot="item"]'),
    ).not.toBeNull();
    expect(
      screen.getByText("Reviewer").closest('[data-slot="item"]'),
    ).not.toBeNull();
    const commentItem = screen
      .getByText("Reviewer")
      .closest('[data-slot="item"]') as HTMLElement;
    expect(commentItem.querySelector('[data-slot="avatar"]')).not.toBeNull();
    const commentDate = commentItem.querySelector("time");
    const commentActions = within(commentItem).getByRole("button", {
      name: "Comment actions",
    });
    const commentViewActions = commentActions.parentElement;
    const commentControls = commentViewActions?.parentElement;
    expect(commentDate?.parentElement).toBe(commentControls);
    expect(commentViewActions?.querySelectorAll("button")).toHaveLength(1);
    expect(commentViewActions?.className).toContain("ml-auto");
    expect(commentViewActions?.className).toContain("row-start-1");
    expect(commentDate?.className).toContain("row-start-2");
    expect(commentDate?.className).toContain("-mt-1");
    expect(commentControls?.className).toContain("contents");
    expect(commentControls?.parentElement?.className).toContain("grid");
    expect(commentControls?.parentElement?.className).toContain("gap-y-0.5");
    expect(commentControls?.parentElement?.className).toContain(
      "@md/comment:flex",
    );
    expect(
      within(commentItem).queryByRole("button", { name: "Rendered" }),
    ).toBeNull();
    expect(
      within(commentItem).queryByRole("button", { name: "Copy" }),
    ).toBeNull();
    fireEvent.pointerDown(commentActions, { button: 0, ctrlKey: false });
    expect(
      screen
        .getByRole("menuitemradio", { name: "Rendered" })
        .querySelector(".lucide-eye"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Copy" })
        .querySelector(".lucide-copy"),
    ).not.toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByText("Looks good")).toBeDefined();
    expect(
      commentItem.compareDocumentPosition(
        screen.getByRole("textbox", { name: "Comment" }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText(/Ticket worktree popup/)).toBeNull();
    fireEvent.click(createWorktree);
    expect(
      await screen.findByText("Ticket worktree popup for APP-123"),
    ).toBeDefined();
  });
});
