import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { ActionCenterPage } from "./action-center-page";
import { ActionCenterProvider } from "./action-center-provider";
import { MiniActionCenter } from "./mini-action-center";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneConnected: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
const subscriptions = vi.mocked(controlPlaneSubscriptions);

const question = {
  key: "PLAN:plan-1",
  resourceKind: "PLAN",
  reason: "QUESTION",
  resourceId: "plan-1",
  href: "/plans/plan-1",
  displayNumber: 4,
  label: "Choose the implementation approach.",
  summary: "aide · feature/AIDE-101",
  status: "IN_PROGRESS",
  phase: "WAITING_FOR_ANSWER",
  error: null,
  createdAt: "2026-07-26T10:00:00.000Z",
  updatedAt: "2026-07-26T12:00:00.000Z",
  worktree: {
    id: "worktree-1",
    folder: "feature-aide",
    branch: "feature/AIDE-101",
    highlightColor: "blue",
  },
  questionBatches: [
    {
      id: "batch-1",
      sourceKind: null,
      createdAt: "2026-07-26T12:00:00.000Z",
      questions: [
        {
          id: "question-1",
          position: 0,
          header: "Approach",
          prompt: "Which approach should be used?",
          multiSelect: false,
          allowCustom: true,
          options: [
            {
              id: "recommended",
              position: 0,
              label: "Recommended",
              description: "Use the shared provider.",
            },
            {
              id: "separate",
              position: 1,
              label: "Separate feeds",
              description: null,
            },
          ],
        },
      ],
    },
  ],
  buildRun: null,
  failureFingerprint: null,
};

const workflowQuestion = {
  ...question,
  key: "WORKFLOW:workflow-1",
  resourceKind: "WORKFLOW",
  resourceId: "workflow-1",
  href: "/workflows/runs/workflow-1",
  displayNumber: 8,
  label: "Deploy application",
  summary: "WORKTREE:worktree-1",
  questionBatches: [
    {
      ...question.questionBatches[0],
      id: "workflow-batch-1",
      sourceKind: "HUMAN_CONFIRM",
      questions: [
        {
          ...question.questionBatches[0].questions[0],
          id: "workflow-question-1",
          header: "Deployment",
          prompt: "Deploy now?",
          allowCustom: false,
          options: [
            { id: "confirm", position: 0, label: "Confirm", description: null },
            { id: "cancel", position: 1, label: "Cancel", description: null },
          ],
        },
      ],
    },
  ],
};

const failed = {
  ...question,
  key: "BUILD:build-failed",
  resourceKind: "BUILD",
  reason: "FAILED",
  resourceId: "build-failed",
  href: "/builds/build-failed",
  displayNumber: null,
  label: "Debug",
  summary: "aide · feature/AIDE-101",
  status: "FAILED",
  phase: null,
  error: "xcodebuild failed",
  questionBatches: [],
  worktree: null,
  failureFingerprint: "BUILD:build-failed:0:2026-07-26T12:00:00.000Z",
};

const active = {
  ...question,
  key: "SESSION:session-active",
  resourceKind: "SESSION",
  reason: "ACTIVE",
  resourceId: "session-active",
  href: "/sessions/session-active",
  displayNumber: 9,
  label: "Continue implementation.",
  status: "QUEUED",
  phase: "WAITING_FOR_WORKTREE",
  questionBatches: [],
};

const page = {
  items: [question, workflowQuestion, failed, active],
  nextCursor: null,
  totalCount: 4,
  needsAttentionCount: 3,
  activeCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  subscriptions.mockReturnValue({
    subscribe: vi.fn(() => vi.fn()),
  } as never);
  request.mockImplementation(async (query) => {
    const operation = String(query);
    if (operation.includes("query ActionCenter"))
      return { actionCenter: page } as never;
    if (operation.includes("AnswerActionCenterRunQuestion")) {
      return {
        answerRunQuestion: { id: "plan-1", status: "IN_PROGRESS" },
      } as never;
    }
    if (operation.includes("AnswerActionCenterWorkflowQuestion")) {
      return {
        answerWorkflowQuestion: { id: "workflow-1", status: "RUNNING" },
      } as never;
    }
    if (operation.includes("AcknowledgeActionCenterItem")) {
      return { acknowledgeActionCenterItem: true } as never;
    }
    throw new Error(`Unexpected operation: ${operation}`);
  });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <ActionCenterProvider>
      <ActionCenterPage />
    </ActionCenterProvider>,
  );
}

