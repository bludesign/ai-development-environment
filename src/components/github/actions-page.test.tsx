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
            ? [{ ...run, id: "43", runNumber: 43, displayTitle: "Older run" }]
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

  test("renders related links, filters and paginates runs", async () => {
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
    expect(
      within(row)
        .getAllByRole("link", { name: "View" })
        .find((link) => link.getAttribute("href")?.startsWith("/worktrees/"))
        ?.getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(screen.getByText("acme/private:")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Older run")).toBeDefined();
    expect(requestMock).toHaveBeenCalledWith(
      expect.stringContaining("query GitHubActionsWorkflowRuns"),
      expect.objectContaining({ after: "cursor-1" }),
    );

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
    fireEvent.click(expandRun);

    const expandJob = await screen.findByRole("button", {
      name: "Show steps for test",
    });
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
    fireEvent.click(within(runRow).getByRole("button", { name: "Retry" }));
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
