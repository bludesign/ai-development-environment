import {
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
        },
      ]}
      worktreeId="worktree-1"
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Prepare review" }));

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
  expect(
    (await screen.findByRole("link", { name: "View run" })).getAttribute(
      "href",
    ),
  ).toBe("/workflows/runs/run-1");
});
