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

// Radix opens a menu on pointerdown and captures the pointer; jsdom implements
// neither, so the choice-menu test needs these stubs to reach the items.
Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
});

afterEach(() => {
  cleanup();
  workflowSink = undefined;
  subscribe.mockReset();
  vi.mocked(controlPlaneRequest).mockReset();
});

type ActiveRun = {
  id: string;
  workflowId: string;
  displayNumber: number;
  status: string;
};

let workflowSink:
  { next: (value: { data: { workflowChanges: unknown } }) => void } | undefined;

function respondWithRuns(initial: ActiveRun[] = []) {
  let runs = initial;
  subscribe.mockImplementation((_operation, sink) => {
    workflowSink = sink;
    return () => undefined;
  });
  vi.mocked(controlPlaneRequest).mockImplementation(
    async (query: string, variables) => {
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
        const run = {
          id: "run-1",
          workflowId: "workflow-1",
          displayNumber: 1,
          status: "RUNNING",
        };
        runs = [...runs, run];
        return { triggerWorkflow: run } as never;
      }
      if (query.includes("pauseWorkflowRun")) {
        const id = variables?.id;
        runs = runs.map((run) =>
          run.id === id ? { ...run, status: "PAUSING" } : run,
        );
        return { pauseWorkflowRun: { id, status: "PAUSING" } } as never;
      }
      if (query.includes("cancelWorkflowRun")) {
        const id = variables?.id;
        runs = runs.filter((run) => run.id !== id);
        return { cancelWorkflowRun: { id, status: "CANCELLED" } } as never;
      }
      return {} as never;
    },
  );
  return {
    setRuns(value: ActiveRun[]) {
      runs = value;
    },
  };
}

async function openRunMenu() {
  const trigger = await screen.findByRole("button", {
    name: "Manage running Prepare review",
  });
  fireEvent.pointerDown(
    trigger,
    new PointerEvent("pointerdown", {
      bubbles: true,
      ctrlKey: false,
      button: 0,
    }),
  );
  return trigger;
}

test("starts a selected worktree quick action and opens its active run", async () => {
  respondWithRuns();
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
          choice: null,
        },
      },
    ),
  );
  const runMenu = await openRunMenu();
  expect(runMenu.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(runMenu.textContent).not.toContain("View");
  const viewLink = screen.getByRole("menuitem", { name: /View/ });
  expect(viewLink.getAttribute("href")).toBe("/dashboard/workflows/runs/run-1");
  expect(runMenu.className).toContain("rounded-r-none");
  expect(button.className).toContain("rounded-l-none");
});

const quickActionProps = {
  sessionData: { worktree: { id: "worktree-1" } },
  workflows: [
    {
      id: "workflow-1",
      name: "Prepare review",
      description: "Runs the review preparation workflow",
      quickActionIconKey: "rocket",
      quickActionButtonVariant: "secondary" as const,
    },
  ],
  worktreeId: "worktree-1",
};

test.each([
  { label: "Pause", mutation: "pauseWorkflowRun" },
  { label: "Cancel run", mutation: "cancelWorkflowRun" },
])(
  "$label affects the selected run and refreshes the menu",
  async ({ label, mutation }) => {
    respondWithRuns([
      {
        id: "run-3",
        workflowId: "workflow-1",
        displayNumber: 3,
        status: "WAITING",
      },
      {
        id: "run-4",
        workflowId: "workflow-1",
        displayNumber: 4,
        status: "RUNNING",
      },
    ]);
    render(<WorkflowQuickActions {...quickActionProps} />);
    await openRunMenu();
    fireEvent.click(screen.getAllByRole("menuitem", { name: label })[1]);

    await waitFor(() =>
      expect(controlPlaneRequest).toHaveBeenCalledWith(
        expect.stringContaining(`${mutation}(id: $id)`),
        { id: "run-4" },
      ),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(controlPlaneRequest)
          .mock.calls.filter(([query]) =>
            query.includes("WorkflowTargetSummaries"),
          ),
      ).toHaveLength(2),
    );
    await openRunMenu();
    expect(screen.getAllByRole("menuitem", { name: "Pause" })).toHaveLength(1);
    expect(
      screen
        .getAllByRole("menuitem", { name: /View/ })
        .map((item) => item.getAttribute("href")),
    ).toEqual(
      mutation === "pauseWorkflowRun"
        ? ["/dashboard/workflows/runs/run-3", "/dashboard/workflows/runs/run-4"]
        : ["/dashboard/workflows/runs/run-3"],
    );
  },
);

test.each(["QUEUED", "PAUSING", "PAUSED"])(
  "keeps cancel and view available without pause for a %s run",
  async (status) => {
    respondWithRuns([
      { id: "run-1", workflowId: "workflow-1", displayNumber: 1, status },
    ]);
    render(<WorkflowQuickActions {...quickActionProps} />);
    await openRunMenu();

    expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Cancel run" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /View/ })).toBeDefined();
  },
);

