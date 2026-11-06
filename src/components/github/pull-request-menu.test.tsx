import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  clearMergeOperation,
  githubMergeOperationKey,
} from "./merge-operation-state";
import { PullRequestMenu } from "./pull-request-menu";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const pullRequest = {
  number: 17,
  repositoryNameWithOwner: "acme/widgets",
  url: "https://github.com/acme/widgets/pull/17",
};

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

afterEach(() => {
  cleanup();
  request.mockReset();
  clearMergeOperation(githubMergeOperationKey(pullRequest));
});

test("shows background merge progress on the badge and menu until it completes", async () => {
  let finishMerge!: (value: unknown) => void;
  const pendingMerge = new Promise((resolve) => {
    finishMerge = resolve;
  });
  request.mockImplementation(async (query) =>
    query.includes("query GitHubPullRequestMergeOptions")
      ? ({
          githubPullRequestMergeOptions: {
            availableMethods: ["SQUASH"],
            commitEmails: [],
            defaultCommitHeadline: "APP-42 Add the API",
            defaultCommitBody: "",
            canMerge: true,
          },
        } as never)
      : ((await pendingMerge) as never),
  );
  render(
    <PullRequestMenu
      label="#17"
      pullRequest={pullRequest}
      requestSource="ACTIONS_PAGE"
    />,
  );
  const badge = screen.getByRole("button", { name: "#17" });
  fireEvent.pointerDown(badge, { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("menuitem", { name: "Merge" }));
  await screen.findByDisplayValue("APP-42 Add the API");
  fireEvent.click(screen.getByRole("button", { name: "Merge pull request" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue in background" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(badge.getAttribute("aria-busy")).toBe("true");
  expect(badge.querySelector('[data-slot="spinner"]')).not.toBeNull();

  fireEvent.pointerDown(badge, { button: 0, ctrlKey: false });
  const progress = screen.getByRole("menuitem", { name: "Merging…" });
  expect(progress.getAttribute("aria-busy")).toBe("true");
  expect(progress.querySelector('[data-slot="spinner"]')).not.toBeNull();
  fireEvent.click(progress);
  fireEvent.click(
    await screen.findByRole("button", { name: "Continue in background" }),
  );

  await act(async () => {
    finishMerge({
      mergeGitHubPullRequest: { state: "MERGED", postMergeError: null },
    });
  });
  expect(badge.getAttribute("aria-busy")).toBe("false");
  expect(badge.querySelector('[data-slot="spinner"]')).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    request.mock.calls.filter(([query]) =>
      query.includes("mutation MergeGitHubPullRequest"),
    ),
  ).toHaveLength(1);
});
