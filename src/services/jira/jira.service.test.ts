import { describe, expect, test, vi } from "vitest";

import {
  filterJiraTicketBoard,
  normalizeJiraSiteUrl,
  parseJiraBoardUrl,
  stableStringify,
  JiraService,
} from "./jira.service";
import type { JiraSourceView, JiraTicketBoard } from "./types";

type SourceLoaderHarness = {
  getClients: ReturnType<typeof vi.fn>;
  cachedCall: ReturnType<typeof vi.fn>;
  storeSummaries: ReturnType<typeof vi.fn>;
  loadJqlSource(
    source: JiraSourceView,
    force: boolean,
  ): Promise<JiraTicketBoard>;
  loadBoardSource(
    source: JiraSourceView,
    force: boolean,
  ): Promise<JiraTicketBoard>;
};

function sourceLoaderHarness(service: JiraService): SourceLoaderHarness {
  const runtime = service as unknown as SourceLoaderHarness;
  let entry = 0;
  runtime.cachedCall = vi.fn(
    async (input: { fetcher: () => Promise<unknown> }) => ({
      value: await input.fetcher(),
      source: "LIVE",
      stale: false,
      fetchedAt: new Date("2026-08-18T12:00:00.000Z"),
      entryId: `entry-${++entry}`,
    }),
  );
  runtime.storeSummaries = vi.fn().mockResolvedValue(undefined);
  return runtime;
}

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

  test("uses webhook changelog fields to emit only relevant workflow events", async () => {
    const record = vi.fn().mockResolvedValue({});
    const service = new JiraService(undefined, { record } as never);
    const runtime = service as unknown as Record<string, unknown>;
    runtime.currentAccountId = vi.fn().mockResolvedValue("me");
    const recordTicketWorkflowEvents = runtime.recordTicketWorkflowEvents as (
      value: unknown,
      changelog: unknown,
    ) => Promise<void>;
    const changelog = {
      id: "10124",
      items: [
        {
          field: "status",
          fieldId: "status",
          fieldType: "jira",
          from: "10000",
          fromString: "To Do",
          to: "3",
          toString: "In Progress",
        },
      ],
    };

    await recordTicketWorkflowEvents.call(service, ticket("me"), changelog);

    expect(record.mock.calls.map(([input]) => input.kind).sort()).toEqual([
      "JIRA_STATUS",
      "JIRA_TICKET_UPDATED",
    ]);
    const updated = record.mock.calls.find(
      ([input]) => input.kind === "JIRA_TICKET_UPDATED",
    )?.[0];
    expect(updated.payload.sessionData.changelog).toEqual(changelog);
    expect(updated.payload.changelog).toEqual(changelog);
  });
});

describe("Jira webhook event resolution", () => {
  test("resolves distinct issue IDs to normalized keys", async () => {
    const getIssue = vi
      .fn()
      .mockResolvedValueOnce({ id: "10001", key: "app-1" })
      .mockResolvedValueOnce({ id: "10002", key: "APP-2" });
    const service = new JiraService();
    const runtime = service as unknown as Record<string, unknown>;
    runtime.getClients = vi.fn().mockResolvedValue({
      cloud: { issues: { getIssue } },
    });

    await expect(
      service.resolveIssueKeys(["10001", "10002", "10001"]),
    ).resolves.toEqual(["APP-1", "APP-2"]);
    expect(getIssue).toHaveBeenCalledTimes(2);
  });

  test("paginates a sprint and refreshes each distinct ticket", async () => {
    const getIssuesForSprint = vi
      .fn()
      .mockResolvedValueOnce({
        issues: [{ key: "APP-1" }, { key: "APP-2" }],
        isLast: false,
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        issues: [{ key: "APP-3" }],
        isLast: true,
      });
    const service = new JiraService();
    const runtime = service as unknown as Record<string, unknown>;
    runtime.getClients = vi.fn().mockResolvedValue({
      agile: { sprint: { getIssuesForSprint } },
    });
    const refreshCachedTicket = vi.fn(async (key: string) => ({ key }));
    runtime.refreshCachedTicket = refreshCachedTicket;

    await expect(service.refreshSprintTickets(27)).resolves.toEqual([
      { key: "APP-1" },
      { key: "APP-2" },
      { key: "APP-3" },
    ]);
    expect(getIssuesForSprint).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sprintId: 27, nextPageToken: "page-2" }),
    );
    expect(refreshCachedTicket.mock.calls.map(([key]) => key)).toEqual([
      "APP-1",
      "APP-2",
      "APP-3",
    ]);
  });
});

