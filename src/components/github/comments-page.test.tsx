import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubReviewThread } from "@/services/github/types";

import { CommentsPage } from "./comments-page";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function thread(
  id: string,
  options: {
    author?: string;
    resolved?: boolean;
    number?: number;
    replies?: Array<{ author: string; body: string }>;
  } = {},
): GitHubReviewThread {
  const number = options.number ?? 17;
  return {
    id,
    isResolved: options.resolved ?? false,
    isOutdated: false,
    subjectType: "LINE",
    path: "src/index.ts",
    line: 12,
    startLine: 10,
    originalLine: 12,
    originalStartLine: 10,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: true,
    resolvedBy: null,
    pullRequest: {
      id: `pull-request-${number}`,
      number,
      title: number === 17 ? "Add review comments" : "Second pull request",
      url: `https://github.com/acme/widgets/pull/${number}`,
      repositoryNameWithOwner: "acme/widgets",
    },
    rootComment: {
      id: `${id}-root`,
      body: `Root ${id}`,
      bodyText: `Root ${id}`,
      bodyHtml: `<p>Root ${id}</p>`,
      url: `https://github.com/acme/widgets/pull/${number}#discussion_${id}`,
      author: {
        login: options.author ?? "reviewer",
        avatarUrl: "https://avatars.example/author",
        url: `https://github.com/${options.author ?? "reviewer"}`,
      },
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
    replies: (options.replies ?? []).map((reply, index) => ({
      id: `${id}-reply-${index}`,
      body: reply.body,
      bodyText: reply.body,
      bodyHtml: `<p>${reply.body}</p>`,
      url: `https://github.com/acme/widgets/pull/${number}#reply-${index}`,
      author: {
        login: reply.author,
        avatarUrl: "https://avatars.example/reply",
        url: `https://github.com/${reply.author}`,
      },
      createdAt: "2026-07-16T01:00:00.000Z",
      updatedAt: "2026-07-16T01:00:00.000Z",
    })),
  };
}

const mine = thread("mine", { author: "octocat" });
const other = thread("other", {
  author: "reviewer",
  replies: [{ author: "octocat", body: "Reply from current user" }],
});
const resolved = thread("resolved", {
  author: "reviewer",
  number: 22,
  resolved: true,
});

function configureRequests() {
  request.mockImplementation(async (query) => {
    if (query.includes("GitHubCommentsConfiguration")) {
      return {
        githubSettings: {
          tokenConfigured: true,
          updatedAt: new Date(0).toISOString(),
        },
      } as never;
    }
    if (query.includes("query GitHubReviewThreads")) {
      return {
        githubReviewThreads: {
          viewerLogin: "octocat",
          truncated: false,
          pullRequests: [mine.pullRequest, resolved.pullRequest],
          threads: [mine, other, resolved],
        },
      } as never;
    }
    if (query.includes("ReplyToGitHubReviewThread")) {
      return {
        replyToGitHubReviewThread: {
          id: "new-reply",
          body: "A new reply",
          bodyText: "A new reply",
          bodyHtml: "<p>A new reply</p>",
          url: "https://github.com/acme/widgets/pull/17#new-reply",
          author: mine.rootComment.author,
          createdAt: "2026-07-16T02:00:00.000Z",
          updatedAt: "2026-07-16T02:00:00.000Z",
        },
      } as never;
    }
    if (query.includes("SetGitHubReviewThreadResolved")) {
      return {
        setGitHubReviewThreadResolved: {
          id: "mine",
          isResolved: true,
          viewerCanResolve: false,
          viewerCanUnresolve: true,
          resolvedBy: mine.rootComment.author,
        },
      } as never;
    }
    throw new Error(`Unexpected operation: ${query}`);
  });
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "/comments");
  window.localStorage.clear();
  configureRequests();
});

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("CommentsPage", () => {
  test("applies root-author and unresolved filters and remembers table layout", async () => {
    render(<CommentsPage />);

    expect(await screen.findByText("Root mine")).toBeDefined();
    expect(screen.getByText("Root other")).toBeDefined();
    expect(screen.queryByText("Root resolved")).toBeNull();
    expect(screen.getByText("Reply from current user")).toBeDefined();
    const otherCard = screen
      .getByText("Root other")
      .closest('[data-slot="card"]') as HTMLElement;
    expect(otherCard.querySelectorAll('[data-slot="card"]')).toHaveLength(1);
    expect(
      within(otherCard)
        .getByRole("link", { name: "Open in GitHub" })
        .getAttribute("data-size"),
    ).toBe("icon-xs");
    expect(
      within(otherCard)
        .getByRole("link", { name: "Open reply in GitHub" })
        .getAttribute("data-size"),
    ).toBe("icon-xs");
    expect(
      within(otherCard).getAllByRole("button", { name: "Rendered" }),
    ).toHaveLength(2);
    expect(
      within(otherCard).getAllByRole("button", { name: "Copy" }),
    ).toHaveLength(2);

    fireEvent.click(screen.getByRole("checkbox", { name: "Current User" }));
    expect(screen.queryByText("Root mine")).toBeNull();
    expect(screen.getByText("Root other")).toBeDefined();
    expect(screen.getByText("Reply from current user")).toBeDefined();

    fireEvent.click(screen.getByRole("checkbox", { name: "Unresolved" }));
    expect(screen.getByText("Root resolved")).toBeDefined();

    const tableLayout = screen.getByRole("radio", { name: "Table layout" });
    fireEvent.click(tableLayout);
    expect(screen.getByRole("columnheader", { name: "Comment" })).toBeDefined();
    expect(window.localStorage.getItem("github-comments-layout")).toBe("table");
  });

  test("restores the saved layout after mounting", async () => {
    window.localStorage.setItem("github-comments-layout", "table");

    render(<CommentsPage />);

    const tableLayout = await screen.findByRole("radio", {
      name: "Table layout",
    });
    await waitFor(() =>
      expect(tableLayout.getAttribute("aria-checked")).toBe("true"),
    );
    expect(
      await screen.findByRole("columnheader", { name: "Comment" }),
    ).toBeDefined();
  });

  test("uses the deep-linked pull request filter and clears stale values", async () => {
    window.history.replaceState(
      null,
      "",
      "/comments?pullRequest=acme%2Fwidgets%2322",
    );
    render(<CommentsPage initialPullRequest="acme/widgets#22" />);
    await screen.findByRole("combobox", { name: "Open pull request" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Unresolved" }));
    expect(await screen.findByText("Root resolved")).toBeDefined();
    expect(screen.queryByText("Root mine")).toBeNull();
    cleanup();

    window.history.replaceState(
      null,
      "",
      "/comments?pullRequest=missing%2Frepo%231",
    );
    render(<CommentsPage initialPullRequest="missing/repo#1" />);
    await waitFor(() =>
      expect(window.location.search).not.toContain("pullRequest"),
    );
  });

  test("adds a reply and removes a resolved thread under the default filter", async () => {
    render(<CommentsPage />);
    const root = await screen.findByText("Root mine");
    const card = root.closest('[data-slot="card"]') as HTMLElement;
    const reply = within(card).getByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "A new reply" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send reply" }));
    expect(await screen.findByText("A new reply")).toBeDefined();
    expect((reply as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(
      within(card).getByRole("button", { name: "Resolve thread" }),
    );
    await waitFor(() => expect(screen.queryByText("Root mine")).toBeNull());
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("SetGitHubReviewThreadResolved"),
      { threadId: "mine", resolved: true },
    );
  });
});