test("shows lifecycle errors and allows retrying the action", async () => {
  respondWithRuns([
    {
      id: "run-1",
      workflowId: "workflow-1",
      displayNumber: 1,
      status: "BLOCKED",
    },
  ]);
  render(<WorkflowQuickActions {...quickActionProps} />);
  await openRunMenu();
  vi.mocked(controlPlaneRequest).mockRejectedValueOnce(
    new Error("Pause failed"),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));

  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Pause failed",
  );
  await openRunMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Pause" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await openRunMenu();
  expect(screen.queryByRole("menuitem", { name: "Pause" })).toBeNull();
});

test("asks which choice to run before starting a choice workflow", async () => {
  respondWithRuns();
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
          triggerChoices: [
            { key: "draft", label: "Draft PR", description: "" },
            {
              key: "ready",
              label: "Ready for review",
              description: "Marks it ready",
            },
          ],
        },
      ]}
      worktreeId="worktree-1"
    />,
  );

  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Prepare review" }),
    {
      button: 0,
      ctrlKey: false,
    },
  );
  // The button opens the menu rather than starting a run of its own.
  expect(controlPlaneRequest).not.toHaveBeenCalled();

  const item = await screen.findByRole("menuitem", {
    name: /Ready for review/,
  });
  fireEvent.click(item);

  await waitFor(() =>
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("RunWorktreeQuickAction"),
      expect.objectContaining({
        input: expect.objectContaining({ choice: "ready" }),
      }),
    ),
  );
});

test("keeps the plain trigger available beside choice triggers", async () => {
  respondWithRuns();
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
          hasPlainTrigger: true,
          triggerChoices: [
            { key: "draft", label: "Draft PR", description: "" },
          ],
        },
      ]}
      worktreeId="worktree-1"
    />,
  );

  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Prepare review" }),
    { button: 0, ctrlKey: false },
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: "Full run" }));

  await waitFor(() =>
    expect(controlPlaneRequest).toHaveBeenCalledWith(
      expect.stringContaining("RunWorktreeQuickAction"),
      expect.objectContaining({
        input: expect.objectContaining({ choice: null }),
      }),
    ),
  );
});

test("keeps the spinner visible until the workflow run finishes", async () => {
  const response = respondWithRuns();
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
  await openRunMenu();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: /View/ }), {
    key: "Escape",
  });

  response.setRuns([]);
  await act(async () => {
    workflowSink?.next({
      data: { workflowChanges: { definitionsChanged: false } },
    });
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "Manage running Prepare review",
      }),
    ).toBeNull(),
  );
});

test("lists every active run from the spinner menu", async () => {
  respondWithRuns([
    {
      id: "run-3",
      workflowId: "workflow-1",
      displayNumber: 3,
      status: "WAITING",
    },
    {
      id: "run-4",
      workflowId: "workflow-1",
      displayNumber: 4,
      status: "RUNNING",
    },
  ]);
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

  const trigger = await openRunMenu();
  expect(trigger.textContent).toContain("2");
  expect(screen.getByText("Workflow run #3")).toBeDefined();
  expect(screen.getByText("Workflow run #4")).toBeDefined();
  expect(
    screen
      .getAllByRole("menuitem", { name: /View/ })
      .map((item) => item.getAttribute("href")),
  ).toEqual([
    "/dashboard/workflows/runs/run-3",
    "/dashboard/workflows/runs/run-4",
  ]);
});

test("batches active-run summaries for rendered worktrees", async () => {
  subscribe.mockImplementation(() => () => undefined);
  vi.mocked(controlPlaneRequest).mockImplementation(
    async (query: string, variables) => {
      if (!query.includes("WorkflowTargetSummaries")) return {} as never;
      return {
        workflowTargetSummaries: (
          variables?.targets as Array<{
            resourceKind: string;
            resourceId: string;
          }>
        ).map((target) => ({ ...target, activeRuns: [] })),
      } as never;
    },
  );
  const workflow = {
    id: "workflow-1",
    name: "Prepare review",
    description: "Runs the review preparation workflow",
    quickActionIconKey: "rocket",
    quickActionButtonVariant: "secondary" as const,
  };

  render(
    <>
      <WorkflowQuickActions
        sessionData={{ worktree: { id: "worktree-1" } }}
        workflows={[workflow]}
        worktreeId="worktree-1"
      />
      <WorkflowQuickActions
        sessionData={{ worktree: { id: "worktree-2" } }}
        workflows={[workflow]}
        worktreeId="worktree-2"
      />
    </>,
  );

  await waitFor(() =>
    expect(
      vi
        .mocked(controlPlaneRequest)
        .mock.calls.filter(([query]) =>
          query.includes("WorkflowTargetSummaries"),
        ),
    ).toHaveLength(1),
  );
  const summaryCall = vi
    .mocked(controlPlaneRequest)
    .mock.calls.find(([query]) => query.includes("WorkflowTargetSummaries"));
  expect(summaryCall?.[1]?.targets).toEqual([
    { resourceKind: "WORKTREE", resourceId: "worktree-1" },
    { resourceKind: "WORKTREE", resourceId: "worktree-2" },
  ]);
});
