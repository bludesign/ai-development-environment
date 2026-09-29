import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { GitLabMergeRequestsPage, GitLabPipelinesPage } from "./pages";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneSubscriptions: vi.fn(() => ({ subscribe: vi.fn(() => vi.fn()) })),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
  controlPlaneRequest: vi.fn(),
}));

const requestMock = vi.mocked(controlPlaneRequest);

const configuration = {
  gitlabSettings: {
    configured: true,
    baseUrl: "https://gitlab.com",
    version: "19.2.0",
    tokenConfigured: true,
  },
  gitlabProjects: [
    {
      id: "project-1",
      name: "widgets",
      pathWithNamespace: "acme/widgets",
      webUrl: "https://gitlab.com/acme/widgets",
      defaultBranch: "main",
      visibility: "private",
      enabled: true,
      webhookId: null,
      webhookState: "NOT_CONFIGURED",
      webhookError: null,
      webhookConfiguredAt: null,
      webhookLastReceivedAt: null,
    },
  ],
};

const mergeRequest = {
  id: "merge-request-1",
  iid: 17,
  projectId: "project-1",
  title: "Add the API",
  description: "",
  state: "OPENED",
  draft: false,
  webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
  sourceBranch: "feature/api",
  targetBranch: "main",
  sha: "abc123",
  author: {
    id: "user-1",
    username: "octocat",
    name: "Octo Cat",
    avatarUrl: null,
    webUrl: "https://gitlab.com/octocat",
  },
  reviewers: [],
  labels: [],
  detailedMergeStatus: "mergeable",
  mergeWhenPipelineSucceeds: false,
  squashOnMerge: false,
  hasConflicts: false,
  blockingDiscussionsResolved: true,
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
  mergedAt: null,
};

