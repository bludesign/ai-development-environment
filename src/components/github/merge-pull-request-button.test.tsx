import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

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
});

describe("MergePullRequestButton", () => {
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
          worktreeFolder: "/worktrees/api",
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
      if (eligible) expect(screen.getByText("/worktrees/api")).toBeDefined();
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
