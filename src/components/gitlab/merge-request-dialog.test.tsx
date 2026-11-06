import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  clearMergeOperation,
  gitlabMergeOperationKey,
  runMergeOperation,
} from "@/components/github/merge-operation-state";
import type { GitLabMergeOptions } from "@/services/gitlab";

import { MergeOperationLabel } from "@/components/github/post-merge-switch-client";
import { MergeRequestDialog } from "./merge-request-dialog";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
const target = { projectId: "42", iid: 17, title: "Improve the API" };
const options: GitLabMergeOptions = {
  ...target,
  state: "OPENED",
  sha: "reviewed-sha",
  sourceBranch: "feature/api",
  targetBranch: "main",
  mergeMethod: "merge",
  squashPolicy: "default_off",
  squash: false,
  removeSourceBranch: false,
  canRemoveSourceBranch: true,
  canMerge: true,
  canAutoMerge: true,
  canCancelAutoMerge: false,
  autoMergeEnabled: false,
  mergeBlockedReason: null,
  autoMergeBlockedReason: null,
  mergeCommitMessage: null,
  squashCommitMessage: null,
  worktreeId: "worktree-1",
  worktreeFolder: "/dashboard/worktrees/api",
  canDeleteWorktree: true,
  ticketKey: "APP-42",
  ticketDoneStatusConfigured: true,
  defaultMoveTicketToDone: false,
  defaultDeleteWorktree: false,
  operation: null,
};
const operation = {
  id: "op-1",
  state: "ACTION_REQUIRED",
  autoMerge: true,
  worktreeId: "worktree-1",
  ticketKey: "APP-42",
  lastError: "Jira unavailable",
  mergeConfirmedAt: "2026-09-29T00:00:00Z",
  ticketMovedAt: null,
  worktreeDeletedAt: null,
  updatedAt: "2026-09-29T00:00:00Z",
};
const show = () =>
  render(
    <MergeRequestDialog mergeRequest={target} onOpenChange={vi.fn()} open />,
  );
afterEach(async () => {
  cleanup();
  // Radix restores focus on a zero-delay timer after unmounting the dialog.
  // Let it dispatch its event before Vitest tears down the jsdom globals.
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  request.mockReset();
  clearMergeOperation(gitlabMergeOperationKey(target));
});

