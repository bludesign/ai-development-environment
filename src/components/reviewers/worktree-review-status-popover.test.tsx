import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { Badge } from "@/components/ui/badge";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import type { WorktreeReviewStatus } from "./types";
import { WorktreeReviewStatusPopover } from "./worktree-review-status-popover";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);

function status(): WorktreeReviewStatus {
  return {
    worktreeId: "worktree",
    requestId: "PR_42",
    requestUrl: "https://github.com/acme/app/pull/42",
    provider: "GITHUB",
    requestOpen: true,
    discoveryComplete: true,
    issues: [],
    reviewers: ["ada", "ben", "dan"].map((id) => ({
      id,
      username: id,
      name: id.toUpperCase(),
      avatarUrl: null,
      url: null,
    })),
    currentReviewerIds: ["ada"],
    approvedReviewerIds: ["dan"],
    requirements: [
      {
        id: "platform",
        name: "Platform owners",
        isRequired: true,
        patterns: ["src/**", "tests/**"],
        requiredApprovals: 2,
        groups: [
          { key: "platform", name: "@acme/platform", kind: "CODEOWNERS" },
        ],
        eligibleReviewerIds: ["ada", "ben", "dan"],
        approvedReviewerIds: ["dan", "dan"],
        requestedReviewerIds: ["ada"],
      },
    ],
  };
}

function popover(requestId = "PR_42") {
  return (
    <WorktreeReviewStatusPopover
      worktreeId="worktree"
      requestId={requestId}
      requestUrl="https://github.com/acme/app/pull/42"
      requestLabel="PR #42"
    >
      <Badge>Review required</Badge>
    </WorktreeReviewStatusPopover>
  );
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ worktreeReviewStatus: status() } as never);
});

async function open() {
  fireEvent.click(
    screen.getByRole("button", { name: "Review details for PR #42" }),
  );
  return screen.findByRole("region", { name: "Approved reviewers" });
}

test("loads on demand, separates approvals from requests, and expands eligible members without assigning", async () => {
  const navigate = vi.fn();
  render(<div onClick={navigate}>{popover()}</div>);
  expect(request).not.toHaveBeenCalled();
  await open();
  expect(navigate).not.toHaveBeenCalled();
  expect(
    within(
      screen.getByRole("region", { name: "Approved reviewers" }),
    ).getByText("DAN"),
  ).toBeDefined();
  expect(
    within(
      screen.getByRole("region", { name: "Requested reviewers" }),
    ).getByText("ADA"),
  ).toBeDefined();
  const rule = screen.getByRole("region", { name: "Platform owners" });
  expect(within(rule).getByText("1 of 2 approvals")).toBeDefined();
  expect(within(rule).getByText("Requested: 1")).toBeDefined();
  expect(within(rule).getByText("@acme/platform")).toBeDefined();
  expect(within(rule).getByText("src/**, tests/**")).toBeDefined();
  const summary = within(rule).getByText("Eligible reviewers (3)");
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(within(rule).getByText("BEN")).toBeDefined();
  expect(within(rule).getByText("Approved")).toBeDefined();
  expect(within(rule).getByText("Requested")).toBeDefined();
  expect(navigate).not.toHaveBeenCalled();
  expect(
    screen.getByRole("link", { name: "Open PR #42" }).getAttribute("href"),
  ).toBe(status().requestUrl);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][0]).toContain("query WorktreeReviewStatus");
  expect(request.mock.calls[0][1]).toEqual({
    worktreeId: "worktree",
    all: false,
    refresh: false,
  });
  expect(screen.queryByRole("button", { name: /Assign/ })).toBeNull();
});

