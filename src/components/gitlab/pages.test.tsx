import {
  act,
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
    memberProjectsOnly: true,
    defaultSquash: true,
    defaultMoveTicketToDone: false,
    defaultDeleteWorktree: false,
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
  window.history.replaceState(null, "", "/gitlab/merge-requests");
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

describe("GitLabMergeRequestsPage", () => {
  test("manages discovery and merge defaults and accepts a namespace path", async () => {
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("query GitLabMergeRequests"))
        return {
          gitlabMergeRequests: {
            items: [mergeRequest],
            total: 1,
            page: 1,
            perPage: 25,
            nextPage: null,
          },
        } as never;
      if (query.includes("query GitLabAvailableProjects"))
        return {
          gitlabAvailableProjects: {
            items: [],
            total: 0,
            page: 1,
            perPage: 50,
            nextPage: null,
          },
        } as never;
      if (query.includes("mutation SaveGitLabPreferences"))
        return {
          saveGitLabPreferences: {
            ...configuration.gitlabSettings,
            ...(variables as { input: object }).input,
          },
        } as never;
      if (query.includes("mutation AddGitLabProject"))
        return { addGitLabProject: configuration.gitlabProjects } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);
    await screen.findByText("Add the API");
    fireEvent.click(
      screen.getByRole("button", { name: "Manage GitLab projects" }),
    );
    const members = screen.getByRole("checkbox", {
      name: "Only discover projects where I am a member",
    });
    const squash = screen.getByRole("checkbox", {
      name: "Check Squash commits by default",
    });
    expect((members as HTMLButtonElement).dataset.state).toBe("checked");
    expect((squash as HTMLButtonElement).dataset.state).toBe("checked");
    fireEvent.click(members);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Move linked Jira tickets to Done by default",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            query.includes("mutation SaveGitLabPreferences") &&
            (variables as { input: { memberProjectsOnly: boolean } }).input
              .memberProjectsOnly === false,
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Enter manually" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project ID or namespace path" }),
      { target: { value: "acme/mobile" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(
          ([query, variables]) =>
            query.includes("mutation AddGitLabProject") &&
            (variables as { projectId: string }).projectId === "acme/mobile",
        ),
      ).toBe(true),
    );
  });

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
      screen.getByRole("tab", { name: "Mine" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("keeps failed merge follow-ups available after the Open list removes the merged request", async () => {
    let merged = false;
    const operation = {
      id: "merge-operation-1",
      state: "ACTION_REQUIRED",
      autoMerge: false,
      worktreeId: null,
      ticketKey: "APP-17",
      lastError: "Jira unavailable",
      mergeConfirmedAt: "2026-09-29T12:00:00.000Z",
      ticketMovedAt: null,
      worktreeDeletedAt: null,
      updatedAt: "2026-09-29T12:00:00.000Z",
    };
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("query GitLabMergeRequests")) {
        expect(variables).toEqual({
          scope: "MINE",
          projectId: null,
          state: "OPENED",
          page: 1,
        });
        return {
          gitlabMergeRequests: {
            items: merged ? [] : [mergeRequest],
            total: merged ? 0 : 1,
            page: 1,
            perPage: 25,
            nextPage: null,
          },
        } as never;
      }
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return {
          gitlabMergeRequestMergeOptions: {
            ...mergeRequest,
            mergeMethod: "merge",
            squashPolicy: "default_off",
            squash: false,
            removeSourceBranch: false,
            canRemoveSourceBranch: true,
            canMerge: true,
            canAutoMerge: false,
            canCancelAutoMerge: false,
            autoMergeEnabled: false,
            mergeBlockedReason: null,
            autoMergeBlockedReason: null,
            mergeCommitMessage: null,
            squashCommitMessage: null,
            worktreeId: null,
            worktreeFolder: null,
            canDeleteWorktree: false,
            ticketKey: "APP-17",
            ticketDoneStatusConfigured: true,
            defaultMoveTicketToDone: true,
            defaultDeleteWorktree: false,
            operation: null,
          },
        } as never;
      if (query.includes("mutation SubmitGitLabMergeRequestMerge")) {
        merged = true;
        return {
          submitGitLabMergeRequestMerge: {
            mergeRequest: { ...mergeRequest, state: "MERGED" },
            operation,
            postMergeError: "Jira unavailable",
          },
        } as never;
      }
      if (query.includes("mutation RetryGitLabMergeFollowUps"))
        return {
          retryGitLabMergeFollowUps: {
            mergeRequest: { ...mergeRequest, state: "MERGED" },
            operation: { ...operation, state: "COMPLETED", lastError: null },
            postMergeError: null,
          },
        } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(<GitLabMergeRequestsPage />);
    fireEvent.pointerDown(
      await screen.findByRole("button", { name: "Actions: !17" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));

    await screen.findByText("No merge requests match these filters.");
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Jira unavailable")).toBeDefined();
    expect(
      screen.getByText("The merge succeeded, but a follow-up needs attention."),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry follow-ups" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      requestMock.mock.calls.filter(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toHaveLength(1);
    expect(
      requestMock.mock.calls.filter(([query]) =>
        query.includes("mutation RetryGitLabMergeFollowUps"),
      ),
    ).toEqual([
      [
        expect.any(String),
        { projectId: mergeRequest.projectId, iid: mergeRequest.iid },
      ],
    ]);
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
      await screen.findByText(
        "GitLab took too long to respond. Retry or choose a project to narrow the results.",
      ),
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

  test("requires a project for All accessible and loads an unmanaged selection", async () => {
    window.history.replaceState(null, "", "/gitlab/merge-requests?scope=ALL");
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("GitLabAccessibleProjects"))
        return {
          gitlabAccessibleProjects: {
            items: [{ id: "remote-9", pathWithNamespace: "outside/mobile" }],
            page: 1,
            perPage: 25,
            total: 1,
            nextPage: null,
          },
        } as never;
      if (query.includes("query GitLabMergeRequests")) {
        expect(variables).toEqual({
          scope: "ALL",
          projectId: "remote-9",
          state: "OPENED",
          page: 1,
        });
        return {
          gitlabMergeRequests: {
            items: [
              {
                ...mergeRequest,
                projectId: "remote-9",
                projectPath: "outside/mobile",
              },
            ],
            page: 1,
            perPage: 25,
            total: 1,
            nextPage: null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
    render(<GitLabMergeRequestsPage />);
    await screen.findByText(
      "Choose a project to view all its accessible merge requests.",
    );
    expect(
      requestMock.mock.calls.filter(([query]) =>
        query.includes("query GitLabMergeRequests"),
      ),
    ).toHaveLength(0);
    expect(
      (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole("combobox", { name: "Project" }).textContent,
    ).toContain("Choose a project");
    fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
    expect(screen.queryByRole("option", { name: "All projects" })).toBeNull();
    fireEvent.click(
      await screen.findByRole("option", { name: "outside/mobile" }),
    );
    await screen.findByText("Add the API");
    expect(
      screen.getByRole("combobox", { name: "Project" }).textContent,
    ).toContain("outside/mobile");
    expect(new URLSearchParams(window.location.search).get("project")).toBe(
      "remote-9",
    );
  });

  test("restores URL state and keeps personal scope independent of the project", async () => {
    window.history.replaceState(
      null,
      "",
      "/gitlab/merge-requests?scope=REVIEW_REQUESTED&project=project-1&state=MERGED&page=3",
    );
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("query GitLabMergeRequests"))
        return {
          gitlabMergeRequests: {
            items: [
              {
                ...mergeRequest,
                title: `Scope ${(variables as { scope: string }).scope}`,
              },
            ],
            page: 3,
            perPage: 25,
            total: 51,
            nextPage: null,
          },
        } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });
    render(<GitLabMergeRequestsPage />);
    await screen.findByText("Scope REVIEW_REQUESTED");
    expect(
      requestMock.mock.calls.find(([query]) =>
        query.includes("query GitLabMergeRequests"),
      )?.[1],
    ).toEqual({
      scope: "REVIEW_REQUESTED",
      projectId: "project-1",
      state: "MERGED",
      page: 3,
    });
    fireEvent.click(screen.getByRole("tab", { name: "Mine" }));
    await screen.findByText("Scope MINE");
    expect(
      requestMock.mock.calls
        .filter(([query]) => query.includes("query GitLabMergeRequests"))
        .at(-1)?.[1],
    ).toEqual({
      scope: "MINE",
      projectId: "project-1",
      state: "MERGED",
      page: 1,
    });
    expect(new URLSearchParams(window.location.search).get("page")).toBeNull();
    window.history.replaceState(null, "", "/gitlab/merge-requests?scope=ALL");
    fireEvent.popState(window);
    await screen.findByText(
      "Choose a project to view all its accessible merge requests.",
    );
    expect(screen.queryByText("Scope MINE")).toBeNull();
  });

  test("ignores an old response after changing scope and retains observed project choices", async () => {
    let finishOld: (value: unknown) => void = () => {};
    const old = new Promise((resolve) => {
      finishOld = resolve;
    });
    requestMock.mockImplementation(async (query, variables) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("GitLabAccessibleProjects"))
        return {
          gitlabAccessibleProjects: { items: [], nextPage: null },
        } as never;
      if (query.includes("query GitLabMergeRequests")) {
        if ((variables as { scope: string }).scope === "MINE")
          return old as never;
        return {
          gitlabMergeRequests: {
            items: [
              {
                ...mergeRequest,
                title: "Current review",
                projectId: "unmanaged",
                projectPath: "team/unmanaged",
              },
            ],
            page: 1,
            perPage: 25,
            total: 1,
            nextPage: null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
    render(<GitLabMergeRequestsPage />);
    await waitFor(() =>
      expect(
        requestMock.mock.calls.some(([query]) =>
          query.includes("query GitLabMergeRequests"),
        ),
      ).toBe(true),
    );
    const originalSignal = requestMock.mock.calls.find(([query]) =>
      query.includes("query GitLabMergeRequests"),
    )?.[2]?.signal;
    fireEvent.click(screen.getByRole("tab", { name: "Review requests" }));
    await screen.findByText("Current review");
    expect(originalSignal?.aborted).toBe(true);
    await act(async () =>
      finishOld({
        gitlabMergeRequests: {
          items: [{ ...mergeRequest, title: "Stale result" }],
          page: 1,
          perPage: 25,
          total: 1,
          nextPage: null,
        },
      }),
    );
    expect(screen.queryByText("Stale result")).toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
    fireEvent.click(
      await screen.findByRole("option", { name: "team/unmanaged" }),
    );
    await waitFor(() =>
      expect(
        requestMock.mock.calls
          .filter(([query]) => query.includes("query GitLabMergeRequests"))
          .at(-1)?.[1],
      ).toEqual({
        scope: "REVIEW_REQUESTED",
        projectId: "unmanaged",
        state: "OPENED",
        page: 1,
      }),
    );
  });

  test("restores a same-route navigation from updated server search parameters", async () => {
    requestMock.mockImplementation(async (query) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("query GitLabMergeRequests"))
        return {
          gitlabMergeRequests: {
            items: [mergeRequest],
            total: 1,
            page: 1,
            perPage: 25,
            nextPage: null,
          },
        } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });
    const view = render(<GitLabMergeRequestsPage initialSearch="" />);
    await screen.findByText("Add the API");
    view.rerender(
      <GitLabMergeRequestsPage initialSearch="scope=REVIEW_REQUESTED&project=project-1&state=CLOSED" />,
    );
    await waitFor(() =>
      expect(
        requestMock.mock.calls
          .filter(([query]) => query.includes("query GitLabMergeRequests"))
          .at(-1)?.[1],
      ).toEqual({
        scope: "REVIEW_REQUESTED",
        projectId: "project-1",
        state: "CLOSED",
        page: 1,
      }),
    );
    expect(
      screen
        .getByRole("tab", { name: "Review requests" })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  test("retries a friendly timeout without showing an empty result", async () => {
    let attempts = 0;
    requestMock.mockImplementation(async (query) => {
      if (query.includes("GitLabPageConfiguration"))
        return configuration as never;
      if (query.includes("query GitLabMergeRequests")) {
        if (attempts++ === 0)
          throw new Error("GitLab API request failed (408)");
        return {
          gitlabMergeRequests: {
            items: [mergeRequest],
            page: 1,
            perPage: 25,
            total: 1,
            nextPage: null,
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });
    render(<GitLabMergeRequestsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await screen.findByText("Add the API");
    expect(screen.queryByRole("alert")).toBeNull();
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
    ).toBe("/dashboard/worktrees/worktree-1");
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
