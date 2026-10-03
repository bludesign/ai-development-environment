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
import type { GitLabMergeOptions } from "@/services/gitlab";

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
afterEach(() => {
  cleanup();
  request.mockReset();
});

describe("GitLab merge options", () => {
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
