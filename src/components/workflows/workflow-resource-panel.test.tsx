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

import { WorkflowResourcePanel } from "./workflow-resource-panel";

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

vi.mock("./workflow-labels", () => ({
  useWorkflowLabels: () => ({
    status: (status: string) => status,
    kind: (kind: string) => kind,
  }),
}));

vi.mock("./workflow-graph", () => ({
  WorkflowGraph: ({
    currentPageNodeIds,
  }: {
    currentPageNodeIds: Set<string>;
  }) => <div>Highlighted: {[...currentPageNodeIds].sort().join(",")}</div>,
  workflowStatusVariant: () => "outline",
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const linkedRun = {
  id: "workflow-run-1",
  displayNumber: 9,
  workflow: { id: "workflow-1", name: "Resource flow" },
  trigger: { nodeId: "resource-trigger" },
  status: "SUCCEEDED",
  generation: 0,
  version: {
    definition: { triggers: [], nodes: [], edges: [], editor: {} },
  },
  attempts: [
    {
      id: "attempt-1",
      nodeId: "load-ticket",
      generation: 0,
      iterationKey: "",
      attempt: 0,
      resourceLinks: [
        {
          id: "ticket-link",
          attemptId: "attempt-1",
          kind: "JIRA_TICKET",
          resourceId: "AIDE-1",
        },
      ],
    },
  ],
  resourceLinks: [
    {
      id: "trigger-link",
      attemptId: null,
      kind: "WORKTREE",
      resourceId: "worktree-1",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  subscriptions.mockReturnValue({
    subscribe: vi.fn(() => vi.fn()),
  } as unknown as ReturnType<typeof controlPlaneSubscriptions>);
  request.mockResolvedValue({
    workflowRunsForResource: [linkedRun],
    workflowsAcceptingResource: [],
  });
});

afterEach(() => cleanup());

describe("linked workflow resource highlighting", () => {
  test("highlights the attempt linked to the current detail page", async () => {
    render(
      <WorkflowResourcePanel
        resourceId="AIDE-1"
        resourceKind="JIRA_TICKET"
        sessionData={{}}
      />,
    );

    expect(await screen.findByText("Highlighted: load-ticket")).toBeTruthy();
  });

  test("highlights the selected trigger for a run-owned resource link", async () => {
    render(
      <WorkflowResourcePanel
        resourceId="worktree-1"
        resourceKind="WORKTREE"
        sessionData={{}}
      />,
    );

    expect(
      await screen.findByText("Highlighted: resource-trigger"),
    ).toBeTruthy();
  });
});

describe("answering a waiting workflow from a resource page", () => {
  const waitingRun = {
    ...linkedRun,
    status: "WAITING",
    attempts: [
      {
        ...linkedRun.attempts[0],
        kind: "HUMAN_CONFIRM",
        questionBatches: [
          {
            id: "batch-1",
            status: "PENDING",
            questions: [
              {
                id: "question-1",
                prompt: "Deploy to production?",
                multiSelect: false,
                allowCustom: false,
                options: [
                  { id: "confirm", label: "Confirm" },
                  { id: "cancel", label: "Cancel" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  test("submits the picked option without leaving the page", async () => {
    request.mockResolvedValue({
      workflowRunsForResource: [waitingRun],
      workflowsAcceptingResource: [],
    });

    render(
      <WorkflowResourcePanel
        resourceId="AIDE-1"
        resourceKind="JIRA_TICKET"
        sessionData={{}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("mutation AnswerWorkflowQuestion"),
        {
          batchId: "batch-1",
          answers: { "question-1": { answers: ["Confirm"] } },
        },
      ),
    );
  });

  test("sends people to the run page when a question needs typing", async () => {
    request.mockResolvedValue({
      workflowRunsForResource: [
        {
          ...waitingRun,
          attempts: [
            {
              ...waitingRun.attempts[0],
              kind: "HUMAN_CHOICE",
              questionBatches: [
                {
                  id: "batch-2",
                  status: "PENDING",
                  questions: [
                    {
                      id: "question-2",
                      prompt: "What should change?",
                      multiSelect: false,
                      allowCustom: true,
                      options: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      workflowsAcceptingResource: [],
    });

    render(
      <WorkflowResourcePanel
        resourceId="AIDE-1"
        resourceKind="JIRA_TICKET"
        sessionData={{}}
      />,
    );

    const link = await screen.findByRole("link", {
      name: "Answer on the run page",
    });
    expect(link.getAttribute("href")).toBe("/workflows/runs/workflow-run-1");
  });
});
