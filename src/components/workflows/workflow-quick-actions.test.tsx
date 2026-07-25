import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";

import { WorkflowQuickActions } from "./workflow-quick-actions";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(controlPlaneRequest).mockReset();
});

test("starts a selected worktree quick action and links to the run", async () => {
  vi.mocked(controlPlaneRequest).mockResolvedValue({
    triggerWorkflow: { id: "run-1" },
  } as never);
  render(
    <WorkflowQuickActions
      sessionData={{ worktree: { id: "worktree-1" } }}
      workflows={[
        {
          id: "workflow-1",
          name: "Prepare review",
          description: "Runs the review preparation workflow",
          quickActionIconKey: "rocket",
          quickActionButtonVariant: "secondary",
        },
      ]}
      worktreeId="worktree-1"
    />,
  );

  const button = screen.getByRole("button", { name: "Prepare review" });
  expect(button.className).toContain("bg-secondary");
  expect(button.querySelector("svg")).not.toBeNull();
  fireEvent.click(button);

  await waitFor(() =>
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("RunWorktreeQuickAction"),
      {
        input: {
          workflowId: "workflow-1",
          sessionData: { worktree: { id: "worktree-1" } },
          resourceKind: "WORKTREE",
          resourceId: "worktree-1",
          subjectKey: "WORKTREE:worktree-1",
        },
      },
    ),
  );
  const viewLink = await screen.findByRole("link", { name: /View/ });
  expect(viewLink.getAttribute("href")).toBe("/workflows/runs/run-1");
  expect(viewLink.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(viewLink.className).toContain("rounded-r-none");
  expect(button.className).toContain("rounded-l-none");
});

test("hides the view button five seconds after the run starts", async () => {
  // A frozen clock, deliberately: `shouldAdvanceTime` would tick the hide timer
  // along with real time, so the 4999ms assertion below raced the machine and
  // failed whenever the surrounding suite made the render slow.
  vi.useFakeTimers();
  vi.mocked(controlPlaneRequest).mockResolvedValue({
    triggerWorkflow: { id: "run-1" },
  } as never);
  render(
    <WorkflowQuickActions
      sessionData={{ worktree: { id: "worktree-1" } }}
      workflows={[
        {
          id: "workflow-1",
          name: "Prepare review",
          description: "Runs the review preparation workflow",
          quickActionIconKey: "rocket",
          quickActionButtonVariant: "secondary",
        },
      ]}
      worktreeId="worktree-1"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Prepare review" }));
  // Flush the trigger mutation without advancing the hide timer.
  await act(async () => {});
  expect(screen.queryByRole("link", { name: /View/ })).not.toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(4999);
  });
  expect(screen.queryByRole("link", { name: /View/ })).not.toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.queryByRole("link", { name: /View/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Prepare review" }).className,
  ).not.toContain("rounded-l-none");
});
