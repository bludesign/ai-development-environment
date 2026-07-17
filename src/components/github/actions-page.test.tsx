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

import { ActionsPage } from "./actions-page";

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

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const run = {
  id: "44",
  repositoryGithubId: "repository-1",
  codebaseRepositoryId: "codebase-repository-1",
  repositoryNameWithOwner: "acme/widgets",
  repositoryUrl: "https://github.com/acme/widgets",
  name: "CI",
  displayTitle: "APP-42 Ship widgets",
  runNumber: 44,
  runAttempt: 1,
  event: "pull_request",
  status: "FAILURE",
  url: "https://github.com/acme/widgets/actions/runs/44",
  headBranch: "feature/APP-42",
  headSha: "abcdef123456",
  checkSuiteId: "check-suite-44",
  canRetry: true,
  retryUnavailableReason: null,
  pullRequests: [
    { number: 17, url: "https://github.com/acme/widgets/pull/17" },
  ],
  jiraKey: "APP-42",
  worktreeId: "worktree-1",
  startedAt: "2026-07-17T12:00:00.000Z",
  createdAt: "2026-07-17T12:00:00.000Z",
  updatedAt: "2026-07-17T12:05:00.000Z",
};

const jobs = [
  {
    id: "441",
    name: "test",
    status: "FAILURE",
    url: "https://github.com/acme/widgets/actions/runs/44/job/441",
    canRetry: true,
    retryUnavailableReason: null,
    steps: [
      { number: 1, name: "Set up job", status: "SUCCESS" },
      { number: 2, name: "Run tests", status: "FAILURE" },
    ],
  },
];

