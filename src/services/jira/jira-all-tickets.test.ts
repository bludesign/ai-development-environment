import { describe, expect, test, vi } from "vitest";

import { JiraService } from "./jira.service";
import type {
  JiraProjectView,
  JiraTicketBoard,
  JiraTicketSummary,
} from "./types";

function ticket(
  key: string,
  status = "To Do",
  updatedAt: string | null = null,
): JiraTicketSummary {
  return {
    id: key,
    key,
    summary: key,
    statusId: status,
    status,
    statusCategory: "new",
    issueType: null,
    priority: null,
    assignee: null,
    assigneeAccountId: null,
    assigneeAvatarUrl: null,
    projectKey: key.split("-")[0],
    updatedAt,
  };
}

function setup(count = 2) {
  const service = new JiraService();
  const sources = Array.from({ length: count }, (_, index) => ({
    id: `s${index}`,
    projectId: "p",
    name: `Source ${index}`,
    kind: "JQL" as const,
    value: "project = APP",
    boardId: null,
    position: index,
  }));
  vi.spyOn(service, "listProjects").mockResolvedValue([
    { key: "APP", sources } as JiraProjectView,
  ]);
  const board = (
    index: number,
    tickets: JiraTicketSummary[],
    overrides: Partial<JiraTicketBoard> = {},
  ): JiraTicketBoard => ({
    source: sources[index],
    tickets,
    statusOrder: [...new Set(tickets.map((item) => item.status))],
    cache: {
      source: "CACHE",
      stale: false,
      fetchedAt: "2026-10-01T00:00:00.000Z",
    },
    truncated: false,
    warnings: [],
    ...overrides,
  });
  return { service, board };
}

describe("All Jira tickets", () => {
  test("keeps traversal order, merges statuses, and chooses the latest duplicate after source filters", async () => {
    const { service, board } = setup(3);
    const old = ticket("APP-1", "To Do", "2026-10-01T00:00:00Z");
    const newest = ticket("APP-1", "In Progress", "2026-10-02T00:00:00Z");
    const tied = { ...newest, summary: "Later source loses tie" };
    const boards = [
      board(0, [old, ticket("APP-2")]),
      board(1, [newest, ticket("OPS-1", "Review")], { truncated: true }),
      board(2, [tied]),
    ];
    const load = vi
      .spyOn(service, "ticketBoard")
      .mockImplementation(async (id) => boards[Number(id.slice(1))]);
    const result = await service.allTickets();
    expect(result.tickets).toEqual([
      newest,
      ticket("APP-2"),
      ticket("OPS-1", "Review"),
    ]);
    expect(result.statusOrder).toEqual(["To Do", "In Progress", "Review"]);
    expect(result.truncated).toBe(true);
    expect(load.mock.calls).toEqual([
      ["s0", false],
      ["s1", false],
      ["s2", false],
    ]);
  });

  test("handles empty configuration without calling Jira", async () => {
    const { service } = setup(0);
    const load = vi.spyOn(service, "ticketBoard");
    expect(await service.allTickets()).toMatchObject({
      tickets: [],
      statusOrder: [],
      warnings: [],
      truncated: false,
      cache: { stale: false },
    });
    expect(load).not.toHaveBeenCalled();
  });

  test("retains successful results with labelled warnings and stale metadata", async () => {
    const { service, board } = setup();
    vi.spyOn(service, "ticketBoard").mockImplementation(async (id) => {
      if (id === "s1") throw new Error("Unavailable");
      return board(0, [ticket("APP-1")], { warnings: ["No active sprint"] });
    });
    expect(await service.allTickets()).toMatchObject({
      tickets: [{ key: "APP-1" }],
      warnings: [
        "APP / Source 0: No active sprint",
        "APP / Source 1: Unavailable",
      ],
      cache: { source: "ERROR", stale: true },
    });
  });

  test("throws when every configured source fails", async () => {
    const { service } = setup();
    vi.spyOn(service, "ticketBoard").mockRejectedValue(
      new Error("Unavailable"),
    );
    await expect(service.allTickets()).rejects.toThrow("any configured source");
  });

  test("forces all source reads and loads at most four concurrently", async () => {
    const { service, board } = setup(9);
    let active = 0;
    let maximum = 0;
    const load = vi
      .spyOn(service, "ticketBoard")
      .mockImplementation(async (id) => {
        maximum = Math.max(maximum, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return board(Number(id.slice(1)), []);
      });
    await service.allTickets(true);
    expect(maximum).toBe(4);
    expect(load).toHaveBeenCalledTimes(9);
    expect(load.mock.calls.every(([, force]) => force === true)).toBe(true);
  });
});
