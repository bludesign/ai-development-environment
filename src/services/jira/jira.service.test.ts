import { describe, expect, test } from "vitest";

import {
  filterJiraTicketBoard,
  normalizeJiraSiteUrl,
  parseJiraBoardUrl,
  stableStringify,
} from "./jira.service";
import type { JiraTicketBoard } from "./types";

describe("Jira service input helpers", () => {
  test("normalizes one Jira Cloud origin", () => {
    expect(normalizeJiraSiteUrl(" https://example.atlassian.net/path ")).toBe(
      "https://example.atlassian.net",
    );
  });

  test("rejects insecure and non-Cloud Jira hosts", () => {
    expect(() => normalizeJiraSiteUrl("http://example.atlassian.net")).toThrow(
      "HTTPS",
    );
    expect(() => normalizeJiraSiteUrl("https://jira.example.com")).toThrow(
      "Jira Cloud",
    );
  });

  test("extracts modern and legacy board IDs and enforces the site origin", () => {
    expect(
      parseJiraBoardUrl(
        "https://example.atlassian.net/jira/software/c/projects/APP/boards/42",
        "https://example.atlassian.net",
      ).boardId,
    ).toBe(42);
    expect(
      parseJiraBoardUrl(
        "https://example.atlassian.net/secure/RapidBoard.jspa?rapidView=73",
        "https://example.atlassian.net",
      ).boardId,
    ).toBe(73);
    expect(() =>
      parseJiraBoardUrl(
        "https://other.atlassian.net/jira/software/c/projects/APP/boards/42",
        "https://example.atlassian.net",
      ),
    ).toThrow("configured Jira site");
  });

  test("canonicalizes nested cache-key input", () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  test("applies assignment and project-specific completed status filters", () => {
    const ticket = (
      key: string,
      statusId: string,
      status: string,
      statusCategory: string,
      assigneeAccountId: string | null,
    ) => ({
      id: key,
      key,
      summary: key,
      statusId,
      status,
      statusCategory,
      issueType: null,
      priority: null,
      assignee: assigneeAccountId,
      assigneeAccountId,
      assigneeAvatarUrl: null,
      projectKey: "APP",
      updatedAt: null,
    });
    const board: JiraTicketBoard = {
      source: {
        id: "source-1",
        projectId: "project-1",
        name: "All",
        kind: "JQL",
        value: "project = APP",
        boardId: null,
        position: 0,
      },
      tickets: [
        ticket("APP-1", "todo", "To Do", "new", null),
        ticket("APP-2", "doing", "In Progress", "indeterminate", "me"),
        ticket("APP-3", "doing", "In Progress", "indeterminate", "other"),
        ticket("APP-4", "done", "Released", "done", "me"),
      ],
      statusOrder: ["To Do", "In Progress", "Released"],
      cache: {
        source: "CACHE",
        stale: false,
        fetchedAt: new Date(0).toISOString(),
      },
      truncated: false,
      warnings: [],
    };

    expect(
      filterJiraTicketBoard(
        board,
        {
          ticketAssignmentFilter: "UNASSIGNED_OR_SELF",
          hideCompletedTickets: true,
          completedStatusIds: ["done"],
        },
        "me",
      ),
    ).toMatchObject({
      tickets: [{ key: "APP-1" }, { key: "APP-2" }],
      statusOrder: ["To Do", "In Progress"],
    });
    expect(
      filterJiraTicketBoard(
        board,
        {
          ticketAssignmentFilter: "SELF_IN_PROGRESS",
          hideCompletedTickets: false,
          completedStatusIds: [],
        },
        "me",
      ).tickets.map((item) => item.key),
    ).toEqual(["APP-2"]);
  });
});
