import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { WorkflowEditor } from "./workflow-editor";
import { emptyDefinition } from "./types";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

vi.mock("@/i18n/navigation", async () => {
  const React = await import("react");
  return {
    Link: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
      React.createElement("a", { href: String(href), ...props }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  };
});

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    addEdge: (edge: unknown, current: unknown[]) => [...current, edge],
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    ReactFlow: ({
      children,
      onEdgeClick,
      onEdgesChange,
    }: {
      children: React.ReactNode;
      onEdgeClick: (event: unknown, edge: { id: string }) => void;
      onEdgesChange: (changes: { id: string; type: "remove" }[]) => void;
    }) =>
      React.createElement(
        "div",
        null,
        React.createElement(
          "button",
          {
            onClick: () => onEdgeClick({}, { id: "trigger-to-session" }),
            type: "button",
          },
          "Select test edge",
        ),
        React.createElement(
          "button",
          {
            onClick: () =>
              onEdgesChange([{ id: "trigger-to-session", type: "remove" }]),
            type: "button",
          },
          "Remove test edge",
        ),
        children,
      ),
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      children,
    useEdgesState: (initial: unknown[]) => {
      const [items, setItems] = React.useState(initial);
      return [items, setItems, vi.fn()];
    },
    useNodesState: (initial: unknown[]) => {
      const [items, setItems] = React.useState(initial);
      return [items, setItems, vi.fn()];
    },
  };
});

vi.mock("./workflow-graph", () => ({
  workflowFlowElements: (definition: {
    nodes: unknown[];
    triggers: unknown[];
    edges: unknown[];
  }) => ({
    nodes: [...definition.triggers, ...definition.nodes],
    edges: definition.edges,
  }),
  workflowNodeTypes: {},
}));

const request = vi.mocked(controlPlaneRequest);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("workflow editor edge deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
  });

  test("offers a touch-friendly delete action that persists to the draft", async () => {
    const definition = emptyDefinition("Edge deletion");
    definition.nodes.push({
      id: "session",
      kind: "RUN_CREATE_SESSION",
      name: "Run AI session and wait",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    });
    definition.edges.push({
      id: "trigger-to-session",
      source: "manual",
      target: "session",
      sourceHandle: "success",
      targetHandle: "input",
    });
    const workflow = {
      id: "workflow-1",
      name: definition.name,
      description: definition.description,
      draftDefinition: definition,
      activeVersionId: null,
      enabled: false,
      overlapPolicy: "QUEUE",
      maxConcurrentRuns: 1,
      archivedAt: null,
      versionCount: 0,
      runCount: 0,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    };

    request.mockImplementation(async (query, variables) => {
      if (query.includes("workflowCatalog")) {
        return {
          workflowCatalog: {
            schemaVersion: 1,
            globalConcurrency: 1,
            steps: [],
            triggers: [],
          },
          workflow,
        } as never;
      }
      const input = (variables as { input: { definition: typeof definition } })
        .input;
      return {
        saveWorkflowDraft: {
          ...workflow,
          draftDefinition: input.definition,
        },
      } as never;
    });

    render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Select test edge" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("mutation SaveWorkflow"),
        expect.objectContaining({
          input: expect.objectContaining({
            definition: expect.objectContaining({ edges: [] }),
          }),
        }),
      ),
    );
  });
});
