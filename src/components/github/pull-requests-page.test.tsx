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

import { PullRequestsPage } from "./pull-requests-page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let intersectionCallback: IntersectionObserverCallback | null = null;
let intersectionTarget: Element | null = null;
let intersectionObserver: IntersectionObserver | null = null;

class IntersectionObserverMock {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [0];

  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
    intersectionObserver = this as unknown as IntersectionObserver;
  }

  observe(target: Element) {
    intersectionTarget = target;
  }

  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function intersectPaginationTrigger() {
  if (!intersectionCallback || !intersectionTarget || !intersectionObserver) {
    throw new Error("Pagination trigger is not being observed");
  }
  const bounds = intersectionTarget.getBoundingClientRect();
  intersectionCallback(
    [
      {
        boundingClientRect: bounds,
        intersectionRatio: 1,
        intersectionRect: bounds,
        isIntersecting: true,
        rootBounds: null,
        target: intersectionTarget,
        time: 0,
      },
    ],
    intersectionObserver,
  );
}

function activateTab(tab: HTMLElement) {
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
  fireEvent.click(tab);
}

const repository = {
  id: "local-repository-1",
  githubId: "repository-1",
  owner: "acme",
  name: "widgets",
  nameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets",
  jiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b`,
};

const pullRequest = {
  id: "pull-request-1",
  number: 17,
  title: "APP-42 Add the API",
  url: "https://github.com/acme/widgets/pull/17",
  repositoryGithubId: "repository-1",
  repositoryNameWithOwner: "acme/widgets",
  repositoryUrl: "https://github.com/acme/widgets",
  labels: ["backend", "ready"],
  jiraKey: "APP-42",
  pipelineStatus: "SUCCESS",
  pipelines: [
    {
      id: "check-suite-1",
      name: "CI",
      status: "SUCCESS",
      url: "https://github.com/acme/widgets/actions/runs/1",
      checkSuiteId: "check-suite-1",
      canRetry: true,
    },
  ],
  reviewDecision: "APPROVED",
  unresolvedReviewThreadCount: 2,
  state: "OPEN",
  headRefName: "feature/app-42",
  createdAt: "2026-07-17T12:00:00.000Z",
};

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
  global.IntersectionObserver =
    IntersectionObserverMock as unknown as typeof IntersectionObserver;
  intersectionCallback = null;
  intersectionTarget = null;
  intersectionObserver = null;
  window.history.replaceState(null, "", "/pull-requests");
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

function configureRequests() {
  requestMock.mockImplementation(async (query, variables) => {
    if (query.includes("GitHubPullRequestConfiguration")) {
      return {
        githubSettings: {
          tokenConfigured: true,
          defaultJiraKeyRegex: String.raw`\b([A-Z][A-Z0-9_]*-\d+)\b`,
          updatedAt: new Date(0).toISOString(),
        },
        githubRepositories: [repository],
      } as never;
    }
    if (query.includes("query GitHubPullRequests")) {
      const filter = String(variables?.state ?? "OPEN") as
        "ALL" | "OPEN" | "CLOSED" | "MERGED";
      const state = filter === "ALL" ? "OPEN" : filter;
      const item = { ...pullRequest, state };
      const after = variables?.after;
      return {
        githubPullRequests: {
          items: after
            ? [
                {
                  ...item,
                  id: "pull-request-older",
                  number: 16,
                  title: "Older merged pull request",
                  createdAt: "2026-07-16T12:00:00.000Z",
                },
              ]
            : variables?.scope === "REVIEW_REQUESTED"
              ? [{ ...item, id: "review-1", title: "Review this" }]
              : [item],
          truncated: false,
          hasNextPage: !after,
          endCursor: after ? null : "cursor-1",
        },
      } as never;
    }
    if (query.includes("GitHubAvailableRepositories")) {
      return {
        githubAvailableRepositories: {
          items: [
            {
              githubId: "repository-2",
              nameWithOwner: "acme/platform",
              url: "https://github.com/acme/platform",
              isPrivate: true,
              managed: false,
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      } as never;
    }
    if (query.includes("AddGitHubRepository")) {
      return {
        addGitHubRepository: [
          repository,
          {
            ...repository,
            id: "local-repository-2",
            githubId: "repository-2",
            name: "platform",
            nameWithOwner: "acme/platform",
            url: "https://github.com/acme/platform",
          },
        ],
      } as never;
    }
    if (query.includes("SaveDefaultGitHubJiraKeyRegex")) {
      return {
        saveGitHubSettings: {
          tokenConfigured: true,
          defaultJiraKeyRegex: String(
            (variables?.input as { defaultJiraKeyRegex?: string })
              ?.defaultJiraKeyRegex,
          ),
          updatedAt: new Date().toISOString(),
        },
      } as never;
    }
    if (query.includes("GitHubPullRequestMergeOptions")) {
      return {
        githubPullRequestMergeOptions: {
          availableMethods: ["SQUASH"],
          commitEmails: [],
          defaultCommitEmail: null,
          defaultCommitHeadline: pullRequest.title,
          defaultCommitBody: "",
          canMerge: true,
          blockedReason: null,
        },
      } as never;
    }
    if (query.includes("RetryGitHubPipeline")) {
      return {
        retryGitHubPipeline: {
          ...pullRequest.pipelines[0],
          status: "QUEUED",
          canRetry: false,
        },
      } as never;
    }
    if (query.includes("query JiraTicket")) {
      throw new Error("Jira is not configured in this test");
    }
    throw new Error(`Unexpected operation: ${query}`);
  });
}

describe("PullRequestsPage", () => {
  test("renders pull request fields, loads tabs lazily, refreshes, and routes clicks correctly", async () => {
    configureRequests();
    render(<PullRequestsPage />);

    expect(await screen.findByRole("tab", { name: "Mine" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Review requests" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Repositories" })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Ticket" })).toBeDefined();

    const title = await screen.findByRole("link", {
      name: "APP-42 Add the API",
    });
    const row = title.closest("tr");
    expect(row).not.toBeNull();
    const cells = within(row as HTMLTableRowElement).getAllByRole("cell");
    expect(cells[0]?.textContent).toBe("#17");
    const numberBadge = within(cells[0] as HTMLTableCellElement).getByRole(
      "link",
      { name: "#17" },
    );
    expect(numberBadge.className).toContain("rounded-4xl");
    expect(
      within(cells[1] as HTMLTableCellElement).getByText("APP-42 Add the API"),
    ).toBeDefined();
    expect(
      within(cells[1] as HTMLTableCellElement).getByText("acme/widgets"),
    ).toBeDefined();
    expect(
      within(cells[1] as HTMLTableCellElement).queryByText("Open"),
    ).toBeNull();
    expect(
      within(cells[7] as HTMLTableCellElement).getByText("Open"),
    ).toBeDefined();
    expect(
      within(row as HTMLTableRowElement).getByText("backend"),
    ).toBeDefined();
    expect(
      within(row as HTMLTableRowElement).getByRole("button", {
        name: /Passed/,
      }).className,
    ).toContain("bg-emerald-500/10");
    expect(
      within(row as HTMLTableRowElement).getByText("Approved").className,
    ).toContain("bg-emerald-500/10");
    expect(
      within(row as HTMLTableRowElement)
        .getByRole("link", { name: "View 2 open comments" })
        .getAttribute("href"),
    ).toBe("/comments?pullRequest=acme%2Fwidgets%2317");
    const jiraBadge = within(row as HTMLTableRowElement).getByRole("button", {
      name: "APP-42",
    });
    for (const className of ["rounded-4xl", "px-2", "py-0.5", "text-xs"]) {
      expect(jiraBadge.className).toContain(className);
    }
    expect(jiraBadge.className).toContain("hover:bg-primary/80");

    fireEvent.pointerDown(
      within(row as HTMLTableRowElement).getByRole("button", {
        name: "Actions: #17",
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(
      screen.getByRole("menuitem", { name: "Details" }).getAttribute("href"),
    ).toBe("/pull-requests/acme/widgets/17");
    expect(
      screen
        .getByRole("menuitem", { name: "Open in GitHub" })
        .getAttribute("href"),
    ).toBe(pullRequest.url);
    fireEvent.click(screen.getByRole("menuitem", { name: "Merge" }));
    expect(
      await screen.findByRole("heading", { name: "Merge pull request" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(title.getAttribute("href")).toBe("/pull-requests/acme/widgets/17");
    expect(
      within(row as HTMLTableRowElement).getByText("feature/app-42"),
    ).toBeDefined();

    fireEvent.pointerDown(
      within(row as HTMLTableRowElement).getByRole("button", {
        name: /Passed/,
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(await screen.findByText("CI")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RetryGitHubPipeline"),
        { repositoryId: "repository-1", checkSuiteId: "check-suite-1" },
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });

    activateTab(screen.getByRole("tab", { name: "Review requests" }));
    await screen.findByText("Review this");
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining("query GitHubPullRequests"),
      {
        scope: "REVIEW_REQUESTED",
        repositoryId: null,
        state: "OPEN",
        first: 25,
        after: null,
      },
    );

    const callsBeforeRefresh = requestMock.mock.calls.filter(([query]) =>
      String(query).includes("query GitHubPullRequests"),
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.filter(([query]) =>
          String(query).includes("query GitHubPullRequests"),
        ).length,
      ).toBeGreaterThan(callsBeforeRefresh),
    );

    activateTab(screen.getByRole("tab", { name: "Repositories" }));
    expect(
      (await screen.findByRole("combobox", { name: "Repository" })).textContent,
    ).toContain("acme/widgets");
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubPullRequests"),
        {
          scope: "REPOSITORY",
          repositoryId: "local-repository-1",
          state: "OPEN",
          first: 25,
          after: null,
        },
      ),
    );
    activateTab(screen.getByRole("tab", { name: "Review requests" }));

    const reviewRow = (await screen.findByText("Review this")).closest("tr");
    expect(reviewRow).not.toBeNull();
    fireEvent.click(
      within(reviewRow as HTMLTableRowElement).getByRole("button", {
        name: "APP-42",
      }),
    );
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(
      "APP-42",
    );
  });

  test("switches all states and infinitely paginates merged pull requests", async () => {
    configureRequests();
    render(<PullRequestsPage />);

    const stateFilter = await screen.findByRole("combobox", {
      name: "Pull request state",
    });
    expect(stateFilter.textContent).toContain("Open");
    let pullRequestRow = await screen.findByRole("row", {
      name: /APP-42 Add the API/,
    });
    fireEvent.pointerDown(
      within(pullRequestRow).getByRole("button", { name: "Actions: #17" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(screen.getByRole("menuitem", { name: "Merge" })).toBeDefined();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.pointerDown(stateFilter, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Closed" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubPullRequests"),
        {
          scope: "MINE",
          repositoryId: null,
          state: "CLOSED",
          first: 25,
          after: null,
        },
      ),
    );
    expect((await screen.findAllByText("Closed")).length).toBeGreaterThan(0);
    pullRequestRow = screen.getByRole("row", { name: /APP-42 Add the API/ });
    fireEvent.pointerDown(
      within(pullRequestRow).getByRole("button", { name: "Actions: #17" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(screen.queryByRole("menuitem", { name: "Merge" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.pointerDown(stateFilter, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Merged" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubPullRequests"),
        {
          scope: "MINE",
          repositoryId: null,
          state: "MERGED",
          first: 25,
          after: null,
        },
      ),
    );
    expect((await screen.findAllByText("Merged")).length).toBeGreaterThan(0);
    pullRequestRow = screen.getByRole("row", { name: /APP-42 Add the API/ });
    fireEvent.pointerDown(
      within(pullRequestRow).getByRole("button", { name: "Actions: #17" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(screen.queryByRole("menuitem", { name: "Merge" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    act(() => {
      intersectPaginationTrigger();
      intersectPaginationTrigger();
    });
    expect(await screen.findByText("Older merged pull request")).toBeDefined();
    const newestDaySeparator = screen.getByText("Friday, July 17, 2026");
    const olderDaySeparator = screen.getByText("Thursday, July 16, 2026");
    expect(newestDaySeparator.closest("td")?.colSpan).toBe(9);
    expect(olderDaySeparator.closest("td")?.colSpan).toBe(9);
    expect(
      requestMock.mock.calls.filter(
        ([query, variables]) =>
          String(query).includes("query GitHubPullRequests") &&
          variables?.state === "MERGED" &&
          variables.after === "cursor-1",
      ),
    ).toHaveLength(1);

    fireEvent.pointerDown(stateFilter, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubPullRequests"),
        {
          scope: "MINE",
          repositoryId: null,
          state: "ALL",
          first: 25,
          after: null,
        },
      ),
    );
    expect(stateFilter.textContent).toContain("All");
    pullRequestRow = await screen.findByRole("row", {
      name: /APP-42 Add the API/,
    });
    fireEvent.pointerDown(
      within(pullRequestRow).getByRole("button", { name: "Actions: #17" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(screen.getByRole("menuitem", { name: "Merge" })).toBeDefined();
  });

  test("browses repositories and supports exact owner/name entry", async () => {
    configureRequests();
    render(<PullRequestsPage />);
    await screen.findByRole("tab", { name: "Mine" });

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("acme/platform")).toBeDefined();
    expect(screen.getByText("Private repository")).toBeDefined();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search available repositories" }),
      { target: { value: "missing" } },
    );
    expect(screen.queryByText("acme/platform")).toBeNull();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search available repositories" }),
      { target: { value: "platform" } },
    );
    expect(screen.getByText("acme/platform")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Default ticket key regex"), {
      target: { value: String.raw`\b([A-Z]+-\d+)\b` },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Save default ticket key regex",
      }),
    );
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("SaveDefaultGitHubJiraKeyRegex"),
        { input: { defaultJiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b` } },
      ),
    );

    activateTab(screen.getByRole("tab", { name: "Enter manually" }));
    fireEvent.change(screen.getByLabelText("Repository owner/name"), {
      target: { value: "acme/platform" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("AddGitHubRepository"),
        expect.objectContaining({
          input: expect.objectContaining({ nameWithOwner: "acme/platform" }),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    activateTab(await screen.findByRole("tab", { name: "Repositories" }));
    const repositoryPicker = await screen.findByRole("combobox", {
      name: "Repository",
    });
    fireEvent.click(repositoryPicker);
    expect(
      await screen.findByRole("option", { name: "acme/platform" }),
    ).toBeDefined();
  });
});
