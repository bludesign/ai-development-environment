import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { TooltipProvider } from "@/components/ui/tooltip";

import {
  WorkflowRunPage,
  workflowQuestionAnswerPayload,
  type WorkflowQuestion,
} from "./workflow-run-page";
import type { WorkflowRun } from "./types";

const routerPush = vi.hoisted(() => vi.fn());

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
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
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("./workflow-graph", () => ({
  WorkflowGraph: ({
    onNodeClick,
  }: {
    onNodeClick?: (nodeId: string, details: Record<string, unknown>) => void;
  }) => (
    <div>
      Workflow graph
      <button
        onClick={() =>
          onNodeClick?.("linked", {
            destination: { href: "/sessions/session-1", external: false },
            locked: true,
            trigger: false,
          })
        }
      >
        Locked linked step
      </button>
      <button
        onClick={() =>
          onNodeClick?.("action", {
            destination: null,
            locked: false,
            trigger: false,
          })
        }
      >
        Unlocked action step
      </button>
      <button
        onClick={() =>
          onNodeClick?.("trigger", {
            destination: null,
            locked: false,
            trigger: true,
          })
        }
      >
        Unlocked trigger
      </button>
    </div>
  ),
  workflowStatusVariant: () => "outline",
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const questions: WorkflowQuestion[] = [
  {
    id: "scope",
    prompt: "Which changes?",
    multiSelect: true,
    allowCustom: true,
    options: [
      { id: "frontend", label: "Frontend" },
      { id: "backend", label: "Backend" },
    ],
  },
  {
    id: "approval",
    prompt: "Continue?",
    multiSelect: false,
    allowCustom: false,
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
  },
];

const pendingRun = {
  id: "run-1",
  displayNumber: 7,
  workflowId: "workflow-1",
  workflow: { id: "workflow-1", name: "Release" },
  versionId: "version-1",
  version: {
    id: "version-1",
    workflowId: "workflow-1",
    version: 1,
    name: "Release",
    description: "",
    schemaVersion: 1,
    contentHash: "hash",
    publishedAt: "2026-07-24T12:00:00.000Z",
    definition: {
      format: "aide.workflow",
      schemaVersion: 1,
      name: "Release",
      description: "",
      triggers: [],
      nodes: [],
      edges: [],
      editor: {},
    },
  },
  triggerKind: "MANUAL",
  triggerSubjectKey: "manual",
  status: "WAITING",
  phase: "WAITING",
  generation: 0,
  sessionData: {},
  sessionRevision: 1,
  blockedReason: null,
  error: null,
  queuedAt: "2026-07-24T12:00:00.000Z",
  startedAt: "2026-07-24T12:00:01.000Z",
  pausedAt: null,
  finishedAt: null,
  archivedAt: null,
  createdAt: "2026-07-24T12:00:00.000Z",
  attempts: [
    {
      id: "attempt-1",
      nodeId: "question-step",
      kind: "HUMAN_CHOICE",
      generation: 0,
      iterationKey: "",
      attempt: 1,
      status: "WAITING",
      phase: "WAITING",
      input: {},
      output: null,
      error: null,
      requiredPaths: [],
      providedPaths: [],
      resourceLockKey: null,
      idempotencyKey: null,
      startedAt: "2026-07-24T12:00:01.000Z",
      finishedAt: null,
      supersededAt: null,
      replayedFromId: null,
      createdAt: "2026-07-24T12:00:01.000Z",
      updatedAt: "2026-07-24T12:00:01.000Z",
      resourceLinks: [],
      questionBatches: [
        {
          id: "batch-1",
          status: "PENDING",
          questions,
        },
      ],
      checkpoints: [],
    },
  ],
  waits: [],
  events: [],
  resourceLinks: [],
} as unknown as WorkflowRun;

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverMock;
  subscriptions.mockReturnValue({
    subscribe: vi.fn(() => vi.fn()),
  } as unknown as ReturnType<typeof controlPlaneSubscriptions>);
  request.mockResolvedValue({ workflowRun: pendingRun });
});

afterEach(() => cleanup());

describe("workflow question answers", () => {
  test("preserves multiple selections and appends trimmed custom answers", () => {
    expect(
      workflowQuestionAnswerPayload(
        questions,
        { scope: ["Frontend", "Backend"], approval: ["Yes"] },
        { scope: "  Documentation  " },
      ),
    ).toEqual({
      scope: { answers: ["Frontend", "Backend", "Documentation"] },
      approval: { answers: ["Yes"] },
    });
  });

  test("renders semantic selection controls and submits the structured payload", async () => {
    render(
      <TooltipProvider>
        <WorkflowRunPage runId="run-1" />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: "Frontend" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Backend" }));
    fireEvent.click(screen.getByRole("radio", { name: "Yes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom answer" }), {
      target: { value: "Documentation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation AnswerWorkflowQuestion"),
        {
          batchId: "batch-1",
          answers: {
            scope: {
              answers: ["Frontend", "Backend", "Documentation"],
            },
            approval: { answers: ["Yes"] },
          },
        },
      ),
    );
  });

  test("tints the header with the linked worktree colour", async () => {
    request.mockResolvedValue({
      workflowRun: {
        ...pendingRun,
        worktree: {
          id: "worktree-1",
          folder: "/tmp/feature",
          branch: "feature",
          highlightColor: "violet",
        },
      },
    });
    render(
      <TooltipProvider>
        <WorkflowRunPage runId="run-1" />
      </TooltipProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "Release #7" });
    const header = heading.closest("div.rounded-lg");
    expect(header?.className).toContain("bg-violet-500/10");
    expect(header?.className).toContain("border-l-violet-500");
  });

  test("shows the worktree queue at the top while the run is queued", async () => {
    request.mockResolvedValue({
      workflowRun: {
        ...pendingRun,
        status: "QUEUED",
        phase: "WAITING_FOR_WORKTREE",
        attempts: [],
        worktree: {
          id: "worktree-1",
          folder: "/tmp/feature",
          branch: "feature/APP-42",
          highlightColor: null,
        },
        queue: [
          {
            position: 1,
            id: "session-2",
            kind: "SESSION",
            displayNumber: 2,
            name: "Earlier work",
            status: "QUEUED",
            phase: "WAITING_FOR_WORKTREE",
            worktreeId: "worktree-1",
            worktree: {
              id: "worktree-1",
              folder: "/tmp/feature",
              branch: "feature/APP-42",
              highlightColor: null,
            },
            workflowId: null,
            workflowRunId: null,
            queuedAt: "2026-07-24T11:59:00.000Z",
            exclusiveWorktree: false,
            worktreeConcurrencyLimit: 1,
          },
          {
            position: 2,
            id: "run-1",
            kind: "WORKFLOW",
            displayNumber: 7,
            name: "Release",
            status: "QUEUED",
            phase: "WAITING_FOR_WORKTREE",
            worktreeId: "worktree-1",
            worktree: {
              id: "worktree-1",
              folder: "/tmp/feature",
              branch: "feature/APP-42",
              highlightColor: null,
            },
            workflowId: "workflow-1",
            workflowRunId: "run-1",
            queuedAt: "2026-07-24T12:00:00.000Z",
            exclusiveWorktree: true,
            worktreeConcurrencyLimit: null,
          },
        ],
      },
    });
    render(
      <TooltipProvider>
        <WorkflowRunPage runId="run-1" />
      </TooltipProvider>,
    );

    const currentLink = await screen.findByRole("link", {
      name: "Workflow #7",
    });
    const queueCard = currentLink.closest<HTMLElement>('[data-slot="card"]');
    expect(queueCard).not.toBeNull();
    expect(queueCard?.textContent).toContain("#2");
    expect(queueCard?.textContent).toContain("Current run");
    expect(queueCard?.textContent).toContain("Session #2");
    const graph = screen.getByText("Workflow graph");
    expect(
      queueCard!.compareDocumentPosition(graph) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("shows the linked worktree branch instead of its resource ID", async () => {
    request.mockResolvedValue({
      workflowRun: {
        ...pendingRun,
        triggerKind: "RESOURCE_MANUAL_CHOICE",
        triggerSubjectKey: "WORKTREE:worktree-1",
        worktree: {
          id: "worktree-1",
          folder: "/tmp/feature",
          branch: "feature/APP-42",
          highlightColor: null,
        },
      },
    });
    render(
      <TooltipProvider>
        <WorkflowRunPage runId="run-1" />
      </TooltipProvider>,
    );

    expect(await screen.findByText(/feature\/APP-42$/)).not.toBeNull();
    expect(screen.queryByText(/WORKTREE:worktree-1/)).toBeNull();
  });

  test("leaves the header untinted when no worktree is linked", async () => {
    render(
      <TooltipProvider>
        <WorkflowRunPage runId="run-1" />
      </TooltipProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "Release #7" });
    expect(heading.closest("div.rounded-lg")).toBeNull();
  });

  test("navigates locked links and only selects unlocked action nodes for replay", async () => {
    request.mockResolvedValue({
      workflowRun: { ...pendingRun, status: "SUCCEEDED" },
    });
    render(
      <TooltipProvider>
        <WorkflowRunPage runId="run-1" />
      </TooltipProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Locked linked step" }),
    );
    expect(routerPush).toHaveBeenCalledWith("/sessions/session-1");

    const prepare = screen.getByRole("button", { name: "Prepare replay" });
    fireEvent.click(screen.getByRole("button", { name: "Unlocked trigger" }));
    expect(prepare.getAttribute("disabled")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Unlocked action step" }),
    );
    expect(prepare.getAttribute("disabled")).toBeNull();
  });
});
