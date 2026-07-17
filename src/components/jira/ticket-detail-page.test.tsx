import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { JiraTicketDetail } from "@/services/jira/types";

import { JiraTicketDetailPage } from "./ticket-detail-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("./ticket-worktree-dialog", () => ({
  TicketWorktreeDialog: () => null,
}));

const request = vi.mocked(controlPlaneRequest);

const ticket = {
  id: "10001",
  key: "APP-42",
  summary: "Ship rich Jira details",
  statusId: "doing",
  status: "In Progress",
  statusCategory: "indeterminate",
  issueType: "Story",
  priority: "High",
  assignee: "Ada",
  assigneeAccountId: "ada",
  assigneeAvatarUrl: null,
  projectKey: "APP",
  updatedAt: "2026-07-17T12:00:00.000Z",
  jiraUrl: "https://example.atlassian.net/browse/APP-42",
  description: "## Deployment",
  descriptionContent: {
    format: "MARKDOWN",
    raw: "## Deployment",
    rawText: "## Deployment",
    markdown: "## Deployment",
    wikiMarkup: "h2. Deployment",
  },
  reporter: null,
  creator: null,
  labels: ["release"],
  components: [],
  fixVersions: [],
  affectedVersions: [],
  sprintNames: [],
  parent: null,
  subtasks: [],
  issueLinks: [],
  attachments: [],
  comments: [],
  createdAt: "2026-07-16T12:00:00.000Z",
  dueAt: null,
  resolvedAt: null,
  timeTracking: null,
  allFields: [
    {
      id: "customfield_10001",
      name: "Customer impact",
      schemaType: "string",
      custom: true,
      value: "High impact",
      content: null,
    },
  ],
  cache: {
    source: "LIVE",
    stale: false,
    fetchedAt: "2026-07-17T12:00:00.000Z",
  },
  commentsCache: {
    source: "LIVE",
    stale: false,
    fetchedAt: "2026-07-17T12:00:00.000Z",
  },
} satisfies JiraTicketDetail;

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("JiraTicketDetailPage", () => {
  test("shows full fields and loads history independently", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query JiraTicketDetail"))
        return { jiraTicket: ticket } as never;
      if (query.includes("query JiraTicketEditFields"))
        return { jiraTicketEditFields: [] } as never;
      if (query.includes("query JiraTicketTransitions"))
        return { jiraTicketTransitions: [] } as never;
      if (query.includes("query JiraTicketChanges")) {
        return {
          jiraTicketChanges: {
            items: [
              {
                id: "change-1",
                author: {
                  accountId: "ada",
                  displayName: "Ada",
                  avatarUrl: null,
                },
                createdAt: "2026-07-17T12:00:00.000Z",
                items: [
                  {
                    field: "Status",
                    fieldId: "status",
                    from: "To Do",
                    to: "In Progress",
                  },
                ],
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
            cache: ticket.cache,
          },
        } as never;
      }
      return {} as never;
    });

    render(<JiraTicketDetailPage issueKey="APP-42" />);

    expect(await screen.findByText("Ship rich Jira details")).toBeDefined();
    expect(screen.getByText("Customer impact")).toBeDefined();
    expect(screen.getByText("High impact")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(
      await screen.findByText(
        (_text, element) =>
          element?.tagName === "LI" &&
          Boolean(element.textContent?.includes("To Do → In Progress")),
      ),
    ).toBeDefined();
  });
});
