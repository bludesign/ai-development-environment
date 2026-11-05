import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { Worktree } from "./types";
import { AutoMergeButton, AutoSyncButton } from "./worktree-automation-buttons";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("./worktree-jobs", () => ({
  waitForWorktreeJob: vi.fn(async () => undefined),
}));

vi.mock("@/components/github/merge-pull-request-button", () => ({
  MergePullRequestButton: () => <button type="button">Manual merge</button>,
}));

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  request.mockReset();
});

function worktreeForLaterPullRequest(
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN",
): Worktree {
  return {
    id: "worktree-1",
    primary: true,
    branch: "feature/widgets",
    pullRequest: {
      number: 18,
      repositoryNameWithOwner: "acme/widgets",
      state: "OPEN",
      headRefName: "feature/widgets",
      isDraft: false,
      mergeable,
      mergeStateStatus: mergeable === "MERGEABLE" ? "CLEAN" : "BLOCKED",
    },
    autoMerge: {
      worktreeId: "worktree-1",
      state: "COMPLETED",
      repositoryNameWithOwner: "acme/widgets",
      pullRequestNumber: 17,
      branch: "feature/widgets",
      mergeMethod: "SQUASH",
      commitHeadline: "Previous pull request",
      commitBody: "",
      authorEmail: null,
      deleteWorktree: false,
      moveTicketToDone: false,
      ticketKey: null,
      lastError: null,
      updatedAt: new Date(0).toISOString(),
    },
  } as Worktree;
}

function gitLabWorktree(
  detailedMergeStatus: string,
  pipelineStatus: "RUNNING" | "SUCCESS",
): Worktree {
  return {
    ...worktreeForLaterPullRequest("UNKNOWN"),
    pullRequest: null,
    sourceControlRequest: {
      provider: "GITLAB",
      projectId: "42",
      number: 17,
      title: "Improve API",
      state: "OPENED",
      headRefName: "feature/widgets",
      isDraft: false,
      detailedMergeStatus,
    },
    gitLabPipelines: [{ status: pipelineStatus }],
  } as Worktree;
}

