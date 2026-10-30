import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MergeFollowUpFields } from "./merge-follow-up-fields";
const options = {
  canDeleteWorktree: false,
  worktreeFolder: null,
  ticketKey: null,
  ticketDoneStatusConfigured: false,
  baseBranchUpdateOptions: {
    destinationBaseBranch: "main",
    selectedWorktreeIds: [],
    results: [],
    worktrees: [
      {
        id: "one",
        branch: "feature/one",
        folder: "/one",
        agentName: "Mac Studio",
        baseBranch: "parent",
        canUpdate: true,
      },
      {
        id: "two",
        branch: "feature/two",
        folder: "/two",
        agentName: "Mac mini",
        baseBranch: "parent",
        canUpdate: true,
      },
      {
        id: "self",
        branch: "main",
        folder: "/self",
        agentName: "Mac mini",
        baseBranch: "parent",
        canUpdate: false,
      },
    ],
  },
};
afterEach(cleanup);
test("supports independent opt-in selections across agents and disables invalid destinations", () => {
  const onChange = vi.fn();
  const props = {
    options,
    disabled: false,
    deleteWorktree: false,
    moveTicketToDone: false,
    onDeleteWorktreeChange: vi.fn(),
    onMoveTicketToDoneChange: vi.fn(),
    onSelectedWorktreeIdsChange: onChange,
  };
  const { rerender } = render(<MergeFollowUpFields {...props} />);
  const first = screen.getByRole("checkbox", { name: /feature\/one/ });
  expect(first.getAttribute("aria-checked")).toBe("false");
  expect(
    screen.getByRole("checkbox", { name: /main ·/ }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(first);
  expect(onChange).toHaveBeenCalledWith(["one"]);
  rerender(<MergeFollowUpFields {...props} selectedWorktreeIds={["one"]} />);
  expect(
    screen
      .getByRole("checkbox", { name: /feature\/one/ })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen
      .getByRole("checkbox", { name: /feature\/two/ })
      .getAttribute("aria-checked"),
  ).toBe("false");
});
test("hides the section when no worktrees target the merging branch", () => {
  render(
    <MergeFollowUpFields
      options={{ ...options, baseBranchUpdateOptions: null }}
      disabled={false}
      deleteWorktree={false}
      moveTicketToDone={false}
      onDeleteWorktreeChange={vi.fn()}
      onMoveTicketToDoneChange={vi.fn()}
    />,
  );
  expect(screen.queryByText("Update targeting worktrees")).toBeNull();
});
