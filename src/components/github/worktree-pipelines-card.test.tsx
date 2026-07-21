import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubActionsWorkflowRunView } from "@/services/github/types";

import { WorktreePipelinesCard } from "./worktree-pipelines-card";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

const run: GitHubActionsWorkflowRunView = {
  id: "run-1",
  workflowId: "workflow-1",
  repositoryGithubId: "repository-1",
  codebaseRepositoryId: "codebase-repository-1",
  repositoryNameWithOwner: "acme/widgets",
  repositoryUrl: "https://github.com/acme/widgets",
  name: "CI",
  displayTitle: "Feature build",
  runNumber: 12,
  runAttempt: 1,
  event: "push",
  status: "SUCCESS",
  url: "https://github.com/acme/widgets/actions/runs/1",
  headBranch: "feature/APP-1",
  headSha: "abc123",
  checkSuiteId: "check-suite-1",
  canRetry: true,
  retryUnavailableReason: null,
  pullRequests: [],
  jiraKey: "APP-1",
  worktreeId: "worktree-1",
  startedAt: "2026-07-21T12:00:00.000Z",
  createdAt: "2026-07-21T12:00:00.000Z",
  updatedAt: "2026-07-21T12:01:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.mocked(controlPlaneRequest).mockReset();
});

describe("WorktreePipelinesCard", () => {
  test("uses the pull request pipeline table and expandable job layout", async () => {
    vi.mocked(controlPlaneRequest).mockResolvedValue({
      githubActionsWorkflowJobs: [
        {
          id: "job-1",
          name: "build-and-test",
          status: "SUCCESS",
          url: "https://github.com/acme/widgets/actions/jobs/1",
          canRetry: true,
          retryUnavailableReason: null,
          steps: [{ number: 1, name: "Checkout", status: "SUCCESS" }],
        },
      ],
    } as never);

    render(
      <WorktreePipelinesCard
        branch="feature/APP-1"
        error={null}
        onCancelled={vi.fn()}
        onError={vi.fn()}
        onRetried={vi.fn()}
        runs={[run]}
        worktreeId="worktree-1"
      />,
    );

    const pipelineRow = await screen.findByRole("row", { name: /CI Passed/ });
    expect(
      screen.getByRole("link", { name: "View all" }).getAttribute("href"),
    ).toBe("/actions?repository=codebase-repository-1&branch=feature%2FAPP-1");
    fireEvent.pointerDown(
      within(pipelineRow).getByRole("button", {
        name: "Actions: Feature build",
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(screen.getByRole("menuitem", { name: "View" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Retry" })).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "View all" }).getAttribute("href"),
    ).toBe(
      "/actions?repository=codebase-repository-1&branch=feature%2FAPP-1&pipeline=workflow-1",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "View all" }));
    expect(screen.getByText("1 jobs")).toBeDefined();

    const showSteps = screen.getByRole("button", {
      name: "Show steps for build-and-test",
    });
    fireEvent.click(showSteps);
    expect(screen.getByText("Checkout")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "View build-and-test on GitHub" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Retry build-and-test" }),
    ).toBeDefined();
  });

  test("cancels an active workflow run from the pipeline menu", async () => {
    const onCancelled = vi.fn();
    vi.mocked(controlPlaneRequest).mockImplementation(async (query) => {
      if (query.includes("WorktreePipelineJobs")) {
        return { githubActionsWorkflowJobs: [] } as never;
      }
      if (query.includes("CancelGitHubActionsWorkflowRun")) {
        return { cancelGitHubActionsWorkflowRun: true } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(
      <WorktreePipelinesCard
        branch="feature/APP-1"
        error={null}
        onCancelled={onCancelled}
        onError={vi.fn()}
        onRetried={vi.fn()}
        runs={[
          {
            ...run,
            status: "IN_PROGRESS",
            canRetry: false,
            retryUnavailableReason: "NOT_COMPLETED",
          },
        ]}
        worktreeId="worktree-1"
      />,
    );

    fireEvent.pointerDown(
      await screen.findByRole("button", {
        name: "Actions: Feature build",
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    expect(
      screen.getByRole("menuitem", { name: "Force cancel" }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));

    await waitFor(() =>
      expect(controlPlaneRequest).toHaveBeenCalledWith(
        expect.stringContaining("CancelGitHubActionsWorkflowRun"),
        {
          codebaseRepositoryId: "codebase-repository-1",
          workflowRunId: "run-1",
          force: false,
        },
      ),
    );
    expect(onCancelled).toHaveBeenCalledWith("run-1");
  });
});
