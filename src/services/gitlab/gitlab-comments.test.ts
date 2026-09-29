import { afterEach, describe, expect, test, vi } from "vitest";
import { GitLabCommentsFeed, type CommentReader } from "./gitlab-comments";
import type {
  GitLabDiscussionView,
  GitLabMergeRequestView,
  GitLabUserView,
} from "./types";

const viewer: GitLabUserView = {
  id: "7",
  username: "alex",
  name: "Alex",
  avatarUrl: null,
  webUrl: "https://gitlab.example/alex",
};
const mr = (iid: number, projectId = "21"): GitLabMergeRequestView => ({
  id: `${projectId}-${iid}`,
  iid,
  projectId,
  projectPath: "team/app",
  title: `Request ${iid}`,
  webUrl: `https://gitlab.example/team/app/-/merge_requests/${iid}`,
  description: "",
  state: "OPENED",
  draft: false,
  sourceBranch: "feature/api",
  targetBranch: "main",
  sha: "abc",
  author: viewer,
  reviewers: [],
  labels: [],
  detailedMergeStatus: "mergeable",
  mergeWhenPipelineSucceeds: false,
  squashOnMerge: false,
  hasConflicts: false,
  blockingDiscussionsResolved: true,
  createdAt: "2026-09-20T10:00:00Z",
  updatedAt: `2026-09-20T${String(10 + (iid % 10)).padStart(2, "0")}:00:00Z`,
  mergedAt: null,
});
const discussion = (id: string, system = false): GitLabDiscussionView => ({
  id,
  individualNote: true,
  notes: [
    {
      id: `${id}-note`,
      body: "General comment",
      author: viewer,
      createdAt: "2026-09-20T12:00:00Z",
      updatedAt: "2026-09-20T12:00:00Z",
      system,
      resolvable: false,
      resolved: false,
      resolvedBy: null,
    },
  ],
});
function setup(projectIds = ["21"]) {
  const feed = new GitLabCommentsFeed();
  const context = { identity: "instance-and-credentials", viewer, projectIds };
  const read = {
    discover: vi
      .fn<CommentReader["discover"]>()
      .mockResolvedValue({ items: [mr(1)], nextPage: null }),
    request: vi
      .fn<CommentReader["request"]>()
      .mockImplementation(async (project, iid) => mr(iid, project)),
    discussions: vi
      .fn<CommentReader["discussions"]>()
      .mockImplementation(async (request) => ({
        items: [discussion(`d-${request.iid}`)],
        nextPage: null,
      })),
    discussion: vi
      .fn<CommentReader["discussion"]>()
      .mockImplementation(async (_request, id) => discussion(id)),
    enrich: vi
      .fn<CommentReader["enrich"]>()
      .mockImplementation(async (request) => request),
  };
  return { feed, read, context };
}
afterEach(() => vi.useRealTimers());

