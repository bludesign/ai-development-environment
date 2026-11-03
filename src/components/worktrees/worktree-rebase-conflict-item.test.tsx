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

import type { Worktree, WorktreeCodebaseGroup } from "./types";
import { WorktreeRebaseConflictItem } from "./worktree-rebase-conflict-item";

const subscribe = vi.hoisted(() => vi.fn());

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({ subscribe }),
  onControlPlaneRecovery: () => () => undefined,
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

type ActiveRun = {
  id: string;
  workflowId: string;
  displayNumber: number;
  status: string;
};

const activeRun: ActiveRun = {
  id: "run-1",
  workflowId: "resolve-conflicts",
  displayNumber: 1,
  status: "RUNNING",
};

let workflowSink:
  | {
      next: (value: {
        data: { workflowChanges: { definitionsChanged: boolean } };
      }) => void;
    }
  | undefined;

afterEach(() => {
  cleanup();
  workflowSink = undefined;
  subscribe.mockReset();
  vi.mocked(controlPlaneRequest).mockReset();
});

function respondWithRuns(
  initial: ActiveRun[] = [],
  beforeTrigger?: Promise<void>,
) {
  let runs = initial;
  subscribe.mockImplementation((_operation, sink) => {
    workflowSink = sink;
    return () => undefined;
  });
  vi.mocked(controlPlaneRequest).mockImplementation(async (query: string) => {
    if (query.includes("WorkflowTargetSummaries")) {
      return {
        workflowTargetSummaries: [
          {
            resourceKind: "WORKTREE",
            resourceId: "worktree-1",
            activeRuns: runs,
          },
        ],
      } as never;
    }
    if (query.includes("RunWorktreeQuickAction")) {
      await beforeTrigger;
      runs = [...runs, activeRun];
      return { triggerWorkflow: activeRun } as never;
    }
    throw new Error(`Unexpected request: ${query}`);
  });
  return {
    async finishRun() {
      runs = [];
      await act(async () => {
        workflowSink?.next({
          data: { workflowChanges: { definitionsChanged: false } },
        });
      });
    },
  };
}

function props(changes: Partial<Worktree> = {}) {
  return {
    worktree: {
      id: "worktree-1",
      folder: "/repos/feature",
      branch: "feature",
      baseBranch: "main",
      headSha: "head-1",
      rebaseInProgress: true,
      hasConflicts: true,
      ...changes,
    } as Worktree,
    group: {
      codebase: { id: "codebase-1", folder: "/repos/main" },
      repository: {
        id: "repository-1",
        name: "Repository",
        displayOrigin: "github.com/org/repository",
      },
      mergeConflictQuickActions: [
        {
          id: "resolve-conflicts",
          name: "Resolve conflicts",
          description: "Resolve the rebase conflicts",
          quickActionIconKey: "git-merge",
          quickActionButtonVariant: "secondary",
        },
        {
          id: "other-resolution",
          name: "Other resolution",
          description: "Another conflict workflow",
          quickActionIconKey: "git-merge",
          quickActionButtonVariant: "secondary",
        },
      ],
    } as WorktreeCodebaseGroup,
    onCompleted: vi.fn(async () => undefined),
    onError: vi.fn(),
  };
}

const manageRun = () =>
  screen.findByRole("button", { name: "Manage running Resolve conflicts" });

test("keeps the triggered workflow and spinner until it finishes after the rebase", async () => {
  const response = respondWithRuns();
  const { rerender } = render(<WorktreeRebaseConflictItem {...props()} />);
  expect(
    screen.getByRole("button", { name: "Other resolution" }),
  ).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
  const spinnerButton = await manageRun();
  expect(spinnerButton.querySelector('[data-slot="spinner"]')).not.toBeNull();

  rerender(<WorktreeRebaseConflictItem {...props({ hasConflicts: false })} />);
  expect(
    screen.getByRole("button", { name: "Resolve conflicts" }),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Other resolution" })).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel rebase" })).toBeDefined();
  expect(await manageRun()).toBe(spinnerButton);

  rerender(
    <WorktreeRebaseConflictItem
      {...props({ hasConflicts: false, rebaseInProgress: false })}
    />,
  );
  expect(screen.queryByText("Rebase paused")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel rebase" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Resolve conflicts" }),
  ).toBeDefined();
  expect(await manageRun()).toBe(spinnerButton);

  await response.finishRun();
  await waitFor(() => {
    expect(
      screen.queryByRole("button", { name: "Resolve conflicts" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Manage running Resolve conflicts",
      }),
    ).toBeNull();
  });
});

test("retains a pending trigger when conflict updates arrive before its response", async () => {
  let resolveTrigger!: () => void;
  const triggerPending = new Promise<void>((resolve) => {
    resolveTrigger = resolve;
  });
  respondWithRuns([], triggerPending);
  const { rerender } = render(<WorktreeRebaseConflictItem {...props()} />);
  await waitFor(() =>
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("WorkflowTargetSummaries"),
      expect.anything(),
      expect.anything(),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
  rerender(
    <WorktreeRebaseConflictItem
      {...props({ hasConflicts: false, rebaseInProgress: false })}
    />,
  );

  const button = screen.getByRole("button", { name: /Resolve conflicts$/ });
  expect(button.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Other resolution" })).toBeNull();

  await act(async () => resolveTrigger());
  const spinnerButton = await manageRun();
  expect(spinnerButton.querySelector('[data-slot="spinner"]')).not.toBeNull();
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
});

test("restores an active conflict quick action when opened after the rebase finishes", async () => {
  respondWithRuns([activeRun]);
  render(
    <WorktreeRebaseConflictItem
      {...props({ hasConflicts: false, rebaseInProgress: false })}
    />,
  );

  const spinnerButton = await manageRun();
  expect(spinnerButton.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "Resolve conflicts" }),
  ).toBeDefined();
  expect(screen.queryByRole("button", { name: "Other resolution" })).toBeNull();
  expect(screen.queryByText("Rebase paused")).toBeNull();
});

test("hides idle conflict actions after resolving conflicts while keeping the rebase controls", async () => {
  respondWithRuns();
  render(<WorktreeRebaseConflictItem {...props({ hasConflicts: false })} />);

  expect(screen.getByText("Rebase paused")).toBeDefined();
  expect(screen.getByRole("button", { name: "Cancel rebase" })).toBeDefined();
  expect(
    screen.queryByRole("button", { name: "Resolve conflicts" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Other resolution" })).toBeNull();
});