beforeEach(() => {
  global.ResizeObserver = ResizeObserverMock;
  global.IntersectionObserver =
    IntersectionObserverMock as unknown as typeof IntersectionObserver;
  intersectionCallback = null;
  intersectionTarget = null;
  intersectionObserver = null;
  window.history.replaceState(null, "", "/actions");
  requestMock.mockImplementation(async (query, variables) => {
    if (query.includes("GitHubActionsConfiguration")) {
      return {
        githubSettings: {
          tokenConfigured: true,
          defaultJiraKeyRegex: String.raw`\b([A-Z]+-\d+)\b`,
          updatedAt: new Date(0).toISOString(),
        },
      } as never;
    }
    if (query.includes("query GitHubActionsWorkflowRuns")) {
      const filtered = variables?.codebaseRepositoryId;
      const after = variables?.after;
      return {
        githubActionsWorkflowRuns: {
          items: after
            ? [
                {
                  ...run,
                  id: "43",
                  runNumber: 43,
                  displayTitle: "Older run",
                  startedAt: "2026-07-16T12:00:00.000Z",
                  createdAt: "2026-07-16T12:00:00.000Z",
                  updatedAt: "2026-07-16T12:05:00.000Z",
                },
              ]
            : [run],
          repositories: [
            {
              id: "codebase-repository-1",
              nameWithOwner: "acme/widgets",
              url: "https://github.com/acme/widgets",
            },
          ],
          repositoryErrors: filtered
            ? []
            : [
                {
                  codebaseRepositoryId: "codebase-repository-2",
                  nameWithOwner: "acme/private",
                  message: "Resource not accessible by token",
                },
              ],
          hasNextPage: !after,
          endCursor: after ? null : "cursor-1",
        },
      } as never;
    }
    if (query.includes("query GitHubActionsWorkflowJobs")) {
      return { githubActionsWorkflowJobs: jobs } as never;
    }
    if (query.includes("RetryGitHubWorkflowJob")) {
      return { retryGitHubWorkflowJob: true } as never;
    }
    if (query.includes("RetryGitHubPipeline")) {
      return {
        retryGitHubPipeline: {
          id: "check-suite-44",
          name: "CI",
          status: "QUEUED",
          url: run.url,
          checkSuiteId: "check-suite-44",
          canRetry: false,
          retryUnavailableReason: "NOT_COMPLETED",
          jobs: [],
        },
      } as never;
    }
    if (query.includes("query JiraTicket")) {
      throw new Error("Jira is not configured in this test");
    }
    throw new Error(`Unexpected operation: ${query}`);
  });
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("ActionsPage", () => {
  test("shows credential and codebase empty states", async () => {
    requestMock.mockResolvedValueOnce({
      githubSettings: {
        tokenConfigured: false,
        defaultJiraKeyRegex: "",
        updatedAt: new Date(0).toISOString(),
      },
    } as never);
    const credentialView = render(<ActionsPage />);
    expect(
      await screen.findByText("Connect GitHub to view Actions"),
    ).toBeDefined();
    credentialView.unmount();

    requestMock.mockImplementation(async (query) => {
      if (query.includes("GitHubActionsConfiguration")) {
        return {
          githubSettings: {
            tokenConfigured: true,
            defaultJiraKeyRegex: "",
            updatedAt: new Date(0).toISOString(),
          },
        } as never;
      }
      return {
        githubActionsWorkflowRuns: {
          items: [],
          repositories: [],
          repositoryErrors: [],
          hasNextPage: false,
          endCursor: null,
        },
      } as never;
    });
    render(<ActionsPage />);
    expect(await screen.findByText("No GitHub codebases")).toBeDefined();
  });

  test("renders related links, filters and infinitely paginates runs", async () => {
    render(<ActionsPage />);

    expect(
      await screen.findByRole("heading", { name: "GitHub Actions" }),
    ).toBeDefined();
    const row = await screen.findByRole("row", {
      name: /APP-42 Ship widgets/,
    });
    expect(
      within(row).getByRole("link", { name: "#17" }).getAttribute("href"),
    ).toBe("/pull-requests/acme/widgets/17");
    const workflowLink = within(row)
      .getAllByRole("link")
      .find((link) => link.getAttribute("href") === run.url);
    expect(workflowLink?.getAttribute("href")).toBe(run.url);
    expect(workflowLink?.className).toContain("hover:bg-muted");
    expect(workflowLink?.className).not.toContain("hover:underline");
    expect(within(row).getByText("Duration 5m")).toBeDefined();
    expect(
      within(row).getByRole("button", { name: "APP-42" }).className,
    ).toContain("hover:bg-primary/80");
    const expandRun = within(row).getByRole("button", {
      name: "Show jobs for APP-42 Ship widgets",
    });
    fireEvent.pointerDown(
      within(row).getByRole("button", {
        name: "Actions: APP-42 Ship widgets",
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(expandRun.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByRole("menuitem", { name: "View" }).getAttribute("href"),
    ).toBe(run.url);
    expect(
      screen.getByRole("menuitem", { name: "Worktree" }).getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByText("acme/private:")).toBeDefined();

    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    act(() => {
      intersectPaginationTrigger();
      intersectPaginationTrigger();
    });
    expect(await screen.findByText("Older run")).toBeDefined();
    expect(screen.getByText("Friday, July 17, 2026")).toBeDefined();
    expect(screen.getByText("Thursday, July 16, 2026")).toBeDefined();
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining("query GitHubActionsWorkflowRuns"),
      expect.objectContaining({ after: "cursor-1" }),
    );
    expect(
      requestMock.mock.calls.filter(
        ([query, variables]) =>
          String(query).includes("query GitHubActionsWorkflowRuns") &&
          variables?.after === "cursor-1",
      ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("combobox", { name: "Repository" }));
    fireEvent.click(screen.getByRole("option", { name: "acme/widgets" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("query GitHubActionsWorkflowRuns"),
        expect.objectContaining({
          codebaseRepositoryId: "codebase-repository-1",
          after: null,
        }),
      ),
    );

    const filteredRow = await screen.findByRole("row", {
      name: /APP-42 Ship widgets/,
    });
    fireEvent.click(
      within(filteredRow).getByRole("button", { name: "APP-42" }),
    );
    expect(window.location.search).toBe("?issue=APP-42");
  });

  test("expands runs and jobs, shows steps, and retries a job", async () => {
    render(<ActionsPage />);
    const expandRun = await screen.findByRole("button", {
      name: "Show jobs for APP-42 Ship widgets",
    });
    const runRow = expandRun.closest("tr") as HTMLTableRowElement;
    fireEvent.click(runRow);
    expect(expandRun.getAttribute("aria-expanded")).toBe("true");

    const expandJob = await screen.findByRole("button", {
      name: "Show steps for test",
    });
    const pullRequestLink = within(runRow).getByRole("link", { name: "#17" });
    pullRequestLink.addEventListener(
      "click",
      (event) => event.preventDefault(),
      {
        once: true,
      },
    );
    fireEvent.click(pullRequestLink);
    expect(expandRun.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(expandJob);
    expect(screen.getByText("Set up job")).toBeDefined();
    expect(screen.getByText("Run tests")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry test" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RetryGitHubWorkflowJob"),
        {
          repositoryId: "repository-1",
          checkSuiteId: "check-suite-44",
          jobId: "441",
        },
      ),
    );
    expect(screen.getAllByText("Queued").length).toBeGreaterThanOrEqual(1);
  });

  test("retries a workflow run and collapses stale job details", async () => {
    render(<ActionsPage />);
    const expandRun = await screen.findByRole("button", {
      name: "Show jobs for APP-42 Ship widgets",
    });
    fireEvent.click(expandRun);
    await screen.findByRole("button", { name: "Show steps for test" });

    const runRow = screen.getByRole("row", { name: /APP-42 Ship widgets/ });
    fireEvent.pointerDown(
      within(runRow).getByRole("button", {
        name: "Actions: APP-42 Ship widgets",
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RetryGitHubPipeline"),
        { repositoryId: "repository-1", checkSuiteId: "check-suite-44" },
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Show steps for test" }),
    ).toBeNull();
    expect(within(runRow).getByText("Queued")).toBeDefined();
  });
});