describe("Jira v6 source pagination", () => {
  const issue = (key: string, updated: Date) => ({
    id: key,
    key,
    fields: {
      summary: key,
      status: {
        id: "doing",
        name: "In Progress",
        statusCategory: { key: "indeterminate" },
      },
      project: { key: "APP" },
      updated,
    },
  });

  test("uses JQL continuation tokens and surfaces structured warnings", async () => {
    const searchAndReconsileIssuesUsingJql = vi
      .fn()
      .mockResolvedValueOnce({
        issues: [issue("APP-1", new Date("2026-08-17T10:00:00.000Z"))],
        isLast: false,
        nextPageToken: "jql-page-2",
        warnings: [
          {
            type: "CLAUSE_LIMIT_EXCEEDED",
            message: "The first clause was limited.",
          },
        ],
      })
      .mockResolvedValueOnce({
        issues: [issue("APP-2", new Date("2026-08-17T11:00:00.000Z"))],
        isLast: true,
        warnings: [{ type: "RESULTS_TRUNCATED" }],
      });
    const runtime = sourceLoaderHarness(new JiraService());
    runtime.getClients = vi.fn().mockResolvedValue({
      cloud: { issueSearch: { searchAndReconsileIssuesUsingJql } },
    });

    const board = await runtime.loadJqlSource(
      {
        id: "source-1",
        projectId: "project-1",
        name: "Current work",
        kind: "JQL",
        value: "project = APP",
        boardId: null,
        position: 0,
      },
      false,
    );

    expect(searchAndReconsileIssuesUsingJql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nextPageToken: "jql-page-2" }),
    );
    expect(board.tickets.map(({ key }) => key)).toEqual(["APP-1", "APP-2"]);
    expect(board.tickets[0]?.updatedAt).toBe("2026-08-17T10:00:00.000Z");
    expect(board.warnings).toEqual([
      "The first clause was limited.",
      "RESULTS_TRUNCATED",
    ]);
  });

  test("uses Agile continuation tokens for board issues", async () => {
    const getIssuesForBoard = vi
      .fn()
      .mockResolvedValueOnce({
        issues: [issue("APP-1", new Date("2026-08-17T10:00:00.000Z"))],
        isLast: false,
        nextPageToken: "board-page-2",
        warningMessages: ["First-page warning"],
      })
      .mockResolvedValueOnce({
        issues: [issue("APP-2", new Date("2026-08-17T11:00:00.000Z"))],
        isLast: true,
      });
    const runtime = sourceLoaderHarness(new JiraService());
    runtime.getClients = vi.fn().mockResolvedValue({
      agile: {
        board: {
          getBoard: vi.fn().mockResolvedValue({ id: 42, type: "kanban" }),
          getConfiguration: vi
            .fn()
            .mockResolvedValue({ columnConfig: { columns: [] } }),
          getIssuesForBoard,
        },
      },
    });

    const board = await runtime.loadBoardSource(
      {
        id: "source-2",
        projectId: "project-1",
        name: "Kanban",
        kind: "BOARD",
        value:
          "https://example.atlassian.net/jira/software/c/projects/APP/boards/42",
        boardId: 42,
        position: 0,
      },
      false,
    );

    expect(getIssuesForBoard).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nextPageToken: "board-page-2" }),
    );
    expect(board.tickets.map(({ key }) => key)).toEqual(["APP-1", "APP-2"]);
    expect(board.warnings).toEqual(["First-page warning"]);
    expect(board.truncated).toBe(false);
  });
});