describe("GitLab merge options", () => {
  test("defaults to switching the primary checkout and retains background progress until completion", async () => {
    let finish!: (value: unknown) => void;
    const observation = new Promise((resolve) => {
      finish = resolve;
    });
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return {
          gitlabMergeRequestMergeOptions: {
            ...options,
            canDeleteWorktree: false,
            canSwitchToDefaultBranch: true,
            defaultSwitchToDefaultBranch: true,
            switchToDefaultBranchName: "main",
          },
        } as never;
      if (query.includes("query GitLabMergeOperation"))
        return (await observation) as never;
      return {
        submitGitLabMergeRequestMerge: {
          mergeRequest: { ...target, state: "MERGED" },
          operation: {
            ...operation,
            state: "POST_MERGE",
            lastError: null,
            postMergeSwitch: {
              branch: "main",
              state: "PENDING",
              lastError: null,
            },
          },
          postMergeError: null,
        },
      } as never;
    });
    function View() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>
            <MergeOperationLabel
              operationKey={gitlabMergeOperationKey(target)}
              idleLabel="Merge"
              pendingLabel="Merging…"
            />
          </button>
          <MergeRequestDialog
            mergeRequest={target}
            onOpenChange={setOpen}
            open={open}
          />
        </>
      );
    }
    render(<View />);
    expect(
      (
        await screen.findByRole("checkbox", {
          name: "Switch to main after merge",
        })
      ).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Merge now" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in background" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Updating main…" }),
    ).toBeDefined();
    await act(async () => {
      finish({
        gitlabMergeOperation: {
          ...operation,
          state: "COMPLETED",
          lastError: null,
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
      query.includes("mutation SubmitGitLabMergeRequestMerge"),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.[1]).toMatchObject({
      input: { switchToDefaultBranch: true },
    });
  });

  test("shows why switching is unavailable and permits a merge without it", async () => {
    request.mockResolvedValue({
      gitlabMergeRequestMergeOptions: {
        ...options,
        switchToDefaultBranchName: "trunk",
        canSwitchToDefaultBranch: false,
        defaultSwitchToDefaultBranch: false,
        switchToDefaultBranchUnavailableReason: "Update the agent first",
      },
    } as never);
    show();
    const checkbox = await screen.findByRole("checkbox", {
      name: "Switch to trunk after merge",
    });
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Update the agent first")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Merge now" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  test("keeps the confirmed result visible when refreshing the parent fails", async () => {
    request.mockImplementation(async (query) =>
      query.includes("query GitLabMergeRequestMergeOptions")
        ? ({ gitlabMergeRequestMergeOptions: options } as never)
        : ({
            submitGitLabMergeRequestMerge: {
              mergeRequest: { ...target, state: "MERGED" },
              operation: null,
              postMergeError: null,
            },
          } as never),
    );
    const onMerged = vi.fn().mockRejectedValue(new Error("View unavailable"));
    const onOpenChange = vi.fn();
    render(
      <MergeRequestDialog
        mergeRequest={target}
        onMerged={onMerged}
        onOpenChange={onOpenChange}
        open
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));
    expect(
      await screen.findByText(/refreshing this view failed: View unavailable/),
    ).toBeDefined();
    expect(screen.getByText("Merge completed")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("removes old request readiness immediately when switching the sheet target", async () => {
    request.mockResolvedValue({
      gitlabMergeRequestMergeOptions: options,
    } as never);
    const view = show();
    const oldSubmit = await screen.findByRole("button", { name: "Merge now" });
    request.mockClear();
    view.rerender(
      <MergeRequestDialog
        mergeRequest={{ ...target, iid: 18 }}
        onOpenChange={vi.fn()}
        open
      />,
    );
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
    fireEvent.click(oldSubmit);
    expect(
      request.mock.calls.some(([query]) => query.includes("mutation")),
    ).toBe(false);
  });

  test("keeps Jira failure and follow-up retry after the checkout switch completed", async () => {
    let retried = false;
    const switched = { branch: "main", state: "COMPLETED", lastError: null };
    const savedOperation = { ...operation, postMergeSwitch: switched };
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return {
          gitlabMergeRequestMergeOptions: {
            ...options,
            state: "MERGED",
            operation: savedOperation,
          },
        } as never;
      if (query.includes("query GitLabMergeOperation"))
        return {
          gitlabMergeOperation: {
            ...savedOperation,
            state: retried ? "COMPLETED" : "ACTION_REQUIRED",
            lastError: retried ? null : "Jira unavailable",
          },
        } as never;
      retried = true;
      return {
        retryGitLabMergeFollowUps: {
          mergeRequest: { ...target, state: "MERGED" },
          postMergeError: null,
          operation: { ...savedOperation, state: "COMPLETED", lastError: null },
        },
      } as never;
    });
    show();
    await screen.findByText("Switched to main.");
    expect(screen.getByText("Jira unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry follow-ups" }));
    await waitFor(() =>
      expect(screen.queryByText("Jira unavailable")).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Retry follow-ups" }),
    ).toBeNull();
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation RetryGitLabMergeFollowUps"),
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toBe(false);
  });

  test("shows a saved follow-up warning and retries it when loading fresh options fails", async () => {
    const saved = {
      mergeRequest: { ...target, state: "MERGED" },
      operation,
      postMergeError: "Jira unavailable",
      ticketTransitionError: null,
    };
    await runMergeOperation(
      gitlabMergeOperationKey(target),
      "merge",
      async () => saved,
      (value) => value.postMergeError,
    );
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        throw new Error("Readiness unavailable");
      return {
        retryGitLabMergeFollowUps: {
          ...saved,
          postMergeError: null,
          operation: { ...operation, state: "COMPLETED", lastError: null },
        },
      } as never;
    });
    const onOpenChange = vi.fn();
    render(
      <MergeRequestDialog
        mergeRequest={target}
        onOpenChange={onOpenChange}
        open
      />,
    );
    await screen.findByText("Readiness unavailable");
    expect(screen.getByText("Jira unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry follow-ups" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation RetryGitLabMergeFollowUps"),
        { projectId: target.projectId, iid: target.iid },
      ),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  test("continues a merge after dismissal and restores its error on a new sheet", async () => {
    let rejectMerge!: (error: Error) => void;
    const pendingMerge = new Promise<never>((_resolve, reject) => {
      rejectMerge = reject;
    });
    const onOpenChange = vi.fn();
    request.mockImplementation(async (query) =>
      query.includes("query GitLabMergeRequestMergeOptions")
        ? ({ gitlabMergeRequestMergeOptions: options } as never)
        : pendingMerge,
    );
    const original = render(
      <MergeRequestDialog
        mergeRequest={target}
        onOpenChange={onOpenChange}
        open
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));
    const background = await screen.findByRole("button", {
      name: "Continue in background",
    });
    expect(background.hasAttribute("disabled")).toBe(false);
    fireEvent.click(background);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    original.unmount();
    await act(async () => rejectMerge(new Error("Merge permissions changed")));
    show();
    expect(await screen.findByText("Merge permissions changed")).toBeDefined();
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toHaveLength(1);
  });

  test("keeps a background merge confirmed when reopened options arrive after completion", async () => {
    let finishMerge!: (value: unknown) => void;
    const pendingMerge = new Promise((resolve) => {
      finishMerge = resolve;
    });
    let finishOptions!: (value: unknown) => void;
    const pendingOptions = new Promise((resolve) => {
      finishOptions = resolve;
    });
    let optionsRequests = 0;
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions")) {
        optionsRequests++;
        return optionsRequests === 1
          ? ({ gitlabMergeRequestMergeOptions: options } as never)
          : ((await pendingOptions) as never);
      }
      return (await pendingMerge) as never;
    });
    const original = show();
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in background" }),
    );
    original.unmount();
    show();
    await waitFor(() => expect(optionsRequests).toBe(2));

    await act(async () =>
      finishMerge({
        submitGitLabMergeRequestMerge: {
          mergeRequest: { ...target, state: "MERGED" },
          operation: null,
          postMergeError: null,
          ticketTransitionError: null,
        },
      }),
    );
    await act(async () =>
      finishOptions({ gitlabMergeRequestMergeOptions: options }),
    );

    expect(screen.getByText("Merge completed")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toHaveLength(1);
  });

  test("does not dismiss a different request when an earlier background merge completes", async () => {
    let finishMerge!: (value: unknown) => void;
    const pendingMerge = new Promise((resolve) => {
      finishMerge = resolve;
    });
    const onOpenChange = vi.fn();
    const onMerged = vi.fn();
    const other = { ...target, iid: 18 };
    request.mockImplementation(async (query, variables) =>
      query.includes("query GitLabMergeRequestMergeOptions")
        ? ({
            gitlabMergeRequestMergeOptions: {
              ...options,
              iid: (variables as { iid: number }).iid,
            },
          } as never)
        : ((await pendingMerge) as never),
    );
    const view = render(
      <MergeRequestDialog
        mergeRequest={target}
        onMerged={onMerged}
        onOpenChange={onOpenChange}
        open
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Continue in background" }),
    );
    view.rerender(
      <MergeRequestDialog
        mergeRequest={other}
        onMerged={onMerged}
        onOpenChange={onOpenChange}
        open
      />,
    );
    await screen.findByRole("button", { name: "Merge now" });
    await act(async () =>
      finishMerge({
        submitGitLabMergeRequestMerge: {
          mergeRequest: { ...target, state: "MERGED" },
          postMergeError: null,
          ticketTransitionError: null,
          operation: null,
        },
      }),
    );
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Merge now" })).toBeDefined();
    clearMergeOperation(gitlabMergeOperationKey(other));
  });

  test("shows a Jira activation warning while keeping successful auto merge enabled", async () => {
    const warning = "Auto merge is enabled, but Jira requires a Comment";
    const onOpenChange = vi.fn();
    request.mockImplementation(async (query) =>
      query.includes("query GitLabMergeRequestMergeOptions")
        ? ({
            gitlabMergeRequestMergeOptions: { ...options, canMerge: false },
          } as never)
        : ({
            submitGitLabMergeRequestMerge: {
              mergeRequest: {
                ...target,
                state: "OPENED",
                mergeWhenPipelineSucceeds: false,
              },
              operation: {
                ...operation,
                state: "WAITING_REQUIREMENTS",
                mergeConfirmedAt: null,
                lastError: null,
              },
              postMergeError: null,
              ticketTransitionError: warning,
            },
          } as never),
    );
    render(
      <MergeRequestDialog
        mergeRequest={target}
        onOpenChange={onOpenChange}
        open
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Enable auto-merge" }),
    );
    expect(await screen.findByText(warning)).toBeDefined();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test("queues branch syncing when a rebase blocks native auto-merge", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return {
          gitlabMergeRequestMergeOptions: {
            ...options,
            canMerge: false,
            canAutoMerge: false,
            canAutoMergeWithSync: true,
            autoSyncBlockedReason: null,
            mergeBlockedReason: "Rebase the source branch before merging.",
          },
        } as never;
      return {
        submitGitLabMergeRequestMerge: {
          mergeRequest: {
            ...target,
            state: "OPENED",
            mergeWhenPipelineSucceeds: false,
          },
          operation: {
            ...operation,
            autoSync: true,
            state: "SYNCING",
            mergeConfirmedAt: null,
            lastError: null,
          },
          postMergeError: null,
        },
      } as never;
    });
    show();
    await screen.findByRole("checkbox", { name: "Auto sync branch" });
    expect(
      (
        screen.getByRole("button", {
          name: "Enable auto-merge",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto sync branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Enable auto-merge" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SubmitGitLabMergeRequestMerge"),
        expect.objectContaining({
          input: expect.objectContaining({
            autoMerge: true,
            autoSync: true,
            sha: options.sha,
            worktreeId: options.worktreeId,
          }),
        }),
      ),
    );
  });

  test.each([true, false])(
    "shows managed progress while native auto-merge is off (sync=%s)",
    async (autoSync) => {
      request.mockImplementation(async (query) => {
        if (query.includes("query GitLabMergeRequestMergeOptions"))
          return {
            gitlabMergeRequestMergeOptions: {
              ...options,
              defaultAutoSync: autoSync,
              canCancelAutoMerge: true,
              operation: {
                ...operation,
                autoSync,
                state: "WAITING_CI",
                mergeConfirmedAt: null,
                lastError: null,
              },
            },
          } as never;
        return {
          cancelGitLabAutoMerge: {
            mergeRequest: {
              ...target,
              state: "OPENED",
              mergeWhenPipelineSucceeds: false,
            },
            operation: {
              ...operation,
              autoSync,
              state: "CANCELED",
              mergeConfirmedAt: null,
              lastError: null,
            },
            postMergeError: null,
          },
        } as never;
      });
      show();
      await screen.findAllByText("Waiting for CI");
      expect(screen.getByRole("status").textContent).toBe("Waiting for CI");
      fireEvent.click(
        screen.getByRole("button", { name: "Cancel auto-merge" }),
      );
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          expect.stringContaining("mutation CancelGitLabAutoMerge"),
          { projectId: target.projectId, iid: target.iid },
        ),
      );
    },
  );

  test("resumes only with the currently reviewed SHA", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return {
          gitlabMergeRequestMergeOptions: {
            ...options,
            sha: "new-reviewed-sha",
            defaultAutoSync: true,
            canAutoMergeWithSync: true,
            operation: { ...operation, autoSync: true, mergeConfirmedAt: null },
          },
        } as never;
      return {
        submitGitLabMergeRequestMerge: {
          mergeRequest: {
            ...target,
            state: "OPENED",
            mergeWhenPipelineSucceeds: false,
          },
          operation: {
            ...operation,
            autoSync: true,
            state: "SYNCING",
            mergeConfirmedAt: null,
            lastError: null,
          },
          postMergeError: null,
        },
      } as never;
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Resume Auto Merge" }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SubmitGitLabMergeRequestMerge"),
        expect.objectContaining({
          input: expect.objectContaining({
            autoSync: true,
            sha: "new-reviewed-sha",
          }),
        }),
      ),
    );
  });

  test("submits selected native settings and follow-ups with the reviewed SHA", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return { gitlabMergeRequestMergeOptions: options } as never;
      return {
        submitGitLabMergeRequestMerge: {
          mergeRequest: {
            ...target,
            state: "MERGED",
            mergeWhenPipelineSucceeds: false,
          },
          operation: { ...operation, state: "COMPLETED", lastError: null },
          postMergeError: null,
        },
      } as never;
    });
    show();
    await screen.findByRole("checkbox", { name: "Squash commits" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Squash commits" }));
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Delete source branch after merge",
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Customize merge commit message" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Merge commit message" }),
      { target: { value: "Merge API improvements" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Customize squash commit message" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Squash commit message" }),
      { target: { value: "APP-42 Improve API" } },
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Delete worktree after merge" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Move APP-42/ }));
    fireEvent.click(screen.getByRole("button", { name: "Merge now" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SubmitGitLabMergeRequestMerge"),
        {
          input: {
            projectId: "42",
            iid: 17,
            sha: "reviewed-sha",
            autoMerge: false,
            squash: true,
            removeSourceBranch: true,
            mergeCommitMessage: "Merge API improvements",
            squashCommitMessage: "APP-42 Improve API",
            worktreeId: "worktree-1",
            deleteWorktree: true,
            moveTicketToDone: true,
            switchToDefaultBranch: false,
          },
        },
      ),
    );
    expect(await screen.findByText("Merge completed")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
  });

  test.each(["always", "never"])(
    "locks squash to the %s project policy",
    async (policy) => {
      request.mockResolvedValue({
        gitlabMergeRequestMergeOptions: {
          ...options,
          squashPolicy: policy,
          squash: policy === "always",
        },
      } as never);
      show();
      const squash = await screen.findByRole("checkbox", {
        name: "Squash commits",
      });
      expect(squash.hasAttribute("disabled")).toBe(true);
      expect(squash.getAttribute("aria-checked")).toBe(
        String(policy === "always"),
      );
      expect(screen.queryByRole("combobox")).toBeNull();
    },
  );

  test("omits merge message overrides for fast-forward merges and preserves provider defaults", async () => {
    request.mockImplementation(async (query) =>
      query.includes("query GitLabMergeRequestMergeOptions")
        ? ({
            gitlabMergeRequestMergeOptions: {
              ...options,
              mergeMethod: "ff",
              canMerge: false,
            },
          } as never)
        : ({
            submitGitLabMergeRequestMerge: {
              mergeRequest: {
                ...target,
                state: "OPENED",
                mergeWhenPipelineSucceeds: true,
              },
              operation: {
                ...operation,
                state: "WAITING",
                mergeConfirmedAt: null,
                lastError: null,
              },
              postMergeError: null,
            },
          } as never),
    );
    show();
    await screen.findByText("Fast-forward");
    expect(
      screen.queryByRole("checkbox", {
        name: "Customize merge commit message",
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enable auto-merge" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation SubmitGitLabMergeRequestMerge"),
        {
          input: expect.objectContaining({
            autoMerge: true,
            mergeCommitMessage: null,
            squashCommitMessage: null,
            sha: "reviewed-sha",
          }),
        },
      ),
    );
    expect(
      await screen.findByText("GitLab will merge when its checks pass."),
    ).toBeDefined();
  });

  test("handles a cancellation racing with merge by retrying follow-ups, never merging twice", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return {
          gitlabMergeRequestMergeOptions: {
            ...options,
            autoMergeEnabled: true,
            canCancelAutoMerge: true,
          },
        } as never;
      if (query.includes("mutation CancelGitLabAutoMerge"))
        return {
          cancelGitLabAutoMerge: {
            mergeRequest: { ...target, state: "MERGED" },
            operation,
            postMergeError: "Jira unavailable",
          },
        } as never;
      if (query.includes("mutation RetryGitLabMergeFollowUps"))
        return {
          retryGitLabMergeFollowUps: {
            mergeRequest: { ...target, state: "MERGED" },
            operation: { ...operation, state: "COMPLETED", lastError: null },
            postMergeError: null,
          },
        } as never;
      throw new Error("Unexpected mutation");
    });
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel auto-merge" }),
    );
    expect(
      await screen.findByText(
        "The merge succeeded, but a follow-up needs attention.",
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry follow-ups" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          query.includes("mutation RetryGitLabMergeFollowUps"),
        ),
      ).toBe(true),
    );
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toBe(false);
  });

  test("retains the reviewed SHA after a conflict until the user explicitly refreshes", async () => {
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return { gitlabMergeRequestMergeOptions: options } as never;
      throw new Error("SHA does not match HEAD of source branch");
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));
    await screen.findByText("SHA does not match HEAD of source branch");
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("query GitLabMergeRequestMergeOptions"),
      ),
    ).toHaveLength(1);
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh merge options" }),
    );
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([query]) =>
          query.includes("query GitLabMergeRequestMergeOptions"),
        ),
      ).toHaveLength(2),
    );
  });

  test("replaces an earlier mutation outcome only after fresh options load successfully", async () => {
    let optionRequests = 0;
    request.mockImplementation(async (query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions")) {
        optionRequests++;
        if (optionRequests === 2) throw new Error("Readiness unavailable");
        return {
          gitlabMergeRequestMergeOptions:
            optionRequests === 1
              ? options
              : {
                  ...options,
                  state: "MERGED",
                  operation: {
                    ...operation,
                    state: "COMPLETED",
                    lastError: null,
                  },
                },
        } as never;
      }
      return {
        submitGitLabMergeRequestMerge: {
          mergeRequest: { ...target, state: "MERGED" },
          operation,
          postMergeError: "Jira unavailable",
        },
      } as never;
    });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Merge now" }));
    await screen.findByRole("button", { name: "Retry follow-ups" });

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh merge options" }),
    );
    await screen.findByText("Readiness unavailable");
    expect(
      screen.getByRole("button", { name: "Retry follow-ups" }),
    ).toBeDefined();
    expect(screen.getByText("Jira unavailable")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh merge options" }),
    );
    await screen.findByText("Completed");
    expect(
      screen.queryByRole("button", { name: "Retry follow-ups" }),
    ).toBeNull();
    expect(screen.queryByText("Jira unavailable")).toBeNull();
    expect(screen.queryByRole("button", { name: "Merge now" })).toBeNull();
  });

  test("blocks rapid duplicate actions before rendering and preserves edits after mutation failure", async () => {
    let rejectMutation!: (reason: Error) => void;
    request.mockImplementation((query) => {
      if (query.includes("query GitLabMergeRequestMergeOptions"))
        return Promise.resolve({
          gitlabMergeRequestMergeOptions: options,
        }) as never;
      return new Promise((_resolve, reject) => {
        rejectMutation = reject;
      });
    });
    show();
    await screen.findByRole("button", { name: "Merge now" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Squash commits" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Customize merge commit message" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Merge commit message" }),
      {
        target: { value: "Keep my reviewed message" },
      },
    );
    const merge = screen.getByRole("button", { name: "Merge now" });
    const auto = screen.getByRole("button", { name: "Enable auto-merge" });
    act(() => {
      merge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      merge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      auto.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("mutation SubmitGitLabMergeRequestMerge"),
      ),
    ).toHaveLength(1);

    await act(async () => {
      rejectMutation(new Error("GitLab unavailable"));
    });
    await screen.findByText("GitLab unavailable");
    expect(
      screen
        .getByRole("checkbox", { name: "Squash commits" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Merge commit message",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Keep my reviewed message");
    expect(
      (screen.getByRole("button", { name: "Merge now" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
