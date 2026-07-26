import { describe, expect, test, vi } from "vitest";

import {
  filterJiraTicketBoard,
  normalizeJiraSiteUrl,
  parseJiraBoardUrl,
  stableStringify,
  JiraService,
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

describe("Jira workflow events", () => {
  const ticket = (assigneeAccountId: string | null) => ({
    key: "APP-1",
    summary: "Ticket",
    issueType: "Task",
    status: "In Progress",
    statusId: "doing",
    statusCategory: "indeterminate",
    assignee: assigneeAccountId,
    assigneeAccountId,
    labels: [],
    sprintNames: [],
    activeSprintNames: [],
    closedSprintNames: [],
    jiraUrl: "https://example.atlassian.net/browse/APP-1",
    comments: [],
    cache: { fetchedAt: "2026-07-24T12:00:00.000Z" },
  });

  test("emits assigned-self only for the current Jira account", async () => {
    const record = vi.fn().mockResolvedValue({});
    const service = new JiraService(undefined, { record } as never);
    const runtime = service as unknown as Record<string, unknown>;
    runtime.currentAccountId = vi.fn().mockResolvedValue("me");
    const recordTicketWorkflowEvents = runtime.recordTicketWorkflowEvents as (
      value: unknown,
    ) => Promise<void>;

    await recordTicketWorkflowEvents.call(service, ticket("other"));
    expect(record.mock.calls.map(([input]) => input.kind)).not.toContain(
      "JIRA_ASSIGNED_SELF",
    );

    record.mockClear();
    await recordTicketWorkflowEvents.call(service, ticket("me"));
    expect(record.mock.calls.map(([input]) => input.kind)).toContain(
      "JIRA_ASSIGNED_SELF",
    );
  });

  test("tracks active and closed sprint state independently", async () => {
    const record = vi.fn().mockResolvedValue({});
    const service = new JiraService(undefined, { record } as never);
    const runtime = service as unknown as Record<string, unknown>;
    runtime.currentAccountId = vi.fn().mockResolvedValue(null);
    const recordTicketWorkflowEvents = runtime.recordTicketWorkflowEvents as (
      value: unknown,
    ) => Promise<void>;

    await recordTicketWorkflowEvents.call(service, {
      ...ticket(null),
      sprintNames: ["Sprint 1", "Sprint 0"],
      activeSprintNames: ["Sprint 1"],
      closedSprintNames: ["Sprint 0"],
    });

    const event = (kind: string) =>
      record.mock.calls.find(([input]) => input.kind === kind)?.[0];
    expect(event("JIRA_SPRINT_STARTED")?.payload.cursorValue).toEqual([
      "Sprint 1",
    ]);
    expect(event("JIRA_SPRINT_ENDED")?.payload.cursorValue).toEqual([
      "Sprint 0",
    ]);
  });
});
