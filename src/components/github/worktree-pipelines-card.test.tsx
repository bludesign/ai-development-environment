import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitHubActionsWorkflowRunView } from "@/services/github/types";

import { WorktreePipelinesCard } from "./worktree-pipelines-card";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

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
        onError={vi.fn()}
        runs={[run]}
        worktreeId="worktree-1"
      />,
    );

    const pipelineRow = await screen.findByRole("row", { name: /CI Passed/ });
    expect(
      within(pipelineRow).getByRole("link", { name: "View" }),
    ).toBeDefined();
    expect(
      within(pipelineRow).getByRole("button", { name: "Retry" }),
    ).toBeDefined();
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
});
