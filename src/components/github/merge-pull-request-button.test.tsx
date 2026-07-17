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
          },
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
      <MergePullRequestButton onMerged={onMerged} pullRequest={pullRequest} />,
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

    render(<MergePullRequestButton pullRequest={pullRequest} />);
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
});