describe("GitLab comments pagination", () => {
  test("deduplicates authored, assigned, review-requested and managed-project discovery without enriching MR details", async () => {
    const { feed, context, read } = setup();
    const result = await feed.load({}, context, read);
    expect(read.discover.mock.calls.map(([source]) => source.scope)).toEqual([
      "created_by_me",
      "assigned_to_me",
      "reviews_for_me",
      "all",
    ]);
    expect(read.discussions).toHaveBeenCalledTimes(1);
    expect(read.request).not.toHaveBeenCalled();
    expect(result.mergeRequests).toHaveLength(1);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].discussion.notes[0].resolvable).toBe(false);
    expect(result.threads[0].discussion.notes[0].webUrl).toContain(
      "#note_d-1-note",
    );
    expect(result.hasNextPage).toBe(false);
  });

  test("removes system activity, sorts human notes chronologically, and keeps general comments", async () => {
    const { feed, context, read } = setup();
    const thread = discussion("human");
    thread.notes.unshift({
      ...thread.notes[0],
      id: "later",
      body: "Reply",
      createdAt: "2026-09-21T00:00:00Z",
    });
    thread.notes.push(discussion("system", true).notes[0]);
    read.discussions.mockResolvedValue({
      items: [discussion("system-only", true), thread],
      nextPage: null,
    });
    const result = await feed.load({}, context, read);
    expect(result.threads.map((value) => value.discussion.id)).toEqual([
      "human",
    ]);
    expect(result.threads[0].discussion.notes.map((note) => note.id)).toEqual([
      "human-note",
      "later",
    ]);
  });

  test("continues within a discussion page and beyond 100 results without duplicates", async () => {
    const { feed, context, read } = setup();
    read.discussions.mockImplementation(async (_mr, page) => ({
      items: Array.from({ length: page === 3 ? 23 : 50 }, (_, i) =>
        discussion(String((page - 1) * 50 + i)),
      ),
      nextPage: page < 3 ? page + 1 : null,
    }));
    const ids: string[] = [];
    let after: string | null = null;
    do {
      const result = await feed.load({ after, first: 20 }, context, read);
      expect(result.threads.length).toBeLessThanOrEqual(20);
      ids.push(...result.threads.map((thread) => thread.id));
      after = result.endCursor;
    } while (after);
    expect(ids).toHaveLength(123);
    expect(new Set(ids).size).toBe(123);
    expect(read.discover).toHaveBeenCalledTimes(4);
    expect(read.discussions).toHaveBeenCalledTimes(3);
  });

  test("buffers unread discussions so changed provider pages and cursor replay cannot skip rows", async () => {
    const { feed, context, read } = setup();
    const selection = { projectId: "21", iid: 1, first: 1 };
    read.discussions.mockResolvedValueOnce({
      items: [discussion("one"), discussion("two"), discussion("three")],
      nextPage: null,
    });
    const first = await feed.load(selection, context, read);
    // A deleted earlier discussion would shift every remaining row on a new provider read.
    read.discussions.mockResolvedValue({
      items: [discussion("two"), discussion("three")],
      nextPage: null,
    });
    const second = await feed.load(
      { ...selection, after: first.endCursor },
      context,
      read,
    );
    const replay = await feed.load(
      { ...selection, after: first.endCursor },
      context,
      read,
    );
    const third = await feed.load(
      { ...selection, after: second.endCursor },
      context,
      read,
    );
    expect(
      [first, second, third].flatMap((page) =>
        page.threads.map((thread) => thread.discussion.id),
      ),
    ).toEqual(["one", "two", "three"]);
    expect(replay.threads).toEqual(second.threads);
    expect(third.hasNextPage).toBe(false);
    expect(read.discussions).toHaveBeenCalledTimes(1);
    expect(read.enrich).toHaveBeenCalledTimes(1);
  });

  test("retains explicit refresh across continuation pages without rereading buffered discussions", async () => {
    const { feed, context, read } = setup();
    read.discussions.mockImplementation(async (_request, page) => ({
      items:
        page === 1
          ? [discussion("first"), discussion("buffered")]
          : [discussion("next-page")],
      nextPage: page === 1 ? 2 : null,
    }));
    const selection = { projectId: "21", iid: 1, first: 1 };
    const first = await feed.load(
      { ...selection, refresh: true },
      context,
      read,
    );
    const second = await feed.load(
      { ...selection, after: first.endCursor },
      context,
      read,
    );
    expect(second.threads[0].discussion.id).toBe("buffered");
    expect(read.discussions).toHaveBeenCalledTimes(1);
    const third = await feed.load(
      { ...selection, after: second.endCursor },
      context,
      read,
    );
    expect(third.threads[0].discussion.id).toBe("next-page");
    expect(read.request.mock.calls[0][2]).toBe(true);
    expect(
      read.discussions.mock.calls.map(([, page, refresh]) => [page, refresh]),
    ).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(third.hasNextPage).toBe(false);
  });

  test("retains explicit refresh when continuation discovers more requests", async () => {
    const { feed, context, read } = setup();
    read.discover.mockImplementation(async (source) => ({
      items: [mr(source.page!)],
      nextPage: source.page === 1 ? 2 : null,
    }));
    const first = await feed.load({ refresh: true }, context, read);
    const second = await feed.load({ after: first.endCursor }, context, read);
    expect(second.threads[0].mergeRequest.iid).toBe(2);
    expect(read.discover.mock.calls).toHaveLength(8);
    expect(read.discover.mock.calls.every(([, refresh]) => refresh)).toBe(true);
    expect(read.discussions.mock.calls.every(([, , refresh]) => refresh)).toBe(
      true,
    );
  });

  test("bounds each response and eventually includes later managed projects and provider pages", async () => {
    const { feed, context, read } = setup(["21", "22", "23", "24", "25"]);
    read.discover.mockImplementation(async (source) => ({
      items: [mr(source.page!, source.projectId ?? "personal")],
      nextPage: source.page === 1 ? 2 : null,
    }));
    const ids = new Set<string>();
    let after: string | null = null;
    let calls = 0;
    do {
      const discoveryBefore = read.discover.mock.calls.length;
      const discussionBefore = read.discussions.mock.calls.length;
      const result = await feed.load({ after }, context, read);
      expect(
        read.discover.mock.calls.length - discoveryBefore,
      ).toBeLessThanOrEqual(4);
      expect(
        read.discussions.mock.calls.length - discussionBefore,
      ).toBeLessThanOrEqual(4);
      result.threads.forEach((thread) =>
        ids.add(`${thread.mergeRequest.projectId}:${thread.mergeRequest.iid}`),
      );
      after = result.endCursor;
      expect(++calls).toBeLessThan(30);
    } while (after);
    expect(ids.size).toBe(12);
    expect(ids.has("25:2")).toBe(true);
  });

  test("loads a terminal request and specific discussion directly, outside discovery", async () => {
    const { feed, context, read } = setup();
    read.request.mockResolvedValue({ ...mr(400, "99"), state: "MERGED" });
    const result = await feed.load(
      { projectId: "99", iid: 400, discussionId: "older-thread" },
      context,
      read,
    );
    expect(read.discover).not.toHaveBeenCalled();
    expect(read.discussions).not.toHaveBeenCalled();
    expect(result.threads[0].mergeRequest.state).toBe("MERGED");
    expect(result.threads[0].discussion.id).toBe("older-thread");
    expect(result.hasNextPage).toBe(false);
  });

  test("keeps successful comments and retains failed sources for a later retry", async () => {
    const { feed, context, read } = setup();
    read.discover.mockRejectedValueOnce(new Error("408 timeout"));
    const first = await feed.load({}, context, read);
    expect(first.threads).toHaveLength(1);
    expect(first.partial).toBe(true);
    expect(first.hasNextPage).toBe(true);
    const second = await feed.load({ after: first.endCursor }, context, read);
    expect(second.partial).toBe(false);
    expect(second.hasNextPage).toBe(false);
    expect(second.threads).toHaveLength(0);
  });

  test("rotates failed discussions so other requests can progress and retries the failed request", async () => {
    const { feed, context, read } = setup();
    read.discover.mockResolvedValue({
      items: Array.from({ length: 6 }, (_, i) => mr(i + 1)),
      nextPage: null,
    });
    read.discussions.mockRejectedValueOnce(new Error("Forbidden"));
    let result = await feed.load({}, context, read);
    expect(result.partial).toBe(true);
    expect(result.threads).toHaveLength(3);
    result = await feed.load({ after: result.endCursor }, context, read);
    expect(result.threads).toHaveLength(3);
    expect(result.hasNextPage).toBe(false);
  });

  test("continues discovery past persistently failed requests without losing their retries or exceeding request limits", async () => {
    const { feed, context, read } = setup(["21", "22", "23", "24", "25"]);
    read.discover.mockImplementation(async (source) => ({
      items: [mr(source.page!, source.projectId ?? "personal")],
      nextPage: source.page === 1 ? 2 : null,
    }));
    let denied = true;
    read.discussions.mockImplementation(async (request) => {
      if (
        denied &&
        request.iid === 1 &&
        ["personal", "21"].includes(request.projectId)
      )
        throw new Error("Forbidden");
      return { items: [discussion(`d-${request.iid}`)], nextPage: null };
    });
    const ids: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const discoveryBefore = read.discover.mock.calls.length;
      const discussionBefore = read.discussions.mock.calls.length;
      const result = await feed.load({ after }, context, read);
      expect(
        read.discover.mock.calls.length - discoveryBefore,
      ).toBeLessThanOrEqual(4);
      expect(
        read.discussions.mock.calls.length - discussionBefore,
      ).toBeLessThanOrEqual(4);
      ids.push(...result.threads.map((thread) => thread.id));
      after = result.endCursor;
      expect(result.hasNextPage).toBe(true);
      expect(++pages).toBeLessThan(10);
    } while (read.discover.mock.calls.length < 16);

    expect(ids).toContain("25:2:d-2");
    expect(ids).toHaveLength(10);
    denied = false;
    const recovered = await feed.load({ after }, context, read);
    expect(recovered.threads.map((thread) => thread.id).sort()).toEqual([
      "21:1:d-1",
      "personal:1:d-1",
    ]);
    expect(recovered.hasNextPage).toBe(false);
    expect(recovered.partial).toBe(false);
    expect(
      new Set([...ids, ...recovered.threads.map((thread) => thread.id)]).size,
    ).toBe(12);
  });

  test("rejects expired or cross-selection continuations and does not consume a cursor on replay", async () => {
    vi.useFakeTimers();
    const { feed, context, read } = setup();
    read.discussions.mockResolvedValue({
      items: [discussion("one"), discussion("two")],
      nextPage: null,
    });
    const first = await feed.load({ first: 1 }, context, read);
    const second = await feed.load({ after: first.endCursor }, context, read);
    const repeated = await feed.load({ after: first.endCursor }, context, read);
    expect(repeated.threads).toEqual(second.threads);
    await expect(
      feed.load({ after: first.endCursor, projectId: "other" }, context, read),
    ).rejects.toThrow("selection changed");
    await expect(
      feed.load(
        { after: first.endCursor },
        { ...context, identity: "new-token" },
        read,
      ),
    ).rejects.toThrow("selection changed");
    vi.advanceTimersByTime(31 * 60_000);
    await expect(
      feed.load({ after: first.endCursor }, context, read),
    ).rejects.toThrow("expired");
  });

  test("reports repeated provider pagination instead of claiming a complete feed", async () => {
    const { feed, context, read } = setup();
    read.discussions.mockResolvedValue({
      items: [discussion("one")],
      nextPage: 1,
    });
    const result = await feed.load({}, context, read);
    expect(result.partial).toBe(true);
    expect(result.warnings.join(" ")).toContain("repeated discussion page");
    expect(result.hasNextPage).toBe(false);
  });

  test("requires complete direct-selection context", async () => {
    const { feed, context, read } = setup();
    await expect(feed.load({ iid: 3 }, context, read)).rejects.toThrow(
      "Select a project",
    );
    await expect(
      feed.load({ discussionId: "id" }, context, read),
    ).rejects.toThrow("Select a project");
    expect(read.discover).not.toHaveBeenCalled();
  });
});
