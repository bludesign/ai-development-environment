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
        });
        return { gitlabMergeRequests: { items: [mergeRequest] } } as never;
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
});

describe("GitLabPipelinesPage", () => {
  test("expands a pipeline row and shows jobs with status colors", async () => {
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration")) {
        return configuration as never;
      }
      if (query.includes("query GitLabPipelines")) {
        return {
          gitlabPipelines: {
            items: [
              {
                id: "9401",
                projectId: "project-1",
                iid: "214",
                ref: "feature/retry-diagnostics",
                branch: "feature/retry-diagnostics",
                sha: "abcdef1234567890",
                source: "push",
                status: "RUNNING",
                webUrl: "https://gitlab.com/acme/widgets/-/pipelines/9401",
                mergeRequests: [
                  {
                    projectId: "project-1",
                    iid: 17,
                    title: "Improve pipeline retry diagnostics",
                    webUrl:
                      "https://gitlab.com/acme/widgets/-/merge_requests/17",
                    sourceBranch: "feature/retry-diagnostics",
                  },
                ],
                worktreeId: "worktree-1",
                worktreeHighlightColor: "violet",
                startedAt: "2026-08-07T12:00:02.000Z",
                createdAt: "2026-08-07T12:00:00.000Z",
                updatedAt: "2026-08-07T12:01:00.000Z",
                finishedAt: null,
                duration: 61,
                queuedDuration: 2,
              },
            ],
          },
          gitlabAutoRetryRules: [],
        } as never;
      }
      if (query.includes("query GitLabPipelineJobs")) {
        expect(variables).toEqual({
          projectId: "project-1",
          pipelineId: "9401",
        });
        return {
          gitlabPipelineJobs: [
            {
              id: "job-1",
              pipelineId: "9401",
              name: "unit",
              stage: "test",
              status: "SUCCESS",
              ref: "feature/retry-diagnostics",
              webUrl: "https://gitlab.com/acme/widgets/-/jobs/job-1",
              allowFailure: false,
              createdAt: "2026-08-07T12:00:00.000Z",
              startedAt: "2026-08-07T12:00:01.000Z",
              finishedAt: "2026-08-07T12:01:00.000Z",
              duration: 59,
              queuedDuration: 1,
              retried: false,
            },
            {
              id: "job-2",
              pipelineId: "9401",
              name: "lint",
              stage: "verify",
              status: "FAILED",
              ref: "feature/retry-diagnostics",
              webUrl: "https://gitlab.com/acme/widgets/-/jobs/job-2",
              allowFailure: false,
              createdAt: "2026-08-07T12:00:00.000Z",
              startedAt: "2026-08-07T12:00:01.000Z",
              finishedAt: "2026-08-07T12:00:30.000Z",
              duration: 29,
              queuedDuration: 1,
              retried: false,
            },
          ],
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabPipelinesPage />);

    const expand = await screen.findByRole("button", {
      name: "Show jobs for #9401 · feature/retry-diagnostics",
    });
    expect(screen.getByRole("columnheader", { name: "Branch" })).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Merge request" }),
    ).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Started" })).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "feature/retry-diagnostics" })
        .getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(
      screen
        .getByRole("link", {
          name: "!17 · Improve pipeline retry diagnostics",
        })
        .getAttribute("href"),
    ).toBe("/gitlab/merge-requests/project-1/17");
    expect(screen.getByText("Duration 1m 1s")).toBeDefined();
    expect(screen.getByText("RUNNING").className).toContain("amber-500");
    expect(screen.getByText("RUNNING").closest("tr")?.className).toContain(
      "violet-500",
    );

    fireEvent.click(expand);

    expect(await screen.findByText("test / unit")).toBeDefined();
    expect(screen.getByText("SUCCESS").className).toContain("emerald-500");
    expect(screen.getByText("FAILED").className).toContain("red-500");
    expect(screen.getByText("Duration 59s")).toBeDefined();
    expect(screen.getByText("Duration 29s")).toBeDefined();
    expect(screen.getAllByText("Started")).toHaveLength(3);
    expect(
      (
        screen.getByRole("button", {
          name: "Retry unit",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Retry lint",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Hide jobs for #9401 · feature/retry-diagnostics",
      }),
    );
    expect(screen.queryByText("test / unit")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show jobs for #9401 · feature/retry-diagnostics",
      }),
    );
    expect(screen.getByText("test / unit")).toBeDefined();
    expect(
      requestMock.mock.calls.filter(([query]) =>
        query.includes("query GitLabPipelineJobs"),
      ),
    ).toHaveLength(1);
  });
});
