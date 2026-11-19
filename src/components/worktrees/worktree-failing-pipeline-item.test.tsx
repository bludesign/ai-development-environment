import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { GitHubPipelineStatusProvider } from "@/components/github/pipeline-status-provider";
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
    ref: "feature/ci",
    source,
    sha,
    status,
    webUrl: `https://gitlab.example/pipelines/${id}`,
  }) as GitLabPipelineView;
const gitlabWorktree = (gitLabPipelines: GitLabPipelineView[]) =>
  ({
    id: "worktree-1",
    branch: "feature/ci",
    headSha: "current-head",
    gitLabPipelines,
    sourceControlRequest: {
      provider: "GITLAB",
      projectId: "44",
      number: 5,
      state: "OPENED",
      headRefName: "feature/ci",
      headRefOid: "current-head",
    },
  }) as Worktree;

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

test("does not offer a GitHub quick action when only a different PR commit failed", () => {
  vi.mocked(controlPlaneRequest).mockResolvedValue({
    workflowTargetSummaries: [],
  });
  const worktree = {
    ...gitlabWorktree([]),
    sourceControlRequest: null,
    pullRequest: {
      state: "OPEN",
      repositoryGithubId: "44",
      headRefName: "feature/ci",
      headRefOid: "stale-pr-head",
      pipelineStatus: "FAILURE",
      pipelines: [{ id: "stale-check", status: "FAILURE" }],
    },
  } as Worktree;
  render(
    <WorktreeFailingPipelineItem worktree={worktree} workflows={[workflow]} />,
  );
  expect(screen.queryByText("Pipeline failing")).toBeNull();
  expect(screen.queryByRole("button", { name: workflow.name })).toBeNull();
});

test("watches live pipeline status for an open GitHub pull request", async () => {
  const key = { repositoryGithubId: "44", headSha: "current-head" };
  vi.mocked(controlPlaneRequest).mockImplementation(async (query) => {
    if (query.includes("GitHubPipelineStatuses")) {
      return {
        githubPipelineStatuses: [
          {
            ...key,
            pipelineStatus: "FAILURE",
            pipelines: [{ id: "failed-check", status: "FAILURE" }],
            revision: 1,
          },
        ],
      };
    }
    return {
      workflowTargetSummaries: [
        { resourceKind: "WORKTREE", resourceId: "worktree-1", activeRuns: [] },
      ],
    };
  });
  const worktree: Worktree = {
    ...gitlabWorktree([]),
    sourceControlRequest: null,
    pullRequest: {
      id: "pr-5",
      number: 5,
      title: "CI changes",
      url: "https://github.com/acme/app/pull/5",
      state: "OPEN",
      repositoryGithubId: key.repositoryGithubId,
      repositoryNameWithOwner: "acme/app",
      repositoryUrl: "https://github.com/acme/app",
      headRefName: "feature/ci",
      headRefOid: key.headSha,
      labels: [],
      jiraKey: null,
      pipelineStatus: "NONE",
      pipelines: [],
      reviewDecision: "APPROVED",
      unresolvedReviewThreadCount: 0,
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      autoMergeEnabled: false,
      viewerCanEnableAutoMerge: false,
      viewerCanDisableAutoMerge: false,
      worktreeId: "worktree-1",
      worktreeHighlightColor: null,
      createdAt: "",
    },
  };
  const { rerender } = render(
    <GitHubPipelineStatusProvider>
      <WorktreeFailingPipelineItem worktree={worktree} workflows={[workflow]} />
    </GitHubPipelineStatusProvider>,
  );

  await screen.findByRole("button", { name: workflow.name });
  expect(controlPlaneRequest).toHaveBeenCalledWith(
    expect.stringContaining("GitHubPipelineStatuses"),
    { keys: [key] },
  );
  rerender(
    <GitHubPipelineStatusProvider>
      <WorktreeFailingPipelineItem
        worktree={{ ...worktree, pullRequest: null }}
        workflows={[workflow]}
      />
    </GitHubPipelineStatusProvider>,
  );
  expect(screen.queryByText("Pipeline failing")).toBeNull();
  expect(screen.queryByRole("button", { name: workflow.name })).toBeNull();
});

test.each([null, "CLOSED", "MERGED"] as const)(
  "hides failing branch CI when the linked request state is %s",
  (state) => {
    vi.mocked(controlPlaneRequest).mockResolvedValue({
      workflowTargetSummaries: [],
    });
    const gitlab = gitlabWorktree([pipeline("11", "push", "FAILED")]);
    const githubHeadStatus = {
      repositoryGithubId: "44",
      headSha: "current-head",
      pipelineStatus: "FAILURE",
      pipelines: [{ id: "failed-check", status: "FAILURE" }],
    };
    const github = {
      ...gitlabWorktree([]),
      sourceControlRequest: null,
      gitHubHeadPipelineStatus: githubHeadStatus,
      gitHubPipelineRepositoryId: githubHeadStatus.repositoryGithubId,
      pullRequest: state
        ? {
            ...githubHeadStatus,
            state,
            headRefName: "feature/ci",
            headRefOid: githubHeadStatus.headSha,
          }
        : null,
    } as Worktree;
    render(
      <>
        <WorktreeFailingPipelineItem
          worktree={{
            ...gitlab,
            sourceControlRequest:
              gitlab.sourceControlRequest && state
                ? { ...gitlab.sourceControlRequest, state }
                : null,
          }}
          workflows={[workflow]}
        />
        <WorktreeFailingPipelineItem
          worktree={{ ...github, id: "github-worktree" }}
          workflows={[workflow]}
        />
      </>,
    );
    expect(screen.queryByText("Pipeline failing")).toBeNull();
    expect(screen.queryByRole("button", { name: workflow.name })).toBeNull();
  },
);

test("includes failing check details for the current commit of an open GitHub pull request", async () => {
  vi.mocked(controlPlaneRequest).mockResolvedValue({
    workflowTargetSummaries: [],
    triggerWorkflow: { id: "run-1" },
  });
  const currentHeadStatus = {
    repositoryGithubId: "44",
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
  };
  const worktree = {
    ...gitlabWorktree([]),
    sourceControlRequest: null,
    pullRequest: {
      ...currentHeadStatus,
      headRefName: "feature/ci",
      headRefOid: "current-head",
      state: "OPEN",
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
                  headSha: "current-head",
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
