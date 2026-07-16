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

afterEach(() => {
  cleanup();
  requestMock.mockReset();
  window.history.replaceState(null, "", "/");
});

describe("JiraTicketsPage", () => {
  test("loads project/source tabs, groups tickets by exact status, and refreshes", async () => {
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
          assigneeAvatarUrl: null,
          projectKey: "APP",
          updatedAt: new Date().toISOString(),
        },
      ],
      statusOrder: ["In Progress"],
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

    expect(
      await screen.findByRole("tab", { name: "APP · Application" }),
    ).toBeDefined();
    expect(await screen.findByText("In Progress")).toBeDefined();
    expect(screen.getByText("Open login screen")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RefreshJiraSource"),
        { sourceId: "source-1" },
      ),
    );
  });
});
