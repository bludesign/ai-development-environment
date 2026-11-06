import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  clearMergeOperation,
  githubMergeOperationKey,
} from "./merge-operation-state";

import { MergePullRequestButton } from "./merge-pull-request-button";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const pullRequest = {
  number: 17,
  repositoryNameWithOwner: "acme/widgets",
  title: "APP-42 Add the API",
};

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  request.mockReset();
  clearMergeOperation(githubMergeOperationKey(pullRequest));
});

describe("MergePullRequestButton", () => {
  test("defaults to switching the primary checkout and keeps progress after dismissal and navigation", async () => {
    let finish!: (value: unknown) => void;
    const observation = new Promise((resolve) => {
      finish = resolve;
    });
    request.mockImplementation(async (query) => {
      if (query.includes("query GitHubPullRequestMergeOptions"))
        return {
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH"],
            commitEmails: [],
            defaultCommitHeadline: "Switch checkout",
            defaultCommitBody: "",
            canMerge: true,
            worktreeId: "primary",
            canSwitchToDefaultBranch: true,
            defaultSwitchToDefaultBranch: true,
            switchToDefaultBranchName: "main",
          },
        } as never;
      if (query.includes("query GitHubPullRequestMergeOperation"))
        return (await observation) as never;
      return {
        mergeGitHubPullRequest: {
          state: "MERGED",
          worktreeId: "primary",
          postMergeSwitch: {
            branch: "main",
            state: "PENDING",
            lastError: null,
          },
        },
      } as never;
    });
    const original = render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    const checkbox = await screen.findByRole("checkbox", {
      name: "Switch to main after merge",
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in background" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Updating main…" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    original.unmount();
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Updating main…" }),
    ).toBeDefined();
    await act(async () => {
      finish({
        githubPullRequestMergeOperation: {
          state: "COMPLETED",
          postMergeSwitch: {
            branch: "main",
            state: "COMPLETED",
            lastError: null,
          },
        },
      });
    });
    expect(
      await screen.findByRole("button", { name: "Switched to main." }),
    ).toBeDefined();
    const mutations = request.mock.calls.filter(([query]) =>
      query.includes("mutation MergeGitHubPullRequest"),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.[1]).toMatchObject({
      input: { switchToDefaultBranch: true },
    });
  });

  test("restores a completed switch for a merged pull request even when its merge trigger is hidden", async () => {
    request.mockResolvedValue({
      githubPullRequestMergeOperation: {
        state: "COMPLETED",
        postMergeSwitch: {
          branch: "main",
          state: "COMPLETED",
          lastError: null,
        },
      },
    } as never);
    render(
      <MergePullRequestButton
        pullRequest={{ ...pullRequest, state: "MERGED" }}
        requestSource="PULL_REQUEST_DETAILS"
        showTrigger={false}
        showProgressTrigger
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Switched to main." }),
    ).toBeDefined();
    expect(
      request.mock.calls.every(([query]) => !query.includes("mutation")),
    ).toBe(true);
  });

  test.each(["ACTION_REQUIRED", "COMPLETED"])(
    "retries failed follow-ups without another merge when checkout is %s",
    async (checkoutState) => {
      let retried = false;
      const warning =
        checkoutState === "COMPLETED"
          ? "Jira unavailable"
          : "Local changes need attention";
      const failed = {
        branch: "main",
        state: checkoutState,
        lastError: checkoutState === "COMPLETED" ? null : warning,
      };
      request.mockImplementation(async (query) => {
        if (query.includes("query GitHubPullRequestMergeOptions"))
          return {
            githubPullRequestMergeOptions: {
              availableMethods: ["SQUASH"],
              commitEmails: [],
              defaultCommitHeadline: "Already merged",
              defaultCommitBody: "",
              canMerge: false,
              worktreeId: "primary",
              autoMergeOperation: {
                state: "ACTION_REQUIRED",
                autoSync: false,
                lastError: warning,
                postMergeSwitch: failed,
              },
            },
          } as never;
        if (query.includes("mutation RetryWorktreeAutoMerge")) {
          retried = true;
          return {
            retryWorktreeAutoMerge: {
              state: "POST_MERGE",
              postMergeSwitch: {
                ...failed,
                state: checkoutState === "COMPLETED" ? "COMPLETED" : "PENDING",
                lastError: null,
              },
            },
          } as never;
        }
        return {
          githubPullRequestMergeOperation: {
            state: retried ? "COMPLETED" : "ACTION_REQUIRED",
            lastError: retried ? null : warning,
            postMergeSwitch: retried
              ? { ...failed, state: "COMPLETED", lastError: null }
              : failed,
          },
        } as never;
      });
      render(
        <MergePullRequestButton
          pullRequest={pullRequest}
          requestSource="PULL_REQUEST_DETAILS"
          open
        />,
      );
      await screen.findAllByText(warning);
      fireEvent.click(
        await screen.findByRole("button", { name: "Retry follow-ups" }),
      );
      await screen.findAllByText("Switched to main.");
      await waitFor(() => expect(screen.queryByText(warning)).toBeNull());
      expect(
        request.mock.calls.filter(([query]) =>
          query.includes("mutation RetryWorktreeAutoMerge"),
        ),
      ).toHaveLength(1);
      expect(
        request.mock.calls.some(([query]) =>
          query.includes("mutation MergeGitHubPullRequest"),
        ),
      ).toBe(false);
    },
  );

  test("retains a confirmed merge when refreshing its originating view fails", async () => {
    request.mockImplementation(async (query) =>
      query.includes("query GitHubPullRequestMergeOptions")
        ? ({
            githubPullRequestMergeOptions: {
              availableMethods: ["SQUASH"],
              commitEmails: [],
              defaultCommitHeadline: "Refresh failure",
              defaultCommitBody: "",
              canMerge: true,
            },
          } as never)
        : ({
            mergeGitHubPullRequest: { state: "MERGED", postMergeError: null },
          } as never),
    );
    const onMerged = vi.fn().mockRejectedValue(new Error("View unavailable"));
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
        onMerged={onMerged}
        open
      />,
    );
    await screen.findByDisplayValue("Refresh failure");
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    expect(
      await screen.findByText(/refreshing this view failed: View unavailable/),
    ).toBeDefined();
    const submit = screen.getByRole("button", { name: "Merge pull request" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation MergeGitHubPullRequest"),
      ),
    ).toHaveLength(1);
  });

  test("disables submission immediately when switching to a request whose options have not loaded", async () => {
    request.mockResolvedValue({
      githubPullRequestMergeOptions: {
        availableMethods: ["SQUASH"],
        commitEmails: [],
        defaultCommitHeadline: "Old request",
        defaultCommitBody: "",
        canMerge: true,
      },
    } as never);
    const view = render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
        open
      />,
    );
    await screen.findByDisplayValue("Old request");
    request.mockClear();
    view.rerender(
      <MergePullRequestButton
        pullRequest={{ ...pullRequest, number: 18 }}
        requestSource="PULL_REQUEST_DETAILS"
        open
      />,
    );
    const submit = screen.getByRole("button", { name: "Merge pull request" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(
      request.mock.calls.some(([query]) => query.includes("mutation")),
    ).toBe(false);
    expect(screen.queryByDisplayValue("Old request")).toBeNull();
  });

  test("dismisses a pending merge and restores its error after navigating back", async () => {
    let rejectMerge!: (reason: Error) => void;
    const pendingMerge = new Promise<never>((_resolve, reject) => {
      rejectMerge = reject;
    });
    request.mockImplementation(async (query) => {
      if (query.includes("query GitHubPullRequestMergeOptions"))
        return {
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH"],
            commitEmails: [],
            defaultCommitHeadline: "APP-42 Title",
            defaultCommitBody: "",
            canMerge: true,
          },
        } as never;
      return pendingMerge;
    });
    const original = render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await screen.findByDisplayValue("APP-42 Title");
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    const background = await screen.findByRole("button", {
      name: "Continue in background",
    });
    expect(background.hasAttribute("disabled")).toBe(false);
    fireEvent.click(background);
    expect(screen.queryByRole("dialog")).toBeNull();
    const merging = screen.getByRole("button", { name: "Merging…" });
    expect(merging.getAttribute("aria-busy")).toBe("true");
    expect(merging.querySelector('[data-slot="spinner"]')).not.toBeNull();
    original.unmount();
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merging…" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in background" }),
    );
    await act(async () =>
      rejectMerge(new Error("The reviewed commit changed")),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const idle = screen.getByRole("button", { name: "Merge" });
    expect(idle.getAttribute("aria-busy")).toBe("false");
    expect(idle.querySelector('[data-slot="spinner"]')).toBeNull();
    const attention = await screen.findByRole("button", {
      name: "Merge needs attention",
    });
    expect(attention.getAttribute("title")).toBe("The reviewed commit changed");
    fireEvent.click(attention);
    expect(
      await screen.findByText("The reviewed commit changed"),
    ).toBeDefined();
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation MergeGitHubPullRequest"),
      ),
    ).toHaveLength(1);
  });

  test("completes a dismissed merge once without reopening its sheet", async () => {
    let finishMerge!: (value: unknown) => void;
    const pendingMerge = new Promise((resolve) => {
      finishMerge = resolve;
    });
    const onMerged = vi.fn();
    request.mockImplementation(async (query) =>
      query.includes("query GitHubPullRequestMergeOptions")
        ? ({
            githubPullRequestMergeOptions: {
              availableMethods: ["SQUASH"],
              commitEmails: [],
              defaultCommitHeadline: "APP-42 Title",
              defaultCommitBody: "",
              canMerge: true,
            },
          } as never)
        : ((await pendingMerge) as never),
    );
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
        onMerged={onMerged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await screen.findByDisplayValue("APP-42 Title");
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in background" }),
    );
    expect(
      screen
        .getByRole("button", { name: "Merging…" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    await act(async () =>
      finishMerge({
        mergeGitHubPullRequest: { state: "MERGED", postMergeError: null },
      }),
    );
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merging…" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Merge" }).getAttribute("aria-busy"),
    ).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Merge needs attention" }),
    ).toBeNull();
  });

  test("configures managed Auto Merge from a linked merge sheet", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query GitHubPullRequestMergeOptions"))
        return {
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH"],
            commitEmails: [],
            defaultCommitEmail: null,
            defaultCommitHeadline: "APP-42 Add API",
            defaultCommitBody: "",
            canMerge: false,
            blockedReason: "The branch is behind.",
            worktreeId: "wt",
            headRefOid: "reviewed",
            canAutoMergeWithSync: true,
            autoSyncBlockedReason: null,
          },
        } as never;
      return {
        configureWorktreeAutoMerge: {
          worktreeId: "wt",
          state: "SYNCING",
          autoSync: true,
        },
      } as never;
    });
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
        open
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Auto sync branch" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable Auto Merge" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation ConfigureWorktreeAutoMerge"),
        expect.objectContaining({
          input: expect.objectContaining({
            worktreeId: "wt",
            autoSync: true,
            expectedHeadSha: "reviewed",
            method: "SQUASH",
          }),
        }),
      ),
    );
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("mutation MergeGitHubPullRequest"),
      ),
    ).toBe(false);
  });

  test.each([true, false])(
    "shows managed progress and offers cancellation (sync=%s)",
    async (autoSync) => {
      request.mockResolvedValue({
        githubPullRequestMergeOptions: {
          availableMethods: ["SQUASH"],
          commitEmails: [],
          defaultCommitEmail: null,
          defaultCommitHeadline: "APP-42 Add API",
          defaultCommitBody: "",
          canMerge: false,
          worktreeId: "wt",
          defaultAutoSync: autoSync,
          autoMergeOperation: {
            autoSync,
            state: "WAITING_REQUIREMENTS",
            lastError: null,
          },
        },
      } as never);
      render(
        <MergePullRequestButton
          pullRequest={pullRequest}
          requestSource="PULL_REQUEST_DETAILS"
          open
        />,
      );
      expect(
        await screen.findByText("Waiting for merge requirements"),
      ).toBeDefined();
      fireEvent.click(
        screen.getByRole("button", { name: "Cancel Auto Merge" }),
      );
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          expect.stringContaining("mutation CancelWorktreeAutoMerge"),
          { worktreeId: "wt" },
        ),
      );
    },
  );

  test("allows merging again after canceling auto-merge with a checkout follow-up", async () => {
    let canceled = false;
    const status = { branch: "main", state: "PENDING", lastError: null };
    const operation = {
      autoSync: true,
      state: "WAITING_CI",
      lastError: null,
      postMergeSwitch: status,
    };
    request.mockImplementation(async (query) => {
      if (query.includes("query GitHubPullRequestMergeOptions"))
        return {
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH"],
            commitEmails: [],
            defaultCommitHeadline: "APP-42 Add API",
            defaultCommitBody: "",
            canMerge: true,
            worktreeId: "wt",
            autoMergeOperation: canceled ? null : operation,
          },
        } as never;
      if (query.includes("query GitHubPullRequestMergeOperation"))
        return {
          githubPullRequestMergeOperation: canceled ? null : operation,
        } as never;
      if (query.includes("mutation CancelWorktreeAutoMerge")) {
        canceled = true;
        return { cancelWorktreeAutoMerge: true } as never;
      }
      return {
        mergeGitHubPullRequest: { state: "MERGED", postMergeError: null },
      } as never;
    });
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
        open
      />,
    );
    await screen.findByText("Waiting for CI");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Auto Merge" }));
    const merge = await screen.findByRole(
      "button",
      { name: "Merge pull request" },
      { timeout: 3500 },
    );
    expect(merge.hasAttribute("disabled")).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Cancel Auto Merge" }),
    ).toBeNull();
    fireEvent.click(merge);
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([query]) =>
          query.includes("mutation MergeGitHubPullRequest"),
        ),
      ).toHaveLength(1),
    );
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation CancelWorktreeAutoMerge"),
      ),
    ).toHaveLength(1);
  });

  test("shows only enabled methods and submits the selected commit details", async () => {
    const onMerged = vi.fn();
    request.mockImplementation(async (query, variables) => {
      if (query.includes("query GitHubPullRequestMergeOptions")) {
        return {
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH", "MERGE"],
            commitEmails: ["octocat@example.com"],
            defaultCommitEmail: "octocat@example.com",
            defaultCommitHeadline: "APP-42 Add the API",
            defaultCommitBody: "Detailed description",
            canMerge: true,
            blockedReason: null,
          },
        } as never;
      }
      if (query.includes("mutation MergeGitHubPullRequest")) {
        expect(variables).toEqual({
          input: {
            owner: "acme",
            name: "widgets",
            number: 17,
            method: "SQUASH",
            commitHeadline: "APP-42 Ship the API",
            commitBody: "Release notes",
            authorEmail: "octocat@example.com",
            worktreeId: undefined,
            deleteWorktree: false,
            moveTicketToDone: false,
            switchToDefaultBranch: false,
          },
          source: "PULL_REQUEST_DETAILS",
        });
        return {
          mergeGitHubPullRequest: {
            id: "pull-request-1",
            state: "MERGED",
            url: "https://github.com/acme/widgets/pull/17",
            mergedAt: "2026-07-17T00:00:00.000Z",
          },
        } as never;
      }
      throw new Error(`Unexpected operation: ${query}`);
    });

    render(
      <MergePullRequestButton
        onMerged={onMerged}
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(await screen.findByDisplayValue("APP-42 Add the API")).toBeDefined();
    expect(screen.getByDisplayValue("Detailed description")).toBeDefined();
    expect(screen.getByText("Squash and merge")).toBeDefined();
    expect(screen.queryByText("Rebase and merge")).toBeNull();
    expect(screen.getByText("octocat@example.com")).toBeDefined();

    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "APP-42 Ship the API" },
    });
    fireEvent.change(screen.getByLabelText("Commit description"), {
      target: { value: "Release notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));

    await waitFor(() => expect(onMerged).toHaveBeenCalledOnce());
  });

  test("shows the unmet merge requirement and disables submission", async () => {
    request.mockResolvedValue({
      githubPullRequestMergeOptions: {
        availableMethods: ["SQUASH"],
        commitEmails: [],
        defaultCommitEmail: null,
        defaultCommitHeadline: "APP-42 Add the API",
        defaultCommitBody: "",
        canMerge: false,
        blockedReason: "Required checks have not passed.",
      },
    } as never);

    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    expect(
      await screen.findByText("Required checks have not passed."),
    ).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Merge pull request" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  test.each([true, false])(
    "applies defaults and only exposes eligible worktree deletion (%s)",
    async (eligible) => {
      request.mockResolvedValue({
        githubPullRequestMergeOptions: {
          availableMethods: ["SQUASH", "MERGE"],
          defaultMethod: "MERGE",
          commitEmails: [],
          defaultCommitHeadline: "APP-42 Title",
          defaultCommitBody: "",
          canMerge: true,
          defaultMoveTicketToDone: true,
          defaultDeleteWorktree: true,
          canDeleteWorktree: eligible,
          worktreeId: eligible ? "wt-1" : null,
          worktreeFolder: "/dashboard/worktrees/api",
          ticketKey: "APP-42",
          ticketDoneStatusConfigured: true,
        },
      } as never);
      const { rerender } = render(
        <MergePullRequestButton
          pullRequest={pullRequest}
          requestSource="PULL_REQUEST_DETAILS"
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Merge" }));
      await screen.findByDisplayValue("APP-42 Title");
      expect(
        screen.getByLabelText("Commit description").getAttribute("value") ??
          (screen.getByLabelText("Commit description") as HTMLTextAreaElement)
            .value,
      ).toBe("");
      expect(
        screen
          .getByRole("checkbox", { name: /Move APP-42/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        Boolean(
          screen.queryByRole("checkbox", {
            name: "Delete worktree after merge",
          }),
        ),
      ).toBe(eligible);
      if (eligible)
        expect(screen.getByText("/dashboard/worktrees/api")).toBeDefined();
      fireEvent.click(screen.getByRole("checkbox", { name: /Move APP-42/ }));
      rerender(
        <MergePullRequestButton
          pullRequest={{ ...pullRequest }}
          requestSource="PULL_REQUEST_DETAILS"
        />,
      );
      expect(
        screen
          .getByRole("checkbox", { name: /Move APP-42/ })
          .getAttribute("aria-checked"),
      ).toBe("false");
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  test("reports a follow-up failure as merged and prevents another merge", async () => {
    const onMerged = vi.fn();
    request.mockImplementation(async (query) =>
      query.includes("query GitHubPullRequestMergeOptions")
        ? ({
            githubPullRequestMergeOptions: {
              availableMethods: ["SQUASH"],
              commitEmails: [],
              defaultCommitHeadline: "APP-42 Title",
              defaultCommitBody: "",
              canMerge: true,
            },
          } as never)
        : ({
            mergeGitHubPullRequest: {
              state: "MERGED",
              postMergeError: "Jira unavailable",
              ticketKey: "APP-42",
            },
          } as never),
    );
    render(
      <MergePullRequestButton
        pullRequest={pullRequest}
        requestSource="PULL_REQUEST_DETAILS"
        onMerged={onMerged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await screen.findByDisplayValue("APP-42 Title");
    fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
    await screen.findByText(
      "Pull request merged, but a follow-up action failed.",
    );
    expect(
      screen.getByRole("link", { name: "APP-42" }).getAttribute("href"),
    ).toContain("/jira/tickets/APP-42");
    expect(
      screen
        .getByRole("button", { name: "Merge pull request" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    expect(onMerged).toHaveBeenCalledWith(
      expect.objectContaining({ state: "MERGED" }),
    );
  });
});
