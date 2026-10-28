import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: {
    id: "p",
    jiraId: "1",
    key: "APP",
    name: "App",
    avatarUrl: null,
    position: 0,
    ticketAssignmentFilter: "ALL",
    hideCompletedTickets: true,
    completedStatusIdsJson: '["done"]',
    excludedStatusIdsJson: '["backlog"]',
    doneStatusId: null,
    branchNamingScript: null,
    sources: [],
  },
  update: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    jiraProject: {
      update: mocks.update,
      findMany: async () => [mocks.project],
    },
  }),
}));

import { filterJiraTicketBoard, JiraService } from "./jira.service";
import type { JiraTicketBoard, JiraTicketSummary } from "./types";

beforeEach(() => {
  mocks.project.excludedStatusIdsJson = '["backlog"]';
  mocks.update.mockImplementation(async ({ data }) =>
    Object.assign(mocks.project, data),
  );
});

describe("Jira default status exclusions", () => {
  test("saves project exclusions, preserves omitted settings, and supports clearing", async () => {
    const service = new JiraService();
    const input = {
      projectId: "p",
      ticketAssignmentFilter: "ALL" as const,
      hideCompletedTickets: true,
      completedStatusIds: ["done"],
    };
    expect(
      (await service.updateProjectDisplaySettings(input))[0].excludedStatusIds,
    ).toEqual(["backlog"]);
    expect(
      (
        await service.updateProjectDisplaySettings({
          ...input,
          excludedStatusIds: [" review ", "review", "", "backlog"],
        })
      )[0].excludedStatusIds,
    ).toEqual(["review", "backlog"]);
    expect(
      (
        await service.updateProjectDisplaySettings({
          ...input,
          excludedStatusIds: [],
        })
      )[0].excludedStatusIds,
    ).toEqual([]);
  });

  test("hides configured and completed statuses by default while keeping them selectable", () => {
    const ticket = (
      id: string,
      status: string,
      account: string | null = null,
    ): JiraTicketSummary => ({
      id,
      key: id,
      summary: id,
      statusId: id,
      status,
      statusCategory: id === "done" ? "done" : "new",
      issueType: null,
      priority: null,
      assignee: account,
      assigneeAccountId: account,
      assigneeAvatarUrl: null,
      projectKey: "APP",
      updatedAt: null,
    });
    const board = {
      tickets: [
        ticket("backlog", "Backlog"),
        ticket("doing", "In Progress"),
        ticket("done", "Released"),
        ticket("other", "Other", "other-user"),
      ],
      statusOrder: ["Backlog", "In Progress", "Released", "Other"],
    } as JiraTicketBoard;
    const settings = {
      ticketAssignmentFilter: "UNASSIGNED_OR_SELF" as const,
      hideCompletedTickets: true,
      completedStatusIds: ["done"],
      excludedStatusIds: ["backlog"],
    };
    const defaults = filterJiraTicketBoard(board, settings, "me");
    expect(defaults.tickets.map((item) => item.key)).toEqual(["doing"]);
    expect(defaults.statusOrder).toEqual(["In Progress"]);
    expect(defaults.availableStatuses).toEqual([
      "Backlog",
      "In Progress",
      "Released",
    ]);
    expect(
      filterJiraTicketBoard(board, settings, "me", "Released").tickets.map(
        (item) => item.key,
      ),
    ).toEqual(["done"]);
    expect(
      filterJiraTicketBoard(board, settings, "me", "Backlog").tickets.map(
        (item) => item.key,
      ),
    ).toEqual(["backlog"]);
    expect(
      filterJiraTicketBoard(board, settings, "me", "Other").tickets,
    ).toEqual([]);
    expect(
      filterJiraTicketBoard(
        board,
        { ...settings, hideCompletedTickets: false },
        "me",
      ).tickets.map((item) => item.key),
    ).toEqual(["doing", "done"]);
  });
});
