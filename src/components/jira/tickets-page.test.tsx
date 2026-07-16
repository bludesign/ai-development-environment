import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { JiraTicketsPage } from "./tickets-page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

async function chooseSelectOption(label: string, option: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("JiraTicketsPage", () => {
  test("defaults to status tables, switches layouts, and refreshes", async () => {
    const board = {
      source: {
        id: "source-1",
        projectId: "project-1",
        name: "Current sprint",
        kind: "JQL",
        value: "project = APP",
        boardId: null,
        position: 0,
      },
      tickets: [
        {
          id: "10001",
          key: "APP-1",
          summary: "Open login screen",
          statusId: "1",
          status: "In Progress",
          statusCategory: "indeterminate",
          issueType: "Story",
          priority: "High",
          assignee: "Ada Lovelace",
          assigneeAccountId: "ada",
          assigneeAvatarUrl: null,
          projectKey: "APP",
          updatedAt: new Date().toISOString(),
        },
      ],
      statusOrder: ["In Progress", "Done"],
      cache: {
        source: "CACHE",
        stale: false,
        fetchedAt: new Date().toISOString(),
      },
      truncated: false,
      warnings: [],
    };
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query JiraProjects")) {
        return {
          jiraProjects: [
            {
              id: "project-1",
              jiraId: "10000",
              key: "APP",
              name: "Application",
              avatarUrl: null,
              position: 0,
              ticketAssignmentFilter: "ALL",
              hideCompletedTickets: false,
              completedStatusIds: [],
              sources: [board.source],
            },
          ],
        } as never;
      }
      if (query.includes("RefreshJiraSource"))
        return { refreshJiraSource: board } as never;
      if (query.includes("JiraTicketBoard"))
        return { jiraTicketBoard: board } as never;
      return { jiraAvailableProjects: [] } as never;
    });

    render(<JiraTicketsPage />);

    expect(await screen.findByRole("tab", { name: "APP" })).toBeDefined();
    expect(screen.queryByRole("tab", { name: "Current sprint" })).toBeNull();
    expect(await screen.findByText("In Progress")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();
    expect(screen.getByText("Open login screen")).toBeDefined();
    expect(screen.getAllByRole("table")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Board layout" }));
    expect(screen.queryAllByRole("table")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Table layout" }));
    expect(screen.getAllByRole("table")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RefreshJiraSource"),
        { sourceId: "source-1" },
      ),
    );

    const ticketButton = screen.getByRole("button", {
      name: /APP-1.*Open login screen/i,
    });
    ticketButton.focus();
    expect(document.activeElement).toBe(ticketButton);
    fireEvent.click(ticketButton);
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(
      "APP-1",
    );
  });

  test("adds a source to the project selected in the manager", async () => {
    const projects = [
      {
        id: "project-1",
        jiraId: "10000",
        key: "APP",
        name: "Application",
        avatarUrl: null,
        position: 0,
        ticketAssignmentFilter: "ALL",
        hideCompletedTickets: false,
        completedStatusIds: [],
        sources: [],
      },
      {
        id: "project-2",
        jiraId: "10001",
        key: "OPS",
        name: "Operations",
        avatarUrl: null,
        position: 1,
        ticketAssignmentFilter: "ALL",
        hideCompletedTickets: false,
        completedStatusIds: [],
        sources: [],
      },
    ];
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query JiraProjects"))
        return { jiraProjects: projects } as never;
      if (query.includes("jiraAvailableProjects"))
        return { jiraAvailableProjects: [] } as never;
      if (query.includes("JiraProjectStatuses"))
        return {
          jiraProjectStatuses: [
            { id: "done", name: "Released", category: "done" },
          ],
        } as never;
      if (query.includes("CreateJiraSource"))
        return { createJiraSource: projects } as never;
      if (query.includes("UpdateJiraProjectDisplaySettings"))
        return { updateJiraProjectDisplaySettings: projects } as never;
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<JiraTicketsPage />);
    await screen.findByRole("tab", { name: "APP" });
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /OPS · Operations/ }),
    );
    fireEvent.change(screen.getByLabelText("Source name"), {
      target: { value: "Operations queue" },
    });
    await chooseSelectOption("Source type", "Board URL");
    fireEvent.change(screen.getByLabelText("Board URL"), {
      target: { value: "https://example.atlassian.net/board/7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("CreateJiraSource"),
        {
          input: {
            projectId: "project-2",
            name: "Operations queue",
            kind: "BOARD",
            value: "https://example.atlassian.net/board/7",
          },
        },
      ),
    );

    await chooseSelectOption("Tickets to show", "My in-progress tickets");
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Hide completed tickets/ }),
    );
    const statusMenu = screen.getByRole("button", {
      name: "Completed statuses",
    });
    await waitFor(() =>
      expect((statusMenu as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.pointerDown(statusMenu, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: /Released/ }),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Save display settings" }),
    );

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("UpdateJiraProjectDisplaySettings"),
        {
          input: {
            projectId: "project-2",
            ticketAssignmentFilter: "SELF_IN_PROGRESS",
            hideCompletedTickets: true,
            completedStatusIds: ["done"],
          },
        },
      ),
    );
  });

  test("selects and adds an available Jira project", async () => {
    const existingProject = {
      id: "project-1",
      jiraId: "10000",
      key: "APP",
      name: "Application",
      avatarUrl: null,
      position: 0,
      ticketAssignmentFilter: "ALL",
      hideCompletedTickets: false,
      completedStatusIds: [],
      sources: [],
    };
    const addedProject = {
      ...existingProject,
      id: "project-2",
      jiraId: "10001",
      key: "OPS",
      name: "Operations",
      position: 1,
    };
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query JiraProjects"))
        return { jiraProjects: [existingProject] } as never;
      if (query.includes("jiraAvailableProjects"))
        return {
          jiraAvailableProjects: [
            {
              jiraId: addedProject.jiraId,
              key: addedProject.key,
              name: addedProject.name,
              avatarUrl: null,
            },
          ],
        } as never;
      if (query.includes("AddJiraProject"))
        return { addJiraProject: [existingProject, addedProject] } as never;
      if (query.includes("JiraProjectStatuses"))
        return { jiraProjectStatuses: [] } as never;
      throw new Error(`Unexpected query: ${query}`);
    });

    render(<JiraTicketsPage />);
    await screen.findByRole("tab", { name: "APP" });
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    await chooseSelectOption("Available Jira projects", "OPS · Operations");
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("AddJiraProject"),
        { jiraId: "10001" },
      ),
    );
  });
});
