import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import {
  clearMergeOperation,
  githubMergeOperationKey,
  gitlabMergeOperationKey,
  recordMergeOperationProgress,
  recordPostMergeSwitch,
} from "@/components/github/merge-operation-state";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { WorktreeCodebaseGroup } from "./types";
import { WorktreeMergeFollowUps } from "./worktree-merge-follow-ups";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));
vi.mock("@/components/github/merge-pull-request-button", () => ({
  MergePullRequestButton: ({
    pullRequest,
    open,
  }: {
    pullRequest: { repositoryNameWithOwner: string; number: number };
    open?: boolean;
  }) =>
    open ? (
      <div aria-label="GitHub follow-up recovery" role="dialog">
        {pullRequest.repositoryNameWithOwner} #{pullRequest.number}
      </div>
    ) : null,
}));
vi.mock("@/components/gitlab/merge-request-dialog", () => ({
  MergeRequestDialog: ({
    mergeRequest,
    open,
  }: {
    mergeRequest: { projectId: string; iid: number };
    open: boolean;
  }) =>
    open ? (
      <div aria-label="GitLab follow-up recovery" role="dialog">
        {mergeRequest.projectId} !{mergeRequest.iid}
      </div>
    ) : null,
}));

const request = vi.mocked(controlPlaneRequest);
const githubRequest = {
  repositoryNameWithOwner: "acme/widgets",
  number: 19,
};
const githubKey = githubMergeOperationKey(githubRequest);
const gitlabRequest = { projectId: "project-7", iid: 23 };
const gitlabKey = gitlabMergeOperationKey(gitlabRequest);
const unrelatedKey = githubMergeOperationKey({
  repositoryNameWithOwner: "another/repository",
  number: 99,
});
const completedSwitch = {
  branch: "main",
  state: "COMPLETED",
  lastError: null,
};
const failedFollowUp = {
  state: "ACTION_REQUIRED",
  lastError: "Jira unavailable after merging",
  postMergeSwitch: completedSwitch,
};

function githubGroup(branch = "main"): WorktreeCodebaseGroup {
  return {
    repository: {
      id: "github-repository",
      canonicalOrigin: "github.com/acme/widgets",
    },
    codebase: {
      id: "github-codebase",
      defaultBranch: "main",
    },
    worktrees: [
      {
        id: "github-primary",
        branch,
        primary: true,
        isDefaultBranch: branch === "main",
        pullRequest: null,
        sourceControlRequest: null,
        autoMerge: {
          worktreeId: "github-primary",
          repositoryNameWithOwner: githubRequest.repositoryNameWithOwner,
          pullRequestNumber: githubRequest.number,
          branch: "feature/reviewed",
          ...failedFollowUp,
        },
      },
    ],
  } as WorktreeCodebaseGroup;
}

function gitlabGroup(): WorktreeCodebaseGroup {
  return {
    repository: {
      id: "gitlab-repository",
      canonicalOrigin: "gitlab.example/team/widgets",
    },
    codebase: { id: "gitlab-codebase", defaultBranch: "main" },
    worktrees: [
      {
        id: "gitlab-primary",
        branch: "main",
        primary: true,
        isDefaultBranch: true,
        pullRequest: null,
        sourceControlRequest: null,
        autoMerge: null,
      },
    ],
  } as WorktreeCodebaseGroup;
}

function resetOperation(key: string) {
  recordMergeOperationProgress(key, false, null, undefined, "COMPLETED");
  recordPostMergeSwitch(key, completedSwitch);
  clearMergeOperation(key);
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async (query) => {
    if (query.includes("githubPullRequestMergeOperation("))
      return { githubPullRequestMergeOperation: failedFollowUp } as never;
    if (query.includes("gitlabWorktreeMergeOperations("))
      return {
        gitlabWorktreeMergeOperations: [
          {
            ...gitlabRequest,
            worktreeId: "gitlab-primary",
            ...failedFollowUp,
          },
        ],
      } as never;
    if (query.includes("gitlabMergeOperation("))
      return { gitlabMergeOperation: failedFollowUp } as never;
    throw new Error(`Unexpected control-plane query: ${query}`);
  });
});

afterEach(() => {
  cleanup();
  [githubKey, gitlabKey, unrelatedKey].forEach(resetOperation);
});

