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
}));

vi.mock("./workflow-graph", () => ({
  WorkflowGraph: () => <div>Workflow graph</div>,
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
});