describe("ActionCenterPage", () => {
  test("renders prioritized items with resource and worktree links", async () => {
    renderPage();

    const planLink = await screen.findByRole("link", { name: "Plan #4" });
    expect(
      screen.getByRole("heading", { name: "Action Center" }),
    ).toBeDefined();
    expect(planLink.getAttribute("href")).toBe("/plans/plan-1");
    expect(
      screen
        .getAllByRole("link", { name: /feature-aide/ })[0]
        ?.getAttribute("href"),
    ).toBe("/worktrees/worktree-1");
    expect(screen.getByText("xcodebuild failed")).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Needs attention" }),
    ).toBeDefined();
    expect(
      document.querySelector('[data-slot="action-center-items"]')?.className,
    ).toContain("repeat(auto-fit,minmax(min(100%,32rem),1fr))");
    expect(
      document.querySelector('[data-slot="action-center-items"]')?.className,
    ).toContain("items-stretch");

    const activeCard = screen
      .getByRole("link", { name: "Session #9" })
      .closest('[data-slot="card"]');
    expect(activeCard).not.toBeNull();
    expect(
      within(activeCard as HTMLElement).getByText("Active").className,
    ).toContain("bg-emerald-500/10");
    expect(within(activeCard as HTMLElement).getByText("Queued")).toBeDefined();
    expect(
      within(activeCard as HTMLElement).getByText("Waiting for worktree"),
    ).toBeDefined();

    const workflowCard = screen
      .getByRole("link", { name: "Deploy application #8" })
      .closest('[data-slot="card"]');
    expect(workflowCard).not.toBeNull();
    const workflowWorktreeLinks = within(
      workflowCard as HTMLElement,
    ).getAllByRole("link", { name: /feature-aide/ });
    expect(workflowWorktreeLinks).toHaveLength(2);
    expect(workflowWorktreeLinks[0]?.textContent).toBe("feature-aide");
    expect(workflowWorktreeLinks[0]?.getAttribute("href")).toBe(
      "/worktrees/worktree-1",
    );
    expect(workflowWorktreeLinks[1]?.textContent).toContain("feature/AIDE-101");
    expect(
      within(workflowCard as HTMLElement).queryByText("WORKTREE:worktree-1"),
    ).toBeNull();
    expect(workflowCard?.className).toContain("border-l-4");

    const failedCard = screen
      .getByRole("link", { name: "Debug" })
      .closest('[data-slot="card"]');
    expect(failedCard).not.toBeNull();
    expect(failedCard?.className).not.toContain("border-l-4");
    expect(failedCard?.className).not.toContain("border-l-transparent");
  });

  test("answers plan and workflow questions with their existing mutations", async () => {
    renderPage();
    const planLink = await screen.findByRole("link", { name: "Plan #4" });
    const planCard = planLink.closest('[data-slot="card"]');
    expect(planCard).not.toBeNull();
    fireEvent.click(within(planCard as HTMLElement).getByText("Recommended"));
    fireEvent.click(
      within(planCard as HTMLElement).getByRole("button", {
        name: "Submit answer",
      }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("AnswerActionCenterRunQuestion"),
        {
          batchId: "batch-1",
          answers: { "question-1": { answers: ["Recommended"] } },
        },
      ),
    );

    const workflowLink = screen.getByRole("link", {
      name: "Deploy application #8",
    });
    const workflowCard = workflowLink.closest('[data-slot="card"]');
    fireEvent.click(within(workflowCard as HTMLElement).getByText("Confirm"));
    fireEvent.click(
      within(workflowCard as HTMLElement).getByRole("button", {
        name: "Submit answer",
      }),
    );
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("AnswerActionCenterWorkflowQuestion"),
        {
          batchId: "workflow-batch-1",
          answers: { "workflow-question-1": { answers: ["Confirm"] } },
        },
      ),
    );
  });

  test("acknowledges a failed item without deleting it", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Acknowledge" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining("AcknowledgeActionCenterItem"),
        {
          input: {
            resourceKind: "BUILD",
            resourceId: "build-failed",
            failureFingerprint: "BUILD:build-failed:0:2026-07-26T12:00:00.000Z",
          },
        },
      ),
    );
  });
});

describe("MiniActionCenter", () => {
  test("shows question previews and links without answer controls", async () => {
    render(
      <ActionCenterProvider>
        <MiniActionCenter />
      </ActionCenterProvider>,
    );

    expect(await screen.findByText("Approach")).toBeDefined();
    expect(screen.getByText("Queued · Waiting for worktree")).toBeDefined();
    expect(screen.queryByRole("radio", { name: "Recommended" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Action Center" }).getAttribute("href"),
    ).toBe("/");
    const compactItem = document.querySelector(
      '[data-slot="action-center-compact-item"]',
    );
    expect(compactItem?.className).toContain("overflow-hidden");
    expect(compactItem?.className).toContain("space-y-1.5");
    expect(compactItem?.className).toContain("py-1.5");
    const worktreeLink = compactItem?.querySelector(
      'a[href="/worktrees/worktree-1"]',
    );
    expect(worktreeLink?.className).toContain("overflow-hidden");
    expect(worktreeLink?.textContent).toBe("feature-aide");
    expect(worktreeLink?.querySelectorAll("span")).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: "Acknowledge Debug" })
        .getAttribute("data-size"),
    ).toBe("icon-xs");
  });

  test("shows initial query errors instead of the empty state", async () => {
    request.mockRejectedValueOnce(new Error("Action Center is unavailable"));

    render(
      <ActionCenterProvider>
        <MiniActionCenter />
      </ActionCenterProvider>,
    );

    expect(
      await screen.findByText("Action Center is unavailable"),
    ).toBeDefined();
    expect(screen.queryByText("Nothing needs action.")).toBeNull();
  });

  test("shows compact action failures", async () => {
    render(
      <ActionCenterProvider>
        <MiniActionCenter />
      </ActionCenterProvider>,
    );
    const acknowledge = await screen.findByRole("button", {
      name: "Acknowledge Debug",
    });
    request.mockRejectedValueOnce(new Error("Acknowledge failed"));

    fireEvent.click(acknowledge);

    expect(await screen.findByText("Acknowledge failed")).toBeDefined();
  });
});