beforeEach(() => {
  requestMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("GitLabMergeRequestsPage", () => {
  test("loads authored merge requests by default", async () => {
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration")) {
        return configuration as never;
      }
      if (query.includes("query GitLabMergeRequests")) {
        expect(variables).toEqual({
          scope: "MINE",
          projectId: null,
          state: "OPENED",
          page: 1,
        });
        return {
          gitlabMergeRequests: {
            items: [mergeRequest],
            total: 1,
            page: 1,
            perPage: 25,
            nextPage: null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);

    expect(await screen.findByText("Add the API")).toBeDefined();
    expect(
      screen.getByRole("combobox", { name: "Scope" }).textContent,
    ).toContain("Authored by me");
  });

  test("does not describe a failed request as an empty result", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("GitLabPageConfiguration")) {
        return configuration as never;
      }
      if (query.includes("query GitLabMergeRequests")) {
        throw new Error("GitLab API request failed (408)");
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);

    expect(
      await screen.findByText("GitLab API request failed (408)"),
    ).toBeDefined();
    await waitFor(() => {
      expect(
        screen.queryByText("No merge requests match these filters."),
      ).toBeNull();
    });
  });

  test("loads the next page of merge requests", async () => {
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration")) {
        return configuration as never;
      }
      if (query.includes("query GitLabMergeRequests")) {
        const page = Number((variables as { page: number }).page);
        return {
          gitlabMergeRequests: {
            items: [
              {
                ...mergeRequest,
                id: `merge-request-${page}`,
                title: `Merge request page ${page}`,
              },
            ],
            total: 26,
            page,
            perPage: 25,
            nextPage: page === 1 ? 2 : null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);

    expect(await screen.findByText("Merge request page 1")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Merge request page 2")).toBeDefined();
    expect(
      requestMock.mock.calls.some(
        ([query, variables]) =>
          query.includes("query GitLabMergeRequests") &&
          (variables as { page?: number })?.page === 2,
      ),
    ).toBe(true);
  });
});

describe("GitLabPipelinesPage", () => {
  const pipeline = {
    id: "9401",
    projectId: "project-1",
    iid: "214",
    ref: "feature/retry-diagnostics",
    branch: "feature/retry-diagnostics",
    sha: "abcdef1234567890",
    source: "push",
    status: "FAILED",
    webUrl: "https://gitlab.com/acme/widgets/-/pipelines/9401",
    mergeRequests: [
      {
        projectId: "project-1",
        iid: 17,
        title: "Improve pipeline retry diagnostics",
        webUrl: "https://gitlab.com/acme/widgets/-/merge_requests/17",
        sourceBranch: "feature/retry-diagnostics",
      },
    ],
    worktreeId: "worktree-1",
    worktreeHighlightColor: "violet",
    startedAt: "2026-08-07T12:00:02.000Z",
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:01:03.000Z",
    finishedAt: "2026-08-07T12:01:03.000Z",
    duration: 61,
    queuedDuration: 2,
  };
  beforeEach(() => {
    window.history.replaceState(null, "", "/gitlab/pipelines");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });
  const mockPage = () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("query GitLabPipelines"))
        return {
          gitlabPipelines: {
            items: [pipeline],
            total: 1,
            page: 1,
            perPage: 25,
            nextPage: null,
          },
          gitlabAutoRetryRules: [],
        } as never;
      if (query.includes("query GitLabPipelineDetails"))
        return {
          gitlabPipeline: pipeline,
          gitlabPipelineJobs: [
            {
              id: "job-1",
              pipelineId: "9401",
              name: "unit",
              stage: "test",
              status: "SUCCESS",
              ref: pipeline.ref,
              webUrl: "https://gitlab.com/acme/widgets/-/jobs/job-1",
              allowFailure: false,
              createdAt: pipeline.createdAt,
              startedAt: "2026-08-07T12:00:01.000Z",
              finishedAt: "2026-08-07T12:01:00.000Z",
              duration: 59,
              queuedDuration: 1,
              retried: false,
            },
          ],
        } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });
  };

  test("shows a consistent table with readable statuses, context links and staged job details", async () => {
    mockPage();
    render(<GitLabPipelinesPage />);
    const expand = await screen.findByRole("button", {
      name: "Show jobs for #214 · feature/retry-diagnostics",
    });
    expect(screen.getByRole("columnheader", { name: "Branch" })).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Merge request" }),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "feature/retry-diagnostics" })
        .getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(
      screen.getByText("Improve pipeline retry diagnostics"),
    ).toBeDefined();
    expect(screen.getByText("Failed").closest("tr")?.className).toContain(
      "violet-500",
    );
    expect(screen.getByText("Failed").className).toContain("red-500");
    expect(screen.getByText("Duration 1m 1s")).toBeDefined();
    fireEvent.click(expand);
    expect(
      await screen.findByRole("heading", { name: "Stage · test" }),
    ).toBeDefined();
    expect(screen.getByRole("link", { name: "unit" })).toBeDefined();
    expect(screen.getByText("Success").className).toContain("emerald-500");
    expect(
      (screen.getByRole("button", { name: "Retry unit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide jobs for #214 · feature/retry-diagnostics",
      }),
    );
    expect(screen.queryByRole("link", { name: "unit" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show jobs for #214 · feature/retry-diagnostics",
      }),
    );
    expect(screen.getByRole("link", { name: "unit" })).toBeDefined();
    expect(
      requestMock.mock.calls.filter(([query]) =>
        query.includes("query GitLabPipelineDetails"),
      ),
    ).toHaveLength(1);
  });

  test("restores URL filters and sends them to the provider, then resets pagination for a new branch", async () => {
    mockPage();
    window.history.replaceState(
      null,
      "",
      "/gitlab/pipelines?project=project-1&branch=feature%2Fapi&status=FAILED&source=push&page=3",
    );
    render(<GitLabPipelinesPage />);
    await screen.findByRole("button", {
      name: "Show jobs for #214 · feature/retry-diagnostics",
    });
    expect(
      requestMock.mock.calls.find(([query]) =>
        query.includes("query GitLabPipelines"),
      )?.[1],
    ).toEqual({
      projectId: "project-1",
      page: 3,
      ref: "feature/api",
      status: "FAILED",
      source: "push",
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Filter by branch" }),
      { target: { value: " release " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            query.includes("query GitLabPipelines") &&
            (variables as { ref: string; page: number }).ref === "release" &&
            (variables as { page: number }).page === 1,
        ),
      ).toBe(true),
    );
    expect(new URLSearchParams(window.location.search).get("branch")).toBe(
      "release",
    );
    expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
  });
});