test("shows suggestions without required counts and keeps grouped requirements intact", async () => {
  const data = status();
  data.provider = "GITLAB";
  data.requirements[0].groups.push({
    key: "tests",
    name: "@acme/test-owners",
    kind: "CODEOWNERS",
  });
  data.requirements.push({
    ...data.requirements[0],
    id: "optional",
    name: "Suggested docs owners",
    isRequired: false,
    requiredApprovals: 0,
  });
  request.mockResolvedValue({ worktreeReviewStatus: data } as never);
  render(popover());
  await open();
  expect(screen.getAllByText("1 of 2 approvals")).toHaveLength(1);
  expect(screen.getByText("Suggested")).toBeDefined();
  expect(
    within(
      screen.getByRole("region", { name: "Suggested docs owners" }),
    ).queryByText(/of .* approvals/),
  ).toBeNull();
  expect(
    screen.getAllByRole("region", { name: "Platform owners" }),
  ).toHaveLength(1);
});

test("shows empty, closed, and incomplete discovery states alongside available approvals", async () => {
  const data = status();
  data.requirements = [];
  data.requestOpen = false;
  data.currentReviewerIds = [];
  request.mockResolvedValueOnce({ worktreeReviewStatus: data } as never);
  render(popover());
  await open();
  expect(
    screen.getByText("This pull or merge request is closed or merged."),
  ).toBeDefined();
  expect(screen.getByText("No requested reviewers to show.")).toBeDefined();
  expect(
    screen.getByText("No approval requirements or code-owner suggestions."),
  ).toBeDefined();
  data.discoveryComplete = false;
  data.issues = ["Team members unavailable"];
  request.mockResolvedValueOnce({ worktreeReviewStatus: data } as never);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh review details" }),
  );
  await screen.findByText("Team members unavailable");
  expect(
    screen.getByText("Approval requirements could not be fully verified."),
  ).toBeDefined();
  expect(screen.getByText("DAN")).toBeDefined();
});

test("shows loading, retries a failed read, and refreshes on reopening", async () => {
  const pending = Promise.withResolvers<never>();
  request.mockReturnValueOnce(pending.promise);
  render(popover());
  fireEvent.click(
    screen.getByRole("button", { name: "Review details for PR #42" }),
  );
  expect(screen.getByRole("status").textContent).toContain("Loading reviewers");
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  await act(async () => pending.reject(new Error("Provider unavailable")));
  await screen.findByText("Provider unavailable");
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh review details" }),
  );
  await screen.findByRole("region", { name: "Approved reviewers" });
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Review details for PR #42" }),
    ),
  );
  await open();
  expect(request).toHaveBeenCalledTimes(3);
});

test("aborts on close and ignores a response arriving after reopening", async () => {
  const pending = Promise.withResolvers<never>();
  request.mockReturnValueOnce(pending.promise);
  render(popover());
  fireEvent.click(
    screen.getByRole("button", { name: "Review details for PR #42" }),
  );
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const signal = request.mock.calls[0][2]?.signal;
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(signal?.aborted).toBe(true));
  await open();
  const stale = status();
  stale.reviewers[2].name = "STALE";
  await act(async () =>
    pending.resolve({ worktreeReviewStatus: stale } as never),
  );
  expect(screen.queryByText("STALE")).toBeNull();
  expect(
    within(
      screen.getByRole("region", { name: "Approved reviewers" }),
    ).getByText("DAN"),
  ).toBeDefined();
});

test("aborts on request changes and unmount, and rejects a mismatched provider response", async () => {
  const pending = Promise.withResolvers<never>();
  request.mockReturnValueOnce(pending.promise);
  const view = render(popover());
  fireEvent.click(
    screen.getByRole("button", { name: "Review details for PR #42" }),
  );
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  const oldSignal = request.mock.calls[0][2]?.signal;
  view.rerender(popover("PR_new"));
  await screen.findByText(
    "The linked pull or merge request has changed. Refresh the worktree and reopen review details.",
  );
  expect(oldSignal?.aborted).toBe(true);
  expect(
    screen.queryByRole("region", { name: "Approved reviewers" }),
  ).toBeNull();
  await act(async () =>
    pending.resolve({ worktreeReviewStatus: status() } as never),
  );
  expect(
    screen.queryByRole("region", { name: "Approved reviewers" }),
  ).toBeNull();
  const lastSignal = request.mock.calls.at(-1)?.[2]?.signal;
  view.unmount();
  expect(lastSignal?.aborted).toBe(true);
});