describe("AutoMergeButton", () => {
  test.each(["native", "managed"])(
    "keeps %s GitHub Auto Merge green when the PR is directly mergeable",
    (kind) => {
      const worktree = worktreeForLaterPullRequest("MERGEABLE");
      if (kind === "native") {
        worktree.autoMerge = null;
        worktree.pullRequest!.autoMergeEnabled = true;
      } else {
        worktree.autoMerge = {
          ...worktree.autoMerge!,
          pullRequestNumber: 18,
          state: "ACTIVE",
          autoSync: false,
        };
      }
      render(
        <AutoMergeButton
          conflictWorkflows={[]}
          disabled={true}
          onCompleted={vi.fn()}
          onError={vi.fn()}
          worktree={worktree}
        />,
      );
      const button = screen.getByRole("button", { name: "Auto Merging" });
      expect(button.className).toContain("bg-emerald-600");
      expect(button.hasAttribute("disabled")).toBe(false);
      expect(screen.queryByRole("button", { name: "Manual merge" })).toBeNull();
    },
  );

  test("can cancel native GitHub Auto Merge without a persisted rule", async () => {
    const worktree = worktreeForLaterPullRequest("MERGEABLE");
    worktree.autoMerge = null;
    worktree.pullRequest!.autoMergeEnabled = true;
    request.mockResolvedValue({
      githubPullRequestMergeOptions: {
        availableMethods: ["SQUASH"],
        defaultCommitHeadline: "Improve widgets",
        defaultCommitBody: "",
        commitEmails: [],
        viewerCanDisableAutoMerge: true,
      },
    } as never);
    const onCompleted = vi.fn(async () => undefined);
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={onCompleted}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Auto Merging" }));
    await screen.findByDisplayValue("Improve widgets");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Auto Merge" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation CancelWorktreeAutoMerge"),
        { worktreeId: worktree.id },
      ),
    );
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  test.each(["native", "managed"])(
    "shows green %s GitLab Auto Merge before the mergeable action",
    (kind) => {
      const worktree = gitLabWorktree("mergeable", "SUCCESS");
      if (kind === "native") {
        worktree.sourceControlRequest!.mergeWhenPipelineSucceeds = true;
      } else {
        worktree.sourceControlRequest!.mergeOperation = {
          state: "WAITING_CI",
          autoMerge: true,
          autoSync: true,
          worktreeId: worktree.id,
        };
      }
      render(
        <AutoMergeButton
          conflictWorkflows={[]}
          disabled={false}
          onCompleted={vi.fn()}
          onError={vi.fn()}
          worktree={worktree}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Auto Merging" }).className,
      ).toContain("bg-emerald-600");
      expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
    },
  );

  test.each([
    ["ACTION_REQUIRED", "OPENED", "Auto Merge paused", "destructive", false],
    ["COMPLETED", "MERGED", "Auto Merge Complete", "default", true],
    ["CANCELED", "OPENED", "Merge", "default", false],
  ] as const)(
    "reflects GitLab %s without implying enabled automation",
    (state, requestState, label, variant, disabled) => {
      const worktree = gitLabWorktree("mergeable", "SUCCESS");
      worktree.sourceControlRequest!.state = requestState;
      worktree.sourceControlRequest!.mergeOperation = {
        state,
        autoMerge: true,
        worktreeId: worktree.id,
      };
      render(
        <AutoMergeButton
          conflictWorkflows={[]}
          disabled={false}
          onCompleted={vi.fn()}
          onError={vi.fn()}
          worktree={worktree}
        />,
      );
      const button = screen.getByRole("button", { name: label });
      expect(button.getAttribute("data-variant")).toBe(variant);
      expect(button.hasAttribute("disabled")).toBe(disabled);
    },
  );

  test.each(["GITHUB", "GITLAB"])(
    "does not show enabled %s automation for a previous branch",
    (provider) => {
      const worktree =
        provider === "GITLAB"
          ? gitLabWorktree("mergeable", "SUCCESS")
          : worktreeForLaterPullRequest("MERGEABLE");
      worktree.branch = "feature/different-branch";
      if (provider === "GITLAB") {
        worktree.sourceControlRequest!.mergeWhenPipelineSucceeds = true;
        worktree.sourceControlRequest!.mergeOperation = {
          state: "WAITING_CI",
          autoMerge: true,
          autoSync: true,
          worktreeId: worktree.id,
        };
      } else {
        worktree.pullRequest!.autoMergeEnabled = true;
      }
      render(
        <AutoMergeButton
          conflictWorkflows={[]}
          disabled={false}
          onCompleted={vi.fn()}
          onError={vi.fn()}
          worktree={worktree}
        />,
      );
      expect(screen.queryByRole("button", { name: "Auto Merging" })).toBeNull();
    },
  );

  test("ignores a GitLab automation linked to a different worktree", () => {
    const worktree = gitLabWorktree("mergeable", "SUCCESS");
    worktree.sourceControlRequest!.mergeOperation = {
      state: "WAITING_CI",
      autoMerge: true,
      autoSync: true,
      worktreeId: "other-worktree",
    };
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );
    expect(screen.getByRole("button", { name: "Merge" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Auto Merging" })).toBeNull();
  });

  test("ignores a GitHub rule when the linked PR source branch changes", () => {
    const worktree = worktreeForLaterPullRequest("MERGEABLE");
    worktree.autoMerge = {
      ...worktree.autoMerge!,
      state: "ACTIVE",
      pullRequestNumber: 18,
    };
    worktree.pullRequest!.headRefName = "feature/renamed-source";
    worktree.pullRequest!.autoMergeEnabled = true;
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );
    expect(screen.getByRole("button", { name: "Manual merge" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Auto Merging" })).toBeNull();
  });

  test("opens the GitLab merge sheet with the linked checkout and never loads GitHub options", async () => {
    const worktree = gitLabWorktree("ci_still_running", "RUNNING");
    request.mockRejectedValue(new Error("GitLab options unavailable"));
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Auto-merge" }));
    await screen.findByText("GitLab options unavailable");
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("query GitLabMergeRequestMergeOptions"),
      { projectId: "42", iid: 17, worktreeId: "worktree-1" },
    );
    expect(request.mock.calls.some(([query]) => query.includes("GitHub"))).toBe(
      false,
    );
  });

  test("replaces GitLab Auto-merge with Merge once the pipeline finishes and the MR is mergeable", () => {
    const props = {
      conflictWorkflows: [],
      disabled: false,
      onCompleted: vi.fn(async () => undefined),
      onError: vi.fn(),
    };
    const { rerender } = render(
      <AutoMergeButton
        {...props}
        worktree={gitLabWorktree("mergeable", "RUNNING")}
      />,
    );

    expect(screen.getByRole("button", { name: "Auto-merge" })).toBeDefined();

    rerender(
      <AutoMergeButton
        {...props}
        worktree={gitLabWorktree("mergeable", "SUCCESS")}
      />,
    );

    expect(screen.getByRole("button", { name: "Merge" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Auto-merge" })).toBeNull();
  });

  test("allows a later directly mergeable pull request to be merged manually", () => {
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktreeForLaterPullRequest("MERGEABLE")}
      />,
    );

    expect(screen.getByRole("button", { name: "Manual merge" })).toBeDefined();
  });

  test("allows Auto Merge to be configured for a later blocked pull request", () => {
    render(
      <AutoMergeButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn()}
        onError={vi.fn()}
        worktree={worktreeForLaterPullRequest("UNKNOWN")}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Auto Merge" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("shows completed casing and resets the button when the branch changes", () => {
    const worktree = worktreeForLaterPullRequest("UNKNOWN");
    worktree.pullRequest = {
      ...worktree.pullRequest!,
      number: 17,
      state: "MERGED",
    };
    const props = {
      conflictWorkflows: [],
      disabled: false,
      onCompleted: vi.fn(async () => undefined),
      onError: vi.fn(),
    };
    const { rerender } = render(
      <AutoMergeButton {...props} worktree={worktree} />,
    );

    expect(
      screen.getByRole("button", { name: "Auto Merge Complete" }),
    ).toBeDefined();

    rerender(
      <AutoMergeButton
        {...props}
        worktree={{
          ...worktree,
          branch: "feature/new-widgets",
          pullRequest: null,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Auto Merge" })).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Auto Merge Complete" }),
    ).toBeNull();
  });
});

describe("Auto Merge form state", () => {
  function fixture() {
    const worktree = worktreeForLaterPullRequest("UNKNOWN");
    worktree.primary = false;
    worktree.ticketKey = "APP-42";
    const options = {
      availableMethods: ["SQUASH", "MERGE"],
      defaultMethod: "MERGE",
      defaultCommitHeadline: "Saved headline",
      defaultCommitBody: "",
      defaultCommitEmail: null,
      commitEmails: [],
      canEnableAutoMerge: true,
      defaultDeleteWorktree: false,
      defaultMoveTicketToDone: false,
      worktreeId: worktree.id,
      worktreeFolder: "/dashboard/worktrees/api",
      canDeleteWorktree: true,
      ticketKey: "APP-42",
      ticketDoneStatusConfigured: true,
    };
    request.mockResolvedValue({
      githubPullRequestMergeOptions: options,
    } as never);
    const props = {
      conflictWorkflows: [],
      disabled: false,
      onCompleted: vi.fn(async () => undefined),
      onError: vi.fn(),
      worktree,
    };
    return { worktree, props, options };
  }

  test("shows an activation status warning while preserving successful auto merge configuration", async () => {
    const { props, options } = fixture();
    const warning = "Auto merge is enabled, but Jira requires a Comment";
    request.mockImplementation(async (query) =>
      query.includes("mutation ConfigureWorktreeAutoMerge")
        ? ({
            configureWorktreeAutoMerge: {
              state: "WAITING_REQUIREMENTS",
              ticketTransitionError: warning,
            },
          } as never)
        : ({ githubPullRequestMergeOptions: options } as never),
    );
    render(<AutoMergeButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto Merge" }));
    await screen.findByDisplayValue("Saved headline");
    fireEvent.click(screen.getByRole("button", { name: "Enable Auto Merge" }));
    expect(await screen.findByText(warning)).toBeDefined();
    expect(props.onCompleted).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  test("keeps checkbox and text edits across refreshes and mergeability changes", async () => {
    const { worktree, props } = fixture();
    const { rerender } = render(<AutoMergeButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto Merge" }));
    const headline = await screen.findByDisplayValue("Saved headline");
    fireEvent.change(headline, { target: { value: "My headline" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Move APP-42/ }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Delete worktree after merge" }),
    );
    rerender(
      <AutoMergeButton
        {...props}
        worktree={{
          ...worktree,
          autoMerge: { ...worktree.autoMerge! },
          pullRequest: {
            ...worktree.pullRequest!,
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
          },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("My headline")).toBeDefined(),
    );
    expect(
      screen
        .getByRole("checkbox", { name: /Move APP-42/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen
        .getByRole("checkbox", { name: "Delete worktree after merge" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "Manual merge" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("reopens with defaults and reinitializes when the PR identity changes", async () => {
    const { props, worktree } = fixture();
    const { rerender } = render(<AutoMergeButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto Merge" }));
    await screen.findByDisplayValue("Saved headline");
    fireEvent.click(screen.getByRole("checkbox", { name: /Move APP-42/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto Merge" }));
    await screen.findByDisplayValue("Saved headline");
    expect(
      screen
        .getByRole("checkbox", { name: /Move APP-42/ })
        .getAttribute("aria-checked"),
    ).toBe("false");
    rerender(
      <AutoMergeButton
        {...props}
        worktree={{
          ...worktree,
          pullRequest: { ...worktree.pullRequest!, number: 19 },
        }}
      />,
    );
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await screen.findByDisplayValue("Saved headline");
  });

  test("ignores a late response for the previous PR", async () => {
    const { props, worktree, options } = fixture();
    let resolveOld!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { rerender } = render(<AutoMergeButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto Merge" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender(
      <AutoMergeButton
        {...props}
        worktree={{
          ...worktree,
          pullRequest: { ...worktree.pullRequest!, number: 19 },
        }}
      />,
    );
    await screen.findByDisplayValue("Saved headline");
    resolveOld({
      githubPullRequestMergeOptions: {
        ...options,
        defaultCommitHeadline: "Stale headline",
      },
    });
    await waitFor(() =>
      expect(screen.getByDisplayValue("Saved headline")).toBeDefined(),
    );
    expect(screen.queryByDisplayValue("Stale headline")).toBeNull();
  });

  test("retries post-merge actions without re-enabling auto merge", async () => {
    const { props, worktree } = fixture();
    worktree.pullRequest!.state = "MERGED";
    worktree.autoMerge = {
      ...worktree.autoMerge!,
      pullRequestNumber: 18,
      state: "ACTION_REQUIRED",
    };
    render(<AutoMergeButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto Merge paused" }));
    await screen.findByDisplayValue("Saved headline");
    fireEvent.click(screen.getByRole("button", { name: "Resume Auto Merge" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RetryWorktreeAutoMerge"),
        { worktreeId: worktree.id },
      ),
    );
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("mutation ConfigureWorktreeAutoMerge"),
      ),
    ).toBe(false);
  });
});

describe("AutoSyncButton", () => {
  test("offers a confirmed force retry only for preparation conflicts", async () => {
    const worktree = {
      id: "worktree-1",
      autoSync: {
        worktreeId: "worktree-1",
        state: "PAUSED",
        conflictWorkflowId: null,
        conflictWorkflowChoice: null,
        lastError: "Repository preparations block the rebase: .env.local",
        pauseReason: "PREPARATION_CONFLICT",
        lastSyncedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    } as Worktree;
    request.mockResolvedValue({
      forceWorktreeAutoSync: { id: "job-1" },
    } as never);

    render(
      <AutoSyncButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn(async () => undefined)}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Auto Sync paused" }));
    expect(await screen.findByText(/\.env\.local/)).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Force Sync and reapply" }),
    );
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Force Sync" }));

    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          String(query).includes("mutation ForceWorktreeAutoSync"),
        ),
      ).toBe(true),
    );
  });

  test("does not expose force sync for other pause reasons", async () => {
    const worktree = {
      id: "worktree-1",
      autoSync: {
        worktreeId: "worktree-1",
        state: "PAUSED",
        conflictWorkflowId: null,
        conflictWorkflowChoice: null,
        lastError: "The worktree branch changed",
        pauseReason: "BRANCH_CHANGED",
        lastSyncedAt: null,
        updatedAt: new Date(0).toISOString(),
      },
    } as Worktree;

    render(
      <AutoSyncButton
        conflictWorkflows={[]}
        disabled={false}
        onCompleted={vi.fn(async () => undefined)}
        onError={vi.fn()}
        worktree={worktree}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Auto Sync paused" }));
    expect(
      screen.queryByRole("button", { name: "Force Sync and reapply" }),
    ).toBeNull();
  });
});
