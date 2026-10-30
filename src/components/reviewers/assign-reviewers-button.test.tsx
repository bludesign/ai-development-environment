import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { AssignReviewersButton } from "./assign-reviewers-button";
import type { WorktreeReviewerAssignment } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const request = vi.mocked(controlPlaneRequest);
const onCompleted = vi.fn(async () => undefined);
const worktree = { id: "worktree-1", canAssignReviewers: true };

function assignment(): WorktreeReviewerAssignment {
  return {
    worktreeId: worktree.id,
    requestId: "github:repo:42",
    requestUrl: "https://github.com/acme/app/pull/42",
    provider: "GITHUB",
    requestOpen: true,
    authorId: "author",
    reviewers: ["ada", "ben", "cara", "dan"].map((id) => ({
      id,
      username: id,
      name: id.toUpperCase(),
      avatarUrl: null,
      url: null,
    })),
    requirements: [
      {
        id: "platform",
        name: "Platform owners",
        poolKeys: ["platform"],
        requiredApprovals: 2,
        eligibleReviewerIds: ["ada", "ben", "cara", "dan"],
        candidateReviewerIds: ["ben", "cara"],
        approvedReviewerIds: ["dan"],
        requestedReviewerIds: ["ada"],
      },
      {
        id: "security",
        name: "Security review",
        poolKeys: ["security"],
        requiredApprovals: 1,
        eligibleReviewerIds: ["ben"],
        candidateReviewerIds: ["ben"],
        approvedReviewerIds: [],
        requestedReviewerIds: [],
      },
    ],
    currentReviewerIds: ["ada"],
    approvedReviewerIds: ["dan"],
    selectedReviewerIds: [],
    issues: [],
    discoveryComplete: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  request.mockImplementation(async (query) => {
    if (query.includes("query WorktreeReviewerAssignment"))
      return { worktreeReviewerAssignment: assignment() } as never;
    if (query.includes("query PreviewRandomWorktreeReviewers"))
      return {
        previewRandomWorktreeReviewers: {
          ...assignment(),
          selectedReviewerIds: ["ben"],
        },
      } as never;
    if (query.includes("mutation AssignWorktreeReviewers"))
      return {
        assignWorktreeReviewers: {
          ...assignment(),
          currentReviewerIds: ["ada", "ben"],
        },
      } as never;
    throw new Error(`Unexpected query: ${query}`);
  });
});

async function openPicker() {
  render(
    <AssignReviewersButton onCompleted={onCompleted} worktree={worktree} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Assign reviewers" }));
  return screen.findByRole("option", {
    name: "Select ben for Platform owners",
  });
}

describe("AssignReviewersButton", () => {
  test("hides the action and avoids provider queries when the server disallows assignment", () => {
    render(
      <AssignReviewersButton
        onCompleted={onCompleted}
        worktree={{ ...worktree, canAssignReviewers: false }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Assign reviewers" }),
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test("counts approvals separately and selects an overlapping reviewer once", async () => {
    const ben = await openPicker();
    expect(
      screen.getByText(
        "Required: 2 · Approved: 1 · Requested: 1 · Selected: 0",
      ),
    ).toBeDefined();
    expect(
      screen
        .getByRole("option", { name: "Select ada for Platform owners" })
        .getAttribute("aria-disabled"),
    ).toBe("false");
    fireEvent.click(ben);
    expect(
      screen
        .getByRole("option", { name: "Select ben for Security review" })
        .getAttribute("data-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
    const mutation = request.mock.calls.find(([query]) =>
      query.includes("mutation AssignWorktreeReviewers"),
    );
    expect(mutation?.[1]).toEqual({
      input: {
        worktreeId: worktree.id,
        requestId: "github:repo:42",
        reviewerIds: ["ben"],
        removeReviewerIds: [],
        includeAllReviewers: false,
      },
    });
  });

  test("random selection previews additions before explicit assignment", async () => {
    await openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Random selection" }));
    await screen.findByRole("button", { name: "Save changes" });
    expect(
      request.mock.calls.some(([query]) => query.includes("mutation")),
    ).toBe(false);
    expect(onCompleted).not.toHaveBeenCalled();
    expect(
      request.mock.calls.find(([query]) =>
        query.includes("query PreviewRandomWorktreeReviewers"),
      )?.[1],
    ).toEqual({
      worktreeId: worktree.id,
      requestId: "github:repo:42",
      selectedReviewerIds: ["ada"],
    });
  });

  test("reloads provider state after a failed assignment before allowing a retry", async () => {
    const ben = await openPicker();
    request.mockRejectedValueOnce(new Error("Provider permission denied"));
    fireEvent.click(ben);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(
        request.mock.calls.filter(([query]) =>
          query.includes("query WorktreeReviewerAssignment"),
        ),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("option", { name: "Select ben for Platform owners" })
          .getAttribute("data-checked"),
      ).toBe("false"),
    );
    fireEvent.click(
      screen.getByRole("option", { name: "Select ben for Platform owners" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
  });

  test("keeps existing reviewers visible when they are outside the applicable groups", async () => {
    const next = assignment();
    next.reviewers.push({
      id: "outside",
      username: "outside",
      name: "Outside reviewer",
      avatarUrl: null,
      url: null,
    });
    next.currentReviewerIds.push("outside");
    request.mockResolvedValueOnce({
      worktreeReviewerAssignment: next,
    } as never);
    await openPicker();
    const outside = screen.getByRole("option", {
      name: "Existing reviewer outside",
    });
    expect(outside.getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByText("Existing reviewers")).toBeDefined();
  });

  test("disables assignment when the live request has closed", async () => {
    request.mockResolvedValueOnce({
      worktreeReviewerAssignment: { ...assignment(), requestOpen: false },
    } as never);
    await openPicker();
    expect(screen.getByText(/no longer open/)).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Random selection" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Save changes" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});

test("initially checks requested reviewers and allows removing the last request", async () => {
  await openPicker();
  const ada = screen.getByRole("checkbox", {
    name: "Select ada for Platform owners",
  });
  expect(ada.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(ada);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
  expect(
    request.mock.calls.find(([query]) =>
      query.includes("mutation AssignWorktreeReviewers"),
    )?.[1],
  ).toMatchObject({ input: { reviewerIds: [], removeReviewerIds: ["ada"] } });
});
test("loads all eligible people only on demand and retains pending selections", async () => {
  const ben = await openPicker();
  expect(request.mock.calls[0]?.[1]).toMatchObject({ all: false });
  fireEvent.click(ben);
  fireEvent.click(screen.getByRole("button", { name: "Load all reviewers" }));
  await waitFor(() =>
    expect(
      request.mock.calls.filter(([query]) =>
        query.includes("query WorktreeReviewerAssignment"),
      ),
    ).toHaveLength(2),
  );
  expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ all: true });
  await waitFor(() =>
    expect(
      screen
        .getByRole("checkbox", { name: "Select ben for Platform owners" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});
