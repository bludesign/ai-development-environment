import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import type { GitLabPipelineView } from "@/services/gitlab/types";

import type { Worktree, WorktreeQuickAction } from "./types";
import { WorktreeFailingPipelineItem } from "./worktree-failing-pipeline-item";
import { WorktreeRunBadges } from "./worktree-run-badges";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe: () => () => undefined }),
  onControlPlaneRecovery: () => () => undefined,
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const workflow: WorktreeQuickAction = {
  id: "diagnose",
  name: "Diagnose CI failure",
  description: "Investigate CI",
  quickActionButtonVariant: "outline",
  quickActionIconKey: "search",
  hasPlainTrigger: true,
};
const pipeline = (
  id: string,
  source: string,
  status: GitLabPipelineView["status"],
  sha = "current-head",
) =>
  ({
    id,
    projectId: "44",
    source,
    sha,
    status,
    webUrl: `https://gitlab.example/pipelines/${id}`,
  }) as GitLabPipelineView;
const gitlabWorktree = (gitLabPipelines: GitLabPipelineView[]) =>
  ({ id: "worktree-1", headSha: "current-head", gitLabPipelines }) as Worktree;

test("uses the newest GitLab pipeline per source and sends only current failures", async () => {
  const run = {
    id: "run-1",
    workflowId: workflow.id,
    status: "RUNNING",
    displayNumber: 1,
  };
  let activeRuns: (typeof run)[] = [];
  vi.mocked(controlPlaneRequest).mockImplementation(async (query) => {
    if (query.includes("RunWorktreeQuickAction")) {
      activeRuns = [run];
      return { triggerWorkflow: run };
    }
    return {
      workflowTargetSummaries: [
        { resourceKind: "WORKTREE", resourceId: "worktree-1", activeRuns },
      ],
    };
  });
  const worktree = gitlabWorktree([
    pipeline("9", "push", "FAILED"),
    pipeline("10", "push", "RUNNING"),
    pipeline("11", "merge_request_event", "FAILED"),
    pipeline("12", "web", "FAILED", "older-head"),
  ]);
  const { rerender } = render(
    <WorktreeFailingPipelineItem worktree={worktree} workflows={[]} />,
  );
  expect(screen.queryByText("Pipeline failing")).toBeNull();
  rerender(
    <WorktreeFailingPipelineItem worktree={worktree} workflows={[workflow]} />,
  );
  expect(screen.getByText("Pipeline failing")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: workflow.name }));
  await waitFor(() =>
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("RunWorktreeQuickAction"),
      {
        input: {
          workflowId: workflow.id,
          resourceKind: "WORKTREE",
          resourceId: "worktree-1",
          subjectKey: "WORKTREE:worktree-1",
          choice: null,
          sessionData: {
            worktree: {
              failingPipelines: [
                {
                  provider: "GITLAB",
                  id: "11",
                  status: "FAILED",
                  url: "https://gitlab.example/pipelines/11",
                  headSha: "current-head",
                  projectId: "44",
                },
              ],
            },
          },
        },
      },
    ),
  );
  const manageRunning = { name: "Manage running Diagnose CI failure" };
  await screen.findByRole("button", manageRunning);
  rerender(
    <WorktreeFailingPipelineItem
      worktree={gitlabWorktree([
        ...worktree.gitLabPipelines,
        pipeline("13", "merge_request_event", "SUCCESS"),
      ])}
      workflows={[workflow]}
    />,
  );
  expect(screen.queryByText("Pipeline failing")).toBeNull();
  expect(screen.queryByRole("button", { name: workflow.name })).toBeNull();
  expect(screen.getByRole("button", manageRunning)).toBeTruthy();
});

test("uses the linked GitHub pull request rollup and includes its check details", async () => {
  vi.mocked(controlPlaneRequest).mockResolvedValue({
    workflowTargetSummaries: [],
    triggerWorkflow: { id: "run-1" },
  });
  const worktree = {
    ...gitlabWorktree([]),
    pullRequest: {
      repositoryGithubId: "44",
      headRefOid: "pr-head",
      pipelineStatus: "FAILURE",
      pipelines: [
        {
          id: "check-1",
          workflowRunId: "987",
          status: "TIMED_OUT",
          url: "https://github.com/acme/app/actions/runs/987",
        },
        { id: "check-2", status: "SUCCESS" },
      ],
    },
  } as Worktree;
  render(
    <WorktreeFailingPipelineItem worktree={worktree} workflows={[workflow]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: workflow.name }));
  await waitFor(() =>
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("RunWorktreeQuickAction"),
      expect.objectContaining({
        input: expect.objectContaining({
          sessionData: {
            worktree: {
              failingPipelines: [
                {
                  provider: "GITHUB",
                  id: "check-1",
                  workflowRunId: "987",
                  status: "TIMED_OUT",
                  url: "https://github.com/acme/app/actions/runs/987",
                  headSha: "pr-head",
                  repositoryGithubId: "44",
                },
              ],
            },
          },
        }),
      }),
    ),
  );
});

test("shows both kinds of work in progress and clears zero-count badges", () => {
  const { rerender } = render(
    <WorktreeRunBadges
      counts={{ worktreeId: "a", sessionCount: 2, planCount: 1 }}
    />,
  );
  expect(screen.getByText(/sessions in progress/)).toBeTruthy();
  expect(screen.getByText(/plan in progress/)).toBeTruthy();
  rerender(
    <WorktreeRunBadges
      counts={{ worktreeId: "a", sessionCount: 0, planCount: 0 }}
    />,
  );
  expect(screen.queryByText(/in progress/)).toBeNull();
});
