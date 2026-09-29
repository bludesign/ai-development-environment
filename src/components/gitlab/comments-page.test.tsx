import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  GitLabCommentPageView,
  GitLabCommentThreadView,
  GitLabDiscussionNoteView,
  GitLabMergeRequestView,
} from "@/services/gitlab";

import { GitLabCommentsPage } from "./comments-page";
import { gitLabCommentsHref } from "./merge-request-links";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => {} }),
  onControlPlaneRecovery: () => () => {},
}));
const request = vi.mocked(controlPlaneRequest);
const user = (id = "me") => ({
  id,
  username: id,
  name: id,
  avatarUrl: null,
  webUrl: `https://gitlab.example/${id}`,
});
const mr: GitLabMergeRequestView = {
  id: "101",
  projectId: "42",
  iid: 17,
  projectPath: "team/widgets",
  title: "Improve comments",
  description: "",
  state: "OPENED",
  draft: false,
  sourceBranch: "feature/comments",
  targetBranch: "main",
  sha: "abc",
  author: user(),
  labels: [],
  reviewers: [],
  webUrl: "https://gitlab.example/team/widgets/-/merge_requests/17",
  detailedMergeStatus: "mergeable",
  mergeWhenPipelineSucceeds: false,
  squashOnMerge: false,
  hasConflicts: false,
  blockingDiscussionsResolved: true,
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
  mergedAt: null,
  worktreeHighlightColor: "violet",
};
const note = (
  id: string,
  overrides: Partial<GitLabDiscussionNoteView> = {},
): GitLabDiscussionNoteView => ({
  id,
  body: `Comment ${id}`,
  author: user(),
  createdAt: mr.createdAt,
  updatedAt: mr.updatedAt,
  system: false,
  resolvable: true,
  resolved: false,
  resolvedBy: null,
  ...overrides,
});
const thread = (
  id: string,
  notes: GitLabDiscussionNoteView[],
): GitLabCommentThreadView => ({
  id: `42:17:${id}`,
  mergeRequest: mr,
  discussion: { id, individualNote: false, notes },
});
const mine = thread("mine", [note("mine", { resolvable: false })]);
const other = thread("other", [
  note("other", { author: user("other"), filePath: "src/api.ts", newLine: 12 }),
  note("reply"),
]);
const resolved = thread("resolved", [note("resolved", { resolved: true })]);
const commentsPage = (
  overrides: Partial<GitLabCommentPageView> = {},
): GitLabCommentPageView => ({
  viewerId: "me",
  viewerUsername: "me",
  mergeRequests: [mr],
  threads: [mine, other, resolved],
  endCursor: null,
  hasNextPage: false,
  partial: false,
  warnings: [],
  ...overrides,
});
function mockPage(page = commentsPage()) {
  request.mockImplementation(async (query) => {
    if (query.includes("GitLabCommentsConfiguration"))
      return { gitlabSettings: { configured: true } } as never;
    if (query.includes("query GitLabComments("))
      return { gitlabComments: page } as never;
    throw new Error(`Unexpected request ${query}`);
  });
}
function card(text: string) {
  return screen.getByText(text).closest<HTMLElement>('[data-slot="card"]')!;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  request.mockReset();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/gitlab/comments");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GitLab Comments", () => {
  test("explicit refresh fetches newly posted general comments instead of reusing an empty cached result", async () => {
    const newComments = [
      thread("first", [
        note("first", { body: "Test comment", resolvable: false }),
      ]),
      thread("second", [
        note("second", { body: "Test new comment", resolvable: false }),
      ]),
    ];
    request.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      if (query.includes("query GitLabComments("))
        return {
          gitlabComments: commentsPage({
            threads: variables?.refresh ? newComments : [],
          }),
        } as never;
      throw new Error(`Unexpected request ${query}`);
    });
    render(<GitLabCommentsPage initialProjectId="42" initialIid={17} />);
    await waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("query GitLabComments("),
        expect.objectContaining({ projectId: "42", iid: 17, after: null }),
        expect.anything(),
      );
      expect(
        screen
          .getByRole("button", { name: "Refresh" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
    expect(screen.queryByText("Test comment")).toBeNull();
    expect(screen.queryByText("Test new comment")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Test comment");
    expect(screen.getByText("Test new comment")).toBeDefined();
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining("refresh: $refresh"),
      expect.objectContaining({
        projectId: "42",
        iid: 17,
        after: null,
        refresh: true,
      }),
      expect.anything(),
    );
  });

  test("opens linked discussions as conversations and preserves the saved table preference", async () => {
    window.localStorage.setItem("gitlab-comments-layout", "table");
    mockPage(commentsPage({ threads: [other] }));
    render(
      <GitLabCommentsPage
        initialProjectId="42"
        initialIid={17}
        initialDiscussionId="other"
      />,
    );
    await screen.findByText("Comment reply");
    expect(screen.getByRole("textbox", { name: "Reply" })).toBeDefined();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Table layout" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show all discussions for this merge request",
      }),
    );
    await screen.findByRole("table");
    expect(window.localStorage.getItem("gitlab-comments-layout")).toBe("table");
  });
  test("shows human comments and replies with unresolved off by default, links and worktree colors", async () => {
    mockPage();
    render(<GitLabCommentsPage />);
    await screen.findByText("Comment mine");
    expect(screen.getByText("Comment resolved")).toBeDefined();
    expect(screen.getByText("Comment reply")).toBeDefined();
    expect(
      screen
        .getByRole("checkbox", { name: "Unresolved" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText("General comment")).toBeDefined();
    expect(screen.getByText("src/api.ts · L12")).toBeDefined();
    expect(card("Comment other").className).toContain("bg-violet-500/10");
    expect(
      within(card("Comment other"))
        .getByRole("link", { name: "Open in GitLab" })
        .getAttribute("href"),
    ).toBe(`${mr.webUrl}#note_other`);
    expect(
      within(card("Comment other"))
        .getByRole("link", { name: "Open discussion" })
        .getAttribute("href"),
    ).toBe("/gitlab/comments?project=42&iid=17&discussion=other");
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("query GitLabComments("),
      {
        projectId: null,
        iid: null,
        discussionId: null,
        after: null,
        first: 25,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  test("filters by root author and resolution while preserving drafts and saved layout", async () => {
    mockPage();
    render(<GitLabCommentsPage />);
    await screen.findByText("Comment mine");
    fireEvent.change(
      within(card("Comment other")).getByRole("textbox", { name: "Reply" }),
      { target: { value: "Keep this draft" } },
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Other Users" }));
    expect(screen.queryByText("Comment other")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Other Users" }));
    expect(
      (
        within(card("Comment other")).getByRole("textbox", {
          name: "Reply",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("checkbox", { name: "Unresolved" }));
    expect(screen.queryByText("Comment mine")).toBeNull();
    expect(screen.queryByText("Comment resolved")).toBeNull();
    expect(screen.getByText("Comment other")).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: "Table layout" }));
    expect(screen.getByRole("columnheader", { name: "Replies" })).toBeDefined();
    expect(window.localStorage.getItem("gitlab-comments-layout")).toBe("table");
    fireEvent.click(screen.getByRole("radio", { name: "Card layout" }));
    expect(
      (
        within(card("Comment other")).getByRole("textbox", {
          name: "Reply",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("checkbox", { name: "Current User" }));
    expect(screen.getByText("Comment reply")).toBeDefined();
  });

  test("loads terminal merge requests from direct links and follows browser history", async () => {
    window.history.replaceState(
      null,
      "",
      "/gitlab/comments?project=42&iid=17&discussion=resolved",
    );
    mockPage(
      commentsPage({
        mergeRequests: [{ ...mr, state: "MERGED" }],
        threads: [resolved],
      }),
    );
    render(
      <GitLabCommentsPage
        initialProjectId="42"
        initialIid={17}
        initialDiscussionId="resolved"
      />,
    );
    await screen.findByText("Comment resolved");
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("query GitLabComments("),
      {
        projectId: "42",
        iid: 17,
        discussionId: "resolved",
        after: null,
        first: 25,
      },
      { signal: expect.any(AbortSignal) },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show all discussions for this merge request",
      }),
    );
    await waitFor(() =>
      expect(window.location.search).toBe("?project=42&iid=17"),
    );
    window.history.replaceState(null, "", "/gitlab/comments");
    fireEvent.popState(window);
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("query GitLabComments("),
        {
          projectId: null,
          iid: null,
          discussionId: null,
          after: null,
          first: 25,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  test("keeps continuation and partial warnings visible when a bounded page has no threads", async () => {
    request.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      return {
        gitlabComments: variables?.after
          ? commentsPage({ threads: [mine] })
          : commentsPage({
              threads: [],
              endCursor: "continue",
              hasNextPage: true,
              partial: true,
              warnings: ["A project is temporarily unavailable."],
            }),
      } as never;
    });
    render(<GitLabCommentsPage />);
    const more = await screen.findByRole("button", { name: "Load more" });
    expect(screen.queryByText("No comments")).toBeNull();
    expect(
      screen.getByText("A project is temporarily unavailable."),
    ).toBeDefined();
    fireEvent.click(more);
    await screen.findByText("Comment mine");
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(
      screen.getByText("A project is temporarily unavailable."),
    ).toBeDefined();
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining("query GitLabComments("),
      expect.objectContaining({ after: "continue" }),
      { signal: expect.any(AbortSignal) },
    );
  });

  test("searches merge requests and updates the selected request URL", async () => {
    mockPage();
    render(<GitLabCommentsPage />);
    await screen.findByText("Comment mine");
    fireEvent.click(
      screen.getByRole("combobox", {
        name: "All relevant open merge requests",
      }),
    );
    fireEvent.change(screen.getByPlaceholderText("Search merge requests"), {
      target: { value: "Improve" },
    });
    fireEvent.click(
      await screen.findByRole("option", { name: /!17 Improve comments/ }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("query GitLabComments("),
        {
          projectId: "42",
          iid: 17,
          discussionId: null,
          after: null,
          first: 25,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(window.location.search).toBe("?project=42&iid=17");
  });

  test("responds to same-route Next navigation with new deep-link props", async () => {
    mockPage();
    const view = render(<GitLabCommentsPage />);
    await screen.findByText("Comment mine");
    view.rerender(
      <GitLabCommentsPage
        initialProjectId="42"
        initialIid={17}
        initialDiscussionId="other"
      />,
    );
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("query GitLabComments("),
        {
          projectId: "42",
          iid: 17,
          discussionId: "other",
          after: null,
          first: 25,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(screen.getByText("Showing a linked discussion.")).toBeDefined();
  });

  test("deduplicates overlapping continuation results", async () => {
    request.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      return {
        gitlabComments: variables?.after
          ? commentsPage({ threads: [mine, other] })
          : commentsPage({
              threads: [mine],
              endCursor: "next",
              hasNextPage: true,
            }),
      } as never;
    });
    render(<GitLabCommentsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Comment other");
    expect(screen.getAllByText("Comment mine")).toHaveLength(1);
  });

  test("orders all loaded threads by newest root comment with stable ties after appending", async () => {
    const newer = (item: GitLabCommentThreadView) => ({
      ...item,
      discussion: {
        ...item.discussion,
        notes: item.discussion.notes.map((value, index) =>
          index === 0 ? { ...value, createdAt: "2026-09-30T00:00:00Z" } : value,
        ),
      },
    });
    request.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      return {
        gitlabComments: variables?.after
          ? commentsPage({ threads: [newer(resolved), newer(other), mine] })
          : commentsPage({
              threads: [mine],
              endCursor: "next",
              hasNextPage: true,
            }),
      } as never;
    });
    render(<GitLabCommentsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await screen.findByText("Comment other");
    expect(
      screen
        .getAllByText(/^Comment (mine|other|resolved)$/)
        .map((element) => element.textContent),
    ).toEqual(["Comment other", "Comment resolved", "Comment mine"]);
  });

  test("preserves drafts on reply errors and blocks same-render duplicate mutations", async () => {
    let rejectReply!: (reason: Error) => void;
    request.mockImplementation(async (query) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      if (query.includes("query GitLabComments("))
        return { gitlabComments: commentsPage({ threads: [other] }) } as never;
      return new Promise((_resolve, reject) => {
        rejectReply = reject;
      });
    });
    render(<GitLabCommentsPage />);
    await screen.findByText("Comment other");
    const reply = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "Do not lose this" } });
    const form = reply.closest("form")!;
    act(() => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation ReplyToGitLabDiscussion"),
      ),
    ).toHaveLength(1);
    await act(async () => rejectReply(new Error("GitLab denied the reply")));
    await screen.findByText("GitLab denied the reply");
    expect((reply as HTMLTextAreaElement).value).toBe("Do not lose this");
  });

  test("updates returned replies and resolution without losing other drafts", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      if (query.includes("query GitLabComments("))
        return {
          gitlabComments: commentsPage({ threads: [mine, other] }),
        } as never;
      if (query.includes("mutation ReplyToGitLabDiscussion"))
        return {
          replyToGitLabDiscussion: {
            ...other.discussion,
            notes: [
              ...other.discussion.notes,
              note("new", { body: "Posted reply" }),
            ],
          },
        } as never;
      return {
        setGitLabDiscussionResolved: {
          ...other.discussion,
          notes: other.discussion.notes.map((item) => ({
            ...item,
            resolved: true,
          })),
        },
      } as never;
    });
    render(<GitLabCommentsPage />);
    await screen.findByText("Comment other");
    fireEvent.change(
      within(card("Comment mine")).getByRole("textbox", { name: "Reply" }),
      { target: { value: "Other draft" } },
    );
    const reply = within(card("Comment other")).getByRole("textbox", {
      name: "Reply",
    });
    fireEvent.change(reply, { target: { value: "Posted reply" } });
    fireEvent.click(
      within(card("Comment other")).getByRole("button", { name: "Send reply" }),
    );
    await screen.findByText("Posted reply");
    expect((reply as HTMLTextAreaElement).value).toBe("");
    expect(
      (
        within(card("Comment mine")).getByRole("textbox", {
          name: "Reply",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Other draft");
    fireEvent.click(screen.getByRole("checkbox", { name: "Unresolved" }));
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));
    await waitFor(() => expect(screen.queryByText("Comment other")).toBeNull());
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining("mutation SetGitLabDiscussionResolved"),
      {
        input: { projectId: "42", iid: 17, discussionId: "other" },
        resolved: true,
      },
    );
  });

  test("ignores late responses from an old selection", async () => {
    let resolveOld!: (value: unknown) => void;
    request.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabCommentsConfiguration"))
        return { gitlabSettings: { configured: true } } as never;
      if (variables?.iid === 17)
        return {
          gitlabComments: commentsPage({ threads: [resolved] }),
        } as never;
      return new Promise((resolve) => {
        resolveOld = resolve;
      });
    });
    render(<GitLabCommentsPage />);
    await waitFor(() => expect(resolveOld).toBeDefined());
    const oldSignal = request.mock.calls.at(-1)?.[2]?.signal;
    window.history.replaceState(null, "", "/gitlab/comments?project=42&iid=17");
    fireEvent.popState(window);
    await screen.findByText("Comment resolved");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () =>
      resolveOld({ gitlabComments: commentsPage({ threads: [mine] }) }),
    );
    expect(screen.queryByText("Comment mine")).toBeNull();
    expect(screen.getByText("Comment resolved")).toBeDefined();
  });

  test("shows provider errors without a false empty state and can retry configuration", async () => {
    request.mockRejectedValueOnce(new Error("Configuration offline"));
    render(<GitLabCommentsPage />);
    await screen.findByText("Configuration offline");
    mockPage();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Comment mine");
    request.mockRejectedValue(new Error("Comments unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Comments unavailable");
    expect(screen.getByText("Comment mine")).toBeDefined();
    expect(screen.queryByText("No comments")).toBeNull();
  });

  test("encodes project and discussion identifiers in deep links", () => {
    expect(
      gitLabCommentsHref({ projectId: "team/widgets", iid: 17 }, "a/b?c"),
    ).toBe(
      "/gitlab/comments?project=team%2Fwidgets&iid=17&discussion=a%2Fb%3Fc",
    );
  });
});
