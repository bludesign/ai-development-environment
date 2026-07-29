import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { WorkflowDetailPage } from "./workflow-detail-page";
import { emptyDefinition, type WorkflowDisplayLayout } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: () => ({
    subscribe: () => () => undefined,
  }),
}));

vi.mock("@/i18n/navigation", async () => {
  const React = await import("react");
  return {
    Link: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
      React.createElement("a", { href: String(href), ...props }),
    useRouter: () => ({ push: vi.fn() }),
  };
});

vi.mock("./workflow-graph", async () => {
  const React = await import("react");
  return {
    workflowStatusVariant: () => "outline",
    WorkflowGraph: ({
      onNodeClick,
      selectedNodeId,
    }: {
      onNodeClick?: (nodeId: string) => void;
      selectedNodeId?: string | null;
    }) =>
      React.createElement(
        "button",
        {
          "aria-pressed": selectedNodeId === "notify",
          onClick: () => onNodeClick?.("notify"),
          type: "button",
        },
        "Select Notify reviewer",
      ),
  };
});

const request = vi.mocked(controlPlaneRequest);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("workflow detail read-only inspector", () => {
  test.each<WorkflowDisplayLayout>(["REGULAR", "BASIC"])(
    "opens complete read-only step details in the %s layout",
    async (displayLayout) => {
      const definition = emptyDefinition("Review workflow");
      definition.editor.displayLayout = displayLayout;
      definition.nodes.push({
        id: "notify",
        kind: "NOTIFICATION_SEND",
        name: "Notify reviewer",
        position: { x: 320, y: 120 },
        config: { message: "Ready for review" },
        requiredPaths: ["ticket.key"],
        providedPaths: ["notification.id"],
        retry: { maxAttempts: 3, strategy: "FIXED", delaySeconds: 10 },
        failurePolicy: "CONTINUE",
      });
      request.mockResolvedValue({
        workflow: {
          id: "workflow-1",
          name: definition.name,
          description: "Review a prepared change",
          draftDefinition: definition,
          activeVersionId: "version-1",
          activeVersion: {
            id: "version-1",
            workflowId: "workflow-1",
            version: 1,
            name: definition.name,
            description: definition.description,
            schemaVersion: 1,
            definition,
            contentHash: "abc123",
            publishedAt: "2026-07-26T00:00:00.000Z",
          },
          versions: [],
          enabled: true,
          overlapPolicy: "QUEUE",
          maxConcurrentRuns: 1,
          archivedAt: null,
          quickActionKind: "NONE",
          quickActionIconKey: "play",
          quickActionButtonVariant: "default",
          quickActionRepositories: [],
          hasPlainTrigger: true,
          triggerChoices: [],
          versionCount: 1,
          runCount: 0,
          createdAt: "2026-07-26T00:00:00.000Z",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
        workflowRuns: { items: [] },
        worktreeRunQueue: [
          {
            position: 2,
            id: "session-3",
            kind: "SESSION",
            displayNumber: 3,
            name: "Review workflow",
            status: "QUEUED",
            phase: "WAITING_FOR_WORKTREE",
            worktreeId: "worktree-1",
            worktree: {
              id: "worktree-1",
              folder: "/workspaces/review",
              branch: "feature/review",
              highlightColor: "blue",
            },
            workflowId: "workflow-1",
            workflowRunId: "workflow-run-1",
            queuedAt: "2026-07-26T00:01:00.000Z",
            exclusiveWorktree: false,
            worktreeConcurrencyLimit: 1,
          },
        ],
        workflowCatalog: {
          schemaVersion: 1,
          globalConcurrency: 1,
          steps: [
            {
              kind: "NOTIFICATION_SEND",
              category: "Notifications",
              label: "Send notification",
              description: "Sends a notification.",
              details: "Sends the configured message to its destinations.",
              execution: "SYNC",
              configSchema: {},
              capabilityFlags: [],
              requiredPaths: [],
              providedPaths: ["notification.id"],
              sourceHandles: ["success", "failure"],
              mutatesExternal: true,
              mutatesWorktree: false,
            },
          ],
          triggers: [],
        },
        codebaseOverview: { repositories: [] },
      } as never);

      render(
        <TooltipProvider>
          <WorkflowDetailPage workflowId="workflow-1" />
        </TooltipProvider>,
      );

      const queueCard = (
        await screen.findByRole("link", { name: "Session #3" })
      ).closest<HTMLElement>('[data-slot="card"]');
      expect(queueCard).not.toBeNull();
      expect(
        queueCard?.querySelector('a[href="/sessions/session-3"]')?.textContent,
      ).toBe("Session #3");
      expect(queueCard?.textContent).toContain("#2");
      expect(
        queueCard?.querySelector('a[href="/worktrees/worktree-1"]'),
      ).toBeTruthy();

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Select Notify reviewer",
        }),
      );

      expect(
        await screen.findByRole("heading", { name: "Notify reviewer" }),
      ).toBeTruthy();
      expect(screen.getByText("Ready for review")).toBeTruthy();
      expect(screen.getByText("ticket.key")).toBeTruthy();
      expect(screen.getByText("3")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button", { name: "Delete node" })).toBeNull();
    },
  );
});
