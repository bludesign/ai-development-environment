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

import { PullRequestDetailPage } from "./pull-request-detail-page";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const pipeline = {
  id: "check-suite-1",
  name: "CI",
  status: "FAILURE",
  url: "https://github.com/acme/widgets/actions/runs/1",
  checkSuiteId: "check-suite-1",
  canRetry: true,
  retryUnavailableReason: null,
  workflowRunId: "run-1",
  workflowId: "workflow-1",
  runNumber: 1,
  runAttempt: 1,
  jobs: [
    {
      id: "job-11",
      name: "test",
      status: "FAILURE",
      url: "https://github.com/acme/widgets/actions/runs/1/job/11",
      canRetry: true,
      retryUnavailableReason: null,
      steps: [
        { number: 1, name: "Set up job", status: "SUCCESS" },
        { number: 2, name: "Run tests", status: "FAILURE" },
      ],
    },
  ],
};

const detail = {
  id: "pull-request-1",
  codebaseRepositoryId: "codebase-repository-1",
  number: 17,
  title: "APP-42 Add the API",
  url: "https://github.com/acme/widgets/pull/17",
  repositoryGithubId: "repository-1",
  repositoryNameWithOwner: "acme/widgets",
  repositoryUrl: "https://github.com/acme/widgets",
  labels: ["backend"],
  jiraKey: "APP-42",
  pipelineStatus: "FAILURE",
  pipelines: [pipeline],
  reviewDecision: "CHANGES_REQUESTED",
  unresolvedReviewThreadCount: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  body: "Detailed pull request description",
  bodyHtml:
    "<p>Detailed pull request description</p><details><summary>Original prompt</summary><strong>Formatted prompt</strong></details>",
  author: {
    login: "octocat",
    avatarUrl: "https://avatars.example/octocat",
    url: "https://github.com/octocat",
  },
  assignees: [],
  reviewThreads: [
    {
      id: "thread-1",
      isResolved: true,
      isOutdated: false,
      subjectType: "LINE",
      path: "src/index.ts",
      line: 12,
      startLine: null,
      originalLine: 12,
      originalStartLine: null,
      viewerCanReply: true,
      viewerCanResolve: false,
      viewerCanUnresolve: true,
      resolvedBy: null,
      pullRequest: {
        id: "pull-request-1",
        number: 17,
        title: "APP-42 Add the API",
        url: "https://github.com/acme/widgets/pull/17",
        repositoryNameWithOwner: "acme/widgets",
      },
      rootComment: {
        id: "comment-1",
        body: "Review this line",
        bodyText: "Review this line",
        bodyHtml: "<p>Review this line</p>",
        url: "https://github.com/acme/widgets/pull/17#discussion_r1",
        author: {
          login: "reviewer",
          avatarUrl: "https://avatars.example/reviewer",
          url: "https://github.com/reviewer",
        },
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      replies: [],
    },
  ],
  baseRefName: "main",
  headRefName: "feature/app-42",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  additions: 20,
  deletions: 5,
  changedFiles: 3,
  commitCount: 2,
  updatedAt: "2026-07-15T00:00:00.000Z",
  mergedAt: null,
  worktreeId: "worktree-1",
};

beforeEach(() => {
  window.history.replaceState(null, "", "/pull-requests/acme/widgets/17");
  requestMock.mockImplementation(async (query) => {
    if (query.includes("query GitHubPullRequestDetail")) {
      return { githubPullRequest: detail } as never;
    }
    if (query.includes("RetryGitHubPipeline")) {
      return {
        retryGitHubPipeline: {
          ...pipeline,
          status: "QUEUED",
          canRetry: false,
        },
      } as never;
    }
    if (query.includes("RetryGitHubWorkflowJob")) {
      return { retryGitHubWorkflowJob: true } as never;
    }
    throw new Error(`Unexpected operation: ${query}`);
  });
});

afterEach(() => {
  cleanup();
  requestMock.mockReset();
});

describe("PullRequestDetailPage", () => {
  test("shows description, metadata, pipelines, and retries a check suite", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <PullRequestDetailPage number={17} owner="acme" repository="widgets" />,
    );

    expect(
      await screen.findByRole("heading", { name: "APP-42 Add the API" }),
    ).toBeDefined();
    expect(screen.getByText("Detailed pull request description")).toBeDefined();
    expect(
      screen.getByText("Original prompt").closest("summary"),
    ).not.toBeNull();
    expect(screen.getByText("Formatted prompt").tagName).toBe("STRONG");
    expect(screen.getByText("Review this line")).toBeDefined();
    const descriptionCard = screen
      .getByText("Description")
      .closest('[data-slot="card"]') as HTMLElement;
    fireEvent.click(
      within(descriptionCard).getByRole("button", { name: "Raw" }),
    );
    expect(screen.getByText("Detailed pull request description").tagName).toBe(
      "PRE",
    );
    expect(
      within(descriptionCard).getByRole("button", { name: "Rendered" }),
    ).toBeDefined();
    fireEvent.click(
      within(descriptionCard).getByRole("button", { name: "Copy" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(detail.body));
    expect(screen.getByText("feature/app-42 → main")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "View Worktree" }).getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(screen.getByText("+20")).toBeDefined();
    expect(screen.getByText("−5")).toBeDefined();
    expect(screen.getByText("CI")).toBeDefined();
    expect(screen.getByText("1 jobs")).toBeDefined();
    const jobButton = screen.getByRole("button", {
      name: "Show steps for test",
    });
    expect(jobButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(jobButton);
    expect(jobButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Set up job")).toBeDefined();
    expect(screen.getByText("Run tests")).toBeDefined();
    const stepsPanel = screen.getByText("Steps").parentElement;
    expect(stepsPanel?.className).toContain("w-full");
    expect(stepsPanel?.className).not.toContain("ml-10");
    expect(stepsPanel?.className).not.toContain("mx-4");
    const jobsContainer =
      stepsPanel?.parentElement?.parentElement?.parentElement;
    expect(jobsContainer?.className).toContain("px-4");
    expect(jobsContainer?.className).not.toContain("pl-4");
    const jobViewButton = screen.getByRole("link", {
      name: "View test on GitHub",
    });
    expect(jobViewButton.getAttribute("data-variant")).toBe("outline");
    expect(jobViewButton.getAttribute("data-size")).toBe("sm");
    expect(jobViewButton.textContent).toContain("View");
    expect(screen.getByText("Changes requested")).toBeDefined();
    const jiraBadge = screen.getByRole("button", { name: "APP-42" });
    for (const className of ["rounded-4xl", "px-2", "py-0.5", "text-xs"]) {
      expect(jiraBadge.className).toContain(className);
    }
    expect(
      screen
        .getAllByRole("link", { name: /Open in GitHub/ })[0]
        ?.getAttribute("href"),
    ).toBe(detail.url);

    const pipelineRow = screen.getByRole("row", { name: /CI/ });
    expect(
      screen.getByRole("link", { name: "View all" }).getAttribute("href"),
    ).toBe("/actions?repository=codebase-repository-1&branch=feature%2Fapp-42");
    const actionsButton = within(pipelineRow).getByRole("button", {
      name: "Actions: CI",
    });
    expect(actionsButton.getAttribute("data-variant")).toBe("outline");
    expect(actionsButton.getAttribute("data-size")).toBe("icon-sm");
    fireEvent.pointerDown(actionsButton, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(screen.getByRole("menuitem", { name: "View" })).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "View all" }).getAttribute("href"),
    ).toBe(
      "/actions?repository=codebase-repository-1&branch=feature%2Fapp-42&pipeline=workflow-1",
    );
    expect(screen.getByRole("menuitem", { name: "Cancel" })).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "Force cancel" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RetryGitHubPipeline"),
        { repositoryId: "repository-1", checkSuiteId: "check-suite-1" },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry test" }));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("RetryGitHubWorkflowJob"),
        {
          repositoryId: "repository-1",
          checkSuiteId: "check-suite-1",
          jobId: "job-11",
        },
      ),
    );
  });

  test("cancels an active pipeline with the pull request repository", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("query GitHubPullRequestDetail")) {
        return {
          githubPullRequest: {
            ...detail,
            pipelineStatus: "PENDING",
            pipelines: [
              {
                ...pipeline,
                status: "IN_PROGRESS",
                canRetry: false,
                retryUnavailableReason: "NOT_COMPLETED",
              },
            ],
          },
        } as never;
      }
      if (query.includes("CancelGitHubActionsWorkflowRun")) {
        return { cancelGitHubActionsWorkflowRun: true } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(
      <PullRequestDetailPage number={17} owner="acme" repository="widgets" />,
    );
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Actions: CI" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith(
        expect.stringContaining("CancelGitHubActionsWorkflowRun"),
        {
          codebaseRepositoryId: "codebase-repository-1",
          workflowRunId: "run-1",
          force: false,
        },
      ),
    );
    expect(screen.getByText("Cancelled")).toBeDefined();
  });
});