test("recovers a saved GitHub follow-up after the primary checkout loses its source association", async () => {
  act(() => {
    recordMergeOperationProgress(
      unrelatedKey,
      false,
      "An unrelated merge failed",
      "another/repository #99",
      "ACTION_REQUIRED",
    );
  });
  render(<WorktreeMergeFollowUps groups={[githubGroup()]} />);

  const review = await screen.findByRole("button", {
    name: "Review merge error",
  });
  expect(screen.getByText(failedFollowUp.lastError)).toBeDefined();
  expect(screen.queryByText("An unrelated merge failed")).toBeNull();
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("githubPullRequestMergeOperation("),
      { owner: "acme", name: "widgets", number: 19 },
    ),
  );
  expect(
    request.mock.calls.some(([query]) =>
      query.includes("gitlabWorktreeMergeOperations("),
    ),
  ).toBe(false);

  fireEvent.click(review);
  const dialog = screen.getByRole("dialog", {
    name: "GitHub follow-up recovery",
  });
  expect(within(dialog).getByText("acme/widgets #19")).toBeDefined();
});

test("keeps the recovery entrypoint through a branch refresh and restores it on a fresh mount", async () => {
  const view = render(
    <WorktreeMergeFollowUps groups={[githubGroup("feature/reviewed")]} />,
  );
  await screen.findByRole("button", { name: "Review merge error" });

  view.rerender(<WorktreeMergeFollowUps groups={[githubGroup()]} />);
  expect(screen.getByText(failedFollowUp.lastError)).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Review merge error" }),
  ).toBeDefined();

  view.unmount();
  act(() => resetOperation(githubKey));
  request.mockClear();
  render(<WorktreeMergeFollowUps groups={[githubGroup()]} />);
  const review = await screen.findByRole("button", {
    name: "Review merge error",
  });
  await waitFor(() => expect(request).toHaveBeenCalled());
  fireEvent.click(review);
  expect(
    within(
      screen.getByRole("dialog", { name: "GitHub follow-up recovery" }),
    ).getByText("acme/widgets #19"),
  ).toBeDefined();
});

test("discovers GitLab follow-ups by worktree after its merge-request association disappears", async () => {
  render(<WorktreeMergeFollowUps groups={[githubGroup(), gitlabGroup()]} />);

  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("gitlabWorktreeMergeOperations("),
      { worktreeIds: ["gitlab-primary"] },
    ),
  );
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: "Review merge error" }),
    ).toHaveLength(2),
  );
  const gitlabWarning = screen
    .getAllByRole("alert")
    .find(
      (alert) =>
        alert.textContent?.includes("!23") &&
        within(alert).queryByRole("button", { name: "Review merge error" }),
    );
  expect(gitlabWarning).toBeDefined();
  fireEvent.click(
    within(gitlabWarning!).getByRole("button", { name: "Review merge error" }),
  );
  expect(
    within(
      screen.getByRole("dialog", { name: "GitLab follow-up recovery" }),
    ).getByText("project-7 !23"),
  ).toBeDefined();
});

test("keeps a discovered GitLab recovery visible while its branch refresh fails, until the worktree leaves the scope", async () => {
  let rejectRefresh!: (error: Error) => void;
  const refresh = new Promise<never>((_resolve, reject) => {
    rejectRefresh = reject;
  });
  let discoveries = 0;
  request.mockImplementation(async (query) => {
    if (query.includes("gitlabWorktreeMergeOperations(")) {
      discoveries += 1;
      if (discoveries > 1) return refresh;
      return {
        gitlabWorktreeMergeOperations: [
          { ...gitlabRequest, worktreeId: "gitlab-primary" },
        ],
      } as never;
    }
    if (query.includes("gitlabMergeOperation("))
      return { gitlabMergeOperation: failedFollowUp } as never;
    throw new Error(`Unexpected control-plane query: ${query}`);
  });
  const beforeSwitch = gitlabGroup();
  beforeSwitch.worktrees[0]!.branch = "feature/reviewed";
  beforeSwitch.worktrees[0]!.isDefaultBranch = false;
  const view = render(<WorktreeMergeFollowUps groups={[beforeSwitch]} />);
  await screen.findByRole("button", { name: "Review merge error" });

  view.rerender(<WorktreeMergeFollowUps groups={[gitlabGroup()]} />);
  await waitFor(() => expect(discoveries).toBe(2));
  expect(screen.getByText(failedFollowUp.lastError)).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Review merge error" }),
  ).toBeDefined();

  await act(async () => rejectRefresh(new Error("Discovery unavailable")));
  await screen.findByText("Discovery unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Review merge error" }));
  expect(
    within(
      screen.getByRole("dialog", { name: "GitLab follow-up recovery" }),
    ).getByText("project-7 !23"),
  ).toBeDefined();

  view.rerender(<WorktreeMergeFollowUps groups={[]} />);
  expect(screen.queryByText(failedFollowUp.lastError)).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Review merge error" }),
  ).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
