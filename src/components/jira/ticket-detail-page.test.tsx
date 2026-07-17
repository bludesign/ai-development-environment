import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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
  issueLinks: [
    {
      relationship: "blocks",
      key: "APP-41",
      summary: "Prepare the release",
      status: "Done",
    },
  ],
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
        return {
          jiraTicketEditFields: [
            {
              id: "description",
              name: "Description",
              required: false,
              schemaType: "doc",
              allowedValues: [],
            },
          ],
        } as never;
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
    const detailsCard = screen
      .getByText("Details")
      .closest('[data-slot="card"]');
    const relatedCard = screen
      .getByText("Related issues")
      .closest('[data-slot="card"]');
    const descriptionCard = screen
      .getByText("Description")
      .closest('[data-slot="card"]');
    expect(detailsCard?.parentElement).toBe(relatedCard?.parentElement);
    expect(detailsCard?.parentElement?.className).toContain("lg:grid-cols-2");
    expect(
      detailsCard?.parentElement?.compareDocumentPosition(descriptionCard!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      screen.getByRole("link", { name: /APP-41/ }).getAttribute("href"),
    ).toBe("/jira/tickets/APP-41");
    expect(screen.getByText("Customer impact")).toBeDefined();
    expect(screen.getByText("High impact")).toBeDefined();
    const descriptionTitle = screen.getByText("Description");
    const descriptionRaw = screen.getAllByRole("button", {
      name: "Raw",
    })[0];
    expect(descriptionTitle.parentElement?.parentElement).toBe(
      descriptionRaw?.parentElement?.parentElement,
    );
    const descriptionEdit = within(descriptionCard as HTMLElement).getByRole(
      "button",
      { name: "Edit" },
    );
    expect(descriptionEdit.getAttribute("data-size")).toBe("xs");
    expect(descriptionEdit.getAttribute("data-variant")).toBe("outline");
    const fieldsTable = screen.getByText("Customer impact").closest("table");
    expect(fieldsTable?.className).toContain("table-fixed");
    expect(fieldsTable?.parentElement?.className).toContain(
      "overflow-x-hidden",
    );
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
