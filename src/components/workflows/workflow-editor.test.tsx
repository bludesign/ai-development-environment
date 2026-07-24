import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

const canvas = vi.hoisted(() => ({
  nodes: [] as { id: string; data: { provides: string[] } }[],
}));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    addEdge: (edge: unknown, current: unknown[]) => [...current, edge],
    Background: () => null,
    ControlButton: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement("button", { type: "button", ...props }, children),
    Controls: ({ children }: { children: React.ReactNode }) => children,
    MiniMap: () => null,
    useReactFlow: () => ({ fitView: vi.fn() }),
    useStore: () => 0,
    ReactFlow: ({
      children,
      nodes,
      onEdgeClick,
      onEdgesChange,
    }: {
      children: React.ReactNode;
      nodes: { id: string; data: { provides: string[] } }[];
      onEdgeClick: (event: unknown, edge: { id: string }) => void;
      onEdgesChange: (changes: { id: string; type: "remove" }[]) => void;
    }) => {
      canvas.nodes = nodes;
      return React.createElement(
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
      );
    },
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
  workflowFlowElements: (
    definition: {
      nodes: { id: string }[];
      triggers: { id: string }[];
      edges: unknown[];
    },
    options: { provides?: Map<string, string[]> } = {},
  ) => ({
    nodes: [...definition.triggers, ...definition.nodes].map((entry) => ({
      ...entry,
      data: { provides: options.provides?.get(entry.id) ?? [] },
    })),
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

afterEach(() => cleanup());

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

describe("workflow editor session data toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
    canvas.nodes = [];
  });

  test("drops the session data chips from the cards and puts them back", async () => {
    const definition = emptyDefinition("Session data");
    definition.nodes.push({
      id: "session",
      kind: "RUN_CREATE_SESSION",
      name: "Run AI session and wait",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: ["session.custom.value"],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    });

    request.mockResolvedValue({
      workflowCatalog: {
        schemaVersion: 1,
        globalConcurrency: 1,
        steps: [],
        triggers: [],
      },
      workflow: {
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
      },
    } as never);

    render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );

    const provided = () =>
      canvas.nodes.flatMap((node) => node.data.provides ?? []);
    await waitFor(() => expect(provided()).toContain("session.custom.value"));

    fireEvent.click(screen.getByRole("button", { name: "Hide session data" }));
    expect(provided()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Show session data" }));
    expect(provided()).toContain("session.custom.value");
  });
});
