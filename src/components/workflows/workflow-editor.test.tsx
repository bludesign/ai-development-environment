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
  nodes: [] as { id: string; name?: string; data: { provides: string[] } }[],
  selectedId: null as string | null,
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
    useStoreApi: () => ({ getState: () => ({}), setState: vi.fn() }),
    ReactFlow: ({
      children,
      nodes,
      onEdgeClick,
      onEdgesChange,
      onInit,
      onNodeClick,
    }: {
      children: React.ReactNode;
      nodes: { id: string; name?: string; data: { provides: string[] } }[];
      onEdgeClick: (event: unknown, edge: { id: string }) => void;
      onEdgesChange: (changes: { id: string; type: "remove" }[]) => void;
      onInit: (instance: { getNodes: () => unknown[] }) => void;
      onNodeClick: (
        event: React.MouseEvent<HTMLButtonElement>,
        node: { id: string },
      ) => void;
    }) => {
      canvas.nodes = nodes;
      const initialized = React.useRef(false);
      React.useEffect(() => {
        if (initialized.current) return;
        initialized.current = true;
        onInit({
          getNodes: () =>
            canvas.nodes.map((node) => ({
              ...node,
              selected: node.id === canvas.selectedId,
            })),
        });
      }, [onInit]);
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
        ...nodes.map((node) =>
          React.createElement(
            "button",
            {
              key: node.id,
              onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                canvas.selectedId = node.id;
                onNodeClick(event, node);
              },
              type: "button",
            },
            `Select canvas node ${node.name ?? node.id}`,
          ),
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

vi.mock("./workflow-graph", async () => {
  const React = await import("react");
  return {
    MINIMAP_NODE_RADIUS: 12,
    WorkflowNodeActionsContext: React.createContext(null),
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
  };
});

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
    canvas.selectedId = null;
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
    canvas.selectedId = null;
  });

  test("hides session data chips by default and toggles them on demand", async () => {
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
    await waitFor(() => expect(provided()).toEqual([]));

    fireEvent.click(screen.getByRole("button", { name: "Show session data" }));
    expect(provided()).toContain("session.custom.value");

    fireEvent.click(screen.getByRole("button", { name: "Hide session data" }));
    expect(provided()).toEqual([]);
  });
});

describe("workflow editor node duplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
    canvas.nodes = [];
    canvas.selectedId = null;
  });

  test("duplicates the visibly selected canvas node with the keyboard shortcut", async () => {
    const definition = emptyDefinition("Node duplication");
    definition.nodes.push(
      {
        id: "first",
        kind: "NOTIFICATION_SEND",
        name: "First",
        position: { x: 200, y: 100 },
        config: {},
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
      {
        id: "second",
        kind: "NOTIFICATION_SEND",
        name: "Second",
        position: { x: 400, y: 100 },
        config: {},
        requiredPaths: [],
        providedPaths: [],
        retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
        failurePolicy: "FAIL",
      },
    );
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

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Select canvas node Second",
      }),
    );
    fireEvent.keyDown(document.body, { key: "d", metaKey: true });

    await waitFor(() =>
      expect(canvas.nodes.map(({ name }) => name)).toEqual(
        expect.arrayContaining(["First", "Second", "Second copy"]),
      ),
    );
    expect(canvas.nodes.some(({ name }) => name === "First copy")).toBe(false);
  });
});
