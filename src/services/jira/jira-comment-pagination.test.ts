import { describe, expect, test, vi } from "vitest";
import { JiraService } from "./jira.service";

type RawComment = { id: string; body: string; created: string };
function harness() {
  let comments: RawComment[] = Array.from({ length: 251 }, (_, i) => ({
    id: String(i),
    body: `comment ${i}`,
    created: new Date(i * 1000).toISOString(),
  }));
  const getComments = vi.fn(
    async ({
      startAt,
      maxResults,
      orderBy,
    }: {
      startAt: number;
      maxResults: number;
      orderBy: string;
    }) => ({
      total: comments.length,
      comments: (orderBy === "-created"
        ? [...comments].reverse()
        : comments
      ).slice(startAt, startAt + maxResults),
    }),
  );
  const service = new JiraService();
  const observe = vi.fn(async () => undefined);
  const storeComments = vi.fn(async () => undefined);
  const getIssue = vi.fn(async () => ({
    id: "1",
    key: "APP-1",
    fields: { summary: "Ticket" },
  }));
  Object.assign(service, {
    getClients: async () => ({
      cloud: { issues: { getIssue }, issueComments: { getComments } },
    }),
    cachedCall: async ({ fetcher }: { fetcher: () => Promise<unknown> }) => ({
      value: await fetcher(),
      entryId: "cache",
      fetchedAt: new Date(),
      source: "LIVE",
      stale: false,
    }),
    requireCredentials: async () => ({
      siteUrl: "https://example.atlassian.net",
    }),
    linkCacheEntryToIssue: async () => undefined,
    storeDetail: async () => undefined,
    storeComments,
    recordTicketWorkflowEvents: observe,
  });
  return {
    service,
    getComments,
    getIssue,
    observe,
    storeComments,
    append: () => {
      comments = [
        ...comments,
        { id: "251", body: "new", created: new Date(251000).toISOString() },
      ];
    },
  };
}

describe("bounded Jira comments", () => {
  test("reads one newest page while preserving latest-comment workflow observation", async () => {
    const h = harness();
    const ticket = await h.service.ticket("APP-1", false, undefined, 50);
    expect(h.getComments).toHaveBeenCalledTimes(1);
    expect(ticket.comments).toHaveLength(50);
    expect(ticket.comments[0].id).toBe("201");
    expect(ticket.comments.at(-1)?.id).toBe("250");
    expect(ticket.commentsTotal).toBe(251);
    expect(h.observe).toHaveBeenCalledWith(ticket, undefined);
    expect(h.storeComments).not.toHaveBeenCalled(); // Partial pages never replace a complete cache snapshot.
  });

  test("keeps older offsets anchored when a new comment arrives without another count probe", async () => {
    const h = harness();
    const initial = await h.service.ticketComments("APP-1", 50);
    h.append();
    const page = await h.service.ticketComments("APP-1", 50, 50, initial.total);
    expect(h.getComments).toHaveBeenCalledTimes(2);
    expect(page.items.map((item) => item.id)).toEqual(
      Array.from({ length: 50 }, (_, i) => String(151 + i)),
    );
    expect(page.total).toBe(251);
  });

  test("preserves complete-history behavior for callers without a bound", async () => {
    const h = harness();
    const ticket = await h.service.ticket("APP-1");
    expect(h.getComments).toHaveBeenCalledTimes(3);
    expect(ticket.comments).toHaveLength(251);
    expect(h.storeComments).toHaveBeenCalledTimes(1);
  });

  test("starts comment and detail reads concurrently", async () => {
    const h = harness();
    let finish!: (value: {
      id: string;
      key: string;
      fields: { summary: string };
    }) => void;
    h.getIssue.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = h.service.ticket("APP-1", false, undefined, 50);
    await vi.waitFor(() => expect(h.getComments).toHaveBeenCalledTimes(1));
    finish({ id: "1", key: "APP-1", fields: { summary: "Ticket" } });
    await pending;
  });
});
