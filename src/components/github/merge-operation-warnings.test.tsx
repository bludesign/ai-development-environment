import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  clearMergeOperation,
  githubMergeOperationKey,
} from "./merge-operation-state";
import { MergeOperationWarnings } from "./merge-operation-warnings";
import { MergePullRequestButton } from "./merge-pull-request-button";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = { repositoryNameWithOwner: "acme/widgets", number: 19 };

afterEach(async () => {
  cleanup();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  clearMergeOperation(githubMergeOperationKey(request));
  vi.mocked(controlPlaneRequest).mockReset();
});

test("keeps a merge warning reviewable after refreshing removes the originating row", async () => {
  vi.mocked(controlPlaneRequest).mockImplementation(async (query) =>
    query.includes("query GitHubPullRequestMergeOptions")
      ? ({
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH"],
            commitEmails: [],
            defaultCommitHeadline: "Improve API",
            defaultCommitBody: "",
            canMerge: true,
          },
        } as never)
      : ({
          mergeGitHubPullRequest: {
            state: "MERGED",
            postMergeError: "Jira unavailable",
          },
        } as never),
  );
  const refreshed = vi.fn();
  function Surface() {
    const [rowPresent, setRowPresent] = useState(true);
    return (
      <>
        <MergeOperationWarnings provider="github" />
        {rowPresent && (
          <MergePullRequestButton
            pullRequest={request}
            requestSource="PULL_REQUESTS_PAGE"
            onMerged={() => {
              refreshed();
              setRowPresent(false);
            }}
          />
        )}
      </>
    );
  }
  render(<Surface />);
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));
  await screen.findByDisplayValue("Improve API");
  fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
  const review = await screen.findByRole("button", {
    name: "Review merge error",
  });
  expect(
    screen.queryByRole("button", { name: "Merge", hidden: true }),
  ).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Jira unavailable")).toBeDefined();
  fireEvent.click(review);
  const sheet = await screen.findByRole("dialog");
  expect(
    within(sheet).getByText(
      "Pull request merged, but a follow-up action failed.",
    ),
  ).toBeDefined();
  fireEvent.click(within(sheet).getAllByRole("button", { name: "Close" })[0]!);
  expect(refreshed).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss merge error" }));
  expect(
    screen.queryByRole("button", { name: "Review merge error" }),
  ).toBeNull();
});
