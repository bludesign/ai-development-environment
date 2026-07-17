import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  assigneeAvatarUrl: "https://example.com/ada.png",
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
  reporter: {
    accountId: "grace",
    displayName: "Grace Hopper",
    avatarUrl: "https://example.com/grace.png",
  },
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
      content: {
        format: "MARKDOWN",
        raw: "High impact",
        rawText: "High impact",
        markdown: "High impact",
        wikiMarkup: "High impact",
      },
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
            {
              id: "duedate",
              name: "Due date",
              required: false,
              schemaType: "date",
              allowedValues: [],
            },
          ],
        } as never;
      if (query.includes("query JiraTicketTransitions"))
        return { jiraTicketTransitions: [] } as never;
      if (query.includes("query JiraAssignableUsers"))
        return {
          jiraAssignableUsers: [
            {
              accountId: "grace",
              displayName: "Grace Hopper",
              avatarUrl: "https://example.com/grace.png",
            },
          ],
        } as never;
      if (query.includes("query JiraTicketChanges")) {
        return {
          jiraTicketChanges: {
            items: [
              {
                id: "change-1",
                author: {
                  accountId: "ada",
                  displayName: "Ada",
                  avatarUrl: "https://example.com/ada.png",
                },
                createdAt: "2026-07-17T12:00:00.000Z",
                items: [
                  {
                    field: "Status",
                    fieldId: "status",
                    from: "To Do",
                    to: "In Progress",
                  },
                  {
                    field: "Description",
                    fieldId: "description",
                    from: "## Earlier deployment",
                    to: "## Deployment",
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
    expect(detailsCard?.querySelectorAll('[data-slot="avatar"]')).toHaveLength(
      2,
    );
    expect(detailsCard?.parentElement?.className).toContain("lg:grid-cols-2");
    expect(
      detailsCard?.parentElement?.compareDocumentPosition(descriptionCard!),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const relatedIssueLink = screen.getByRole("link", { name: /APP-41/ });
    expect(relatedIssueLink.getAttribute("href")).toBe("/jira/tickets/APP-41");
    expect(relatedIssueLink.className).toContain("leading-tight");
    expect(screen.queryByText("Customer impact")).toBeNull();
    const fieldsTitle = screen.getByRole("button", {
      name: "All Jira fields",
    });
    const fieldsHeader = fieldsTitle.closest('[data-slot="card-header"]');
    expect(fieldsTitle.getAttribute("aria-expanded")).toBe("false");
    expect(fieldsHeader?.classList.contains("border-b")).toBe(false);
    fireEvent.click(fieldsTitle);
    expect(fieldsTitle.getAttribute("aria-expanded")).toBe("true");
    expect(fieldsHeader?.classList.contains("border-b")).toBe(true);
    const collapseFields = screen.getByRole("button", {
      name: "Hide fields",
    });
    const fieldSearch = screen.getByRole("textbox", { name: "Search fields" });
    expect(collapseFields.getAttribute("data-variant")).toBe("ghost");
    expect(collapseFields.getAttribute("data-size")).toBe("icon-sm");
    expect(collapseFields.textContent).toBe("");
    expect(fieldSearch.parentElement).toBe(collapseFields.parentElement);
    expect(fieldSearch.compareDocumentPosition(collapseFields)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      screen
        .getByRole("button", { name: "Hide fields" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText("Customer impact")).toBeDefined();
    expect(screen.getByText("High impact")).toBeDefined();
    const activityHeader = screen
      .getByText("Activity")
      .closest('[data-slot="card-header"]');
    expect(
      screen
        .getByRole("tab", { name: "History" })
        .closest('[data-slot="card-header"]'),
    ).toBe(activityHeader);
    const descriptionTitle = screen.getByText("Description");
    const descriptionViewMenu = screen.getAllByRole("button", {
      name: "Rendered",
    })[0];
    expect(descriptionTitle.parentElement?.parentElement).toBe(
      descriptionViewMenu?.parentElement?.parentElement?.parentElement,
    );
    expect(
      within(descriptionCard as HTMLElement).getByRole("button", {
        name: "Description history",
      }),
    ).toBeDefined();
    fireEvent.pointerDown(descriptionViewMenu!, {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Markdown" }));
    const markdownSource = screen.getByText("## Deployment");
    expect(markdownSource.className).toContain("max-h-none");
    expect(markdownSource.className).toContain("overflow-visible");
    expect(markdownSource.className).not.toContain("max-h-96");
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
    expect(
      within(fieldsTable as HTMLElement).queryByRole("combobox", {
        name: "Render format",
      }),
    ).toBeNull();
    fireEvent.click(fieldsTitle);
    expect(fieldsTitle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Customer impact")).toBeNull();
    expect(fieldsHeader?.classList.contains("border-b")).toBe(false);
    expect(screen.getByRole("textbox", { name: "Comment" })).toBeDefined();

    const assigneeTrigger = screen.getByRole("combobox", {
      name: "Change assignee",
    });
    expect(
      assigneeTrigger.querySelector('[data-slot="avatar"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    const historyItem = await screen.findByText(
      (_text, element) =>
        element?.tagName === "LI" &&
        Boolean(element.textContent?.includes("To Do → In Progress")),
    );
    expect(historyItem).toBeDefined();
    expect(
      historyItem
        .closest('[data-slot="card"]')
        ?.querySelector('[data-slot="avatar"]'),
    ).not.toBeNull();

    fireEvent.click(
      within(detailsCard as HTMLElement).getByRole("button", { name: "Edit" }),
    );
    const dueDatePicker = await screen.findByRole("button", {
      name: "Choose a date",
    });
    expect(dueDatePicker.getAttribute("data-variant")).toBe("outline");
    expect(dueDatePicker.querySelector(".lucide-calendar-days")).not.toBeNull();
    expect(document.querySelector('input[type="date"]')).toBeNull();
  });

  test("clears an optional description with a null update", async () => {
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
      if (query.includes("query JiraAssignableUsers"))
        return { jiraAssignableUsers: [] } as never;
      if (query.includes("mutation UpdateJiraTicket"))
        return {
          updateJiraTicket: {
            ...ticket,
            description: null,
            descriptionContent: null,
          },
        } as never;
      return {} as never;
    });

    render(<JiraTicketDetailPage issueKey="APP-42" />);
    const descriptionCard = (await screen.findByText("Description")).closest(
      '[data-slot="card"]',
    ) as HTMLElement;
    fireEvent.click(
      within(descriptionCard).getByRole("button", { name: "Edit" }),
    );
    fireEvent.change(
      within(descriptionCard).getByRole("textbox", { name: "Comment" }),
      { target: { value: "" } },
    );
    const save = within(descriptionCard).getByRole("button", {
      name: "Save description",
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation UpdateJiraTicket"),
        {
          input: { issueKey: "APP-42", description: null },
        },
      ),
    );
  });
});
