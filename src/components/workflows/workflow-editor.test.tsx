import {
  act,
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
import { emptyDefinition, type WorkflowDiagnostic } from "./types";

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: () => undefined,
});

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
}));

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("@/i18n/navigation", async () => {
  const React = await import("react");
  return {
    Link: ({ href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
      React.createElement("a", { href: String(href), ...props }),
    useRouter: () => navigation,
  };
});

const canvas = vi.hoisted(() => ({
  nodes: [] as { id: string; name?: string; data: { provides: string[] } }[],
  edges: [] as { id: string; selected?: boolean }[],
  diagnostics: [] as WorkflowDiagnostic[],
  fitView: vi.fn().mockResolvedValue(true),
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
    useReactFlow: () => ({ fitView: canvas.fitView }),
    useStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        nodesInitialized: true,
        width: 1000,
        height: 700,
        nodesDraggable: true,
        nodesConnectable: true,
        elementsSelectable: true,
      }),
    useStoreApi: () => ({ getState: () => ({}), setState: vi.fn() }),
    ReactFlow: ({
      children,
      nodes,
      edges,
      onEdgeClick,
      onEdgesChange,
      onInit,
      onNodeClick,
    }: {
      children: React.ReactNode;
      nodes: { id: string; name?: string; data: { provides: string[] } }[];
      edges: { id: string; selected?: boolean }[];
      onEdgeClick: (event: unknown, edge: { id: string }) => void;
      onEdgesChange: (changes: { id: string; type: "remove" }[]) => void;
      onInit: (instance: { getNodes: () => unknown[] }) => void;
      onNodeClick: (
        event: React.MouseEvent<HTMLButtonElement>,
        node: { id: string },
      ) => void;
    }) => {
      canvas.nodes = nodes;
      canvas.edges = edges;
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
    WorkflowGraph: ({
      definition,
      onNodeClick,
    }: {
      definition: { nodes: { id: string; name?: string }[] };
      onNodeClick?: (nodeId: string) => void;
    }) =>
      React.createElement(
        "button",
        {
          onClick: () => onNodeClick?.(definition.nodes[0]?.id ?? "manual"),
          type: "button",
        },
        "Basic preview graph",
      ),
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
    applyWorkflowDiagnostics: (
      _definition: unknown,
      nodes: unknown[],
      edges: unknown[],
      diagnostics: WorkflowDiagnostic[],
    ) => {
      canvas.diagnostics = diagnostics;
      return { nodes, edges };
    },
    workflowNodeTypes: {},
  };
});

const request = vi.mocked(controlPlaneRequest);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("workflow editor completion notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
  });

  test("enables successful completion notifications by default and saves an opt-out", async () => {
    const definition = emptyDefinition("Notification settings");
    const workflow = {
      id: "workflow-1",
      name: definition.name,
      description: definition.description,
      draftDefinition: definition,
      activeVersionId: null,
      enabled: false,
      overlapPolicy: "QUEUE",
      overlapScope: "WORKTREE",
      maxConcurrentRuns: 1,
      completionNotificationsEnabled: true,
      exclusiveWorktree: false,
      worktreeConcurrency: "NON_EXCLUSIVE",
      blocksGitOperations: false,
      archivedAt: null,
      versionCount: 0,
      runCount: 0,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    request.mockImplementation(async (query, variables) => {
      if (
        query.includes("workflowCatalog") ||
        query.includes("query WorkflowEditorDefinition")
      )
        return {
          workflowCatalog: {
            schemaVersion: 1,
            globalConcurrency: 1,
            steps: [],
            triggers: [],
          },
          workflow,
        } as never;
      const input = (variables as { input: { definition: typeof definition } })
        .input;
      return {
        saveWorkflowDraft: { ...workflow, draftDefinition: input.definition },
      } as never;
    });

    render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const checkbox = screen.getByRole("checkbox", {
      name: "Notify when this workflow completes successfully",
    });
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    fireEvent.click(checkbox);
    const gitBlocking = screen.getByRole("checkbox", {
      name: "Block Git operations during command and terminal steps",
    });
    expect(gitBlocking.getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(
      screen.getByRole("combobox", { name: "Worktree concurrency" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Exclusive" }));
    expect(gitBlocking.getAttribute("data-state")).toBe("checked");
    expect(gitBlocking.hasAttribute("disabled")).toBe(true);
    fireEvent.click(
      screen.getByRole("combobox", { name: "Worktree concurrency" }),
    );
    fireEvent.click(await screen.findByRole("option", { name: "Excluded" }));
    expect(gitBlocking.getAttribute("data-state")).toBe("unchecked");
    expect(gitBlocking.hasAttribute("disabled")).toBe(false);
    fireEvent.click(gitBlocking);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("mutation SaveWorkflow"),
        expect.objectContaining({
          input: expect.objectContaining({
            completionNotificationsEnabled: false,
            worktreeConcurrency: "EXCLUDED",
            blocksGitOperations: true,
          }),
        }),
      ),
    );
  });
});

describe("workflow editor overlap settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
  });

  test("explains the saved scope and hides the limit until runs may overlap", async () => {
    const definition = emptyDefinition("Overlap settings");
    const workflow = {
      id: "workflow-1",
      name: definition.name,
      description: definition.description,
      draftDefinition: definition,
      activeVersionId: null,
      enabled: false,
      overlapPolicy: "QUEUE",
      overlapScope: "GLOBAL",
      maxConcurrentRuns: 1,
      completionNotificationsEnabled: true,
      archivedAt: null,
      versionCount: 0,
      runCount: 0,
      createdAt: "2026-08-03T00:00:00.000Z",
      updatedAt: "2026-08-03T00:00:00.000Z",
    };
    request.mockImplementation(async (query, variables) => {
      if (
        query.includes("workflowCatalog") ||
        query.includes("query WorkflowEditorDefinition")
      )
        return {
          workflowCatalog: {
            schemaVersion: 1,
            globalConcurrency: 1,
            steps: [],
            triggers: [],
          },
          workflow,
        } as never;
      const input = (variables as { input: { definition: typeof definition } })
        .input;
      return {
        saveWorkflowDraft: { ...workflow, draftDefinition: input.definition },
      } as never;
    });

    render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(
      screen.getByText(
        "Counted across the whole workflow, so its runs wait for each other no matter which worktree they belong to.",
      ),
    ).toBeTruthy();
    // The limit only means anything once the policy lets runs overlap.
    expect(screen.queryByLabelText("Maximum concurrent runs")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("mutation SaveWorkflow"),
        expect.objectContaining({
          input: expect.objectContaining({ overlapScope: "GLOBAL" }),
        }),
      ),
    );
  });
});

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
      if (
        query.includes("workflowCatalog") ||
        query.includes("query WorkflowEditorDefinition")
      ) {
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

describe("workflow editor validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
    canvas.selectedId = null;
    canvas.diagnostics = [];
    canvas.edges = [];
  });

  type ValidationResult = { valid: boolean; diagnostics: WorkflowDiagnostic[] };

  function mockValidation(
    existing: boolean,
    failSave = false,
    validationResult: ValidationResult | Promise<ValidationResult> = {
      valid: true,
      diagnostics: [],
    },
  ) {
    const definition = emptyDefinition("Validation");
    definition.nodes.push({
      id: "session",
      kind: "CONTROL_DELAY",
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
      if (
        query.includes("workflowCatalog") ||
        query.includes("query WorkflowEditorDefinition")
      )
        return {
          workflowCatalog: {
            schemaVersion: 1,
            globalConcurrency: 1,
            steps: [],
            triggers: [],
          },
          workflow: existing ? workflow : null,
        } as never;
      if (query.includes("query ValidateWorkflow"))
        return {
          validateWorkflowDraft: await validationResult,
        } as never;
      if (failSave) throw new Error("Unable to save draft.");
      const input = (variables as { input: { definition: typeof definition } })
        .input;
      return {
        [existing ? "saveWorkflowDraft" : "createWorkflow"]: {
          ...workflow,
          draftDefinition: input.definition,
        },
      } as never;
    });
    return { definition, workflow };
  }

  async function renderEditor() {
    await act(async () => {
      render(
        <TooltipProvider>
          <WorkflowEditor workflowId="workflow-1" />
        </TooltipProvider>,
      );
    });
  }

  function orphanedChoice() {
    const fixture = mockValidation(true);
    fixture.definition.triggers[0] = {
      ...fixture.definition.triggers[0]!,
      name: "Release choices",
      kind: "MANUAL_CHOICE",
      config: { choices: [{ key: "ship", label: "Ship release" }] },
    };
    fixture.definition.nodes[0]!.name = "Wait for release";
    fixture.definition.edges[0]!.sourceHandle = "legacy";
    return fixture;
  }

  test("finds named connection errors after the edit debounce and clears deleted connections", async () => {
    orphanedChoice();
    vi.useFakeTimers();
    await renderEditor();

    await act(async () => vi.advanceTimersByTimeAsync(199));
    expect(canvas.diagnostics).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(canvas.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "TRIGGER_CHOICE_HANDLE_UNKNOWN",
        edgeId: "trigger-to-session",
        message: expect.stringContaining(
          'Release choices (Removed option "legacy") → Wait for release',
        ),
      }),
    );
    expect(
      screen.getByRole("button", {
        name: /leaves an option that no longer exists/,
      }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove test edge" }));
    expect(
      canvas.diagnostics.some(({ edgeId }) => edgeId === "trigger-to-session"),
    ).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(canvas.diagnostics.map(({ code }) => code)).toContain(
      "TRIGGER_DISCONNECTED",
    );
    expect(
      screen.queryByRole("button", {
        name: /leaves an option that no longer exists/,
      }),
    ).toBeNull();
    expect(
      request.mock.calls.some(([query]) =>
        /SaveWorkflow|ValidateWorkflow/.test(query),
      ),
    ).toBe(false);
  });

  test("repeatedly reveals a connection error and exposes its summary and delete action", async () => {
    orphanedChoice();
    await renderEditor();
    const diagnostic = await screen.findByRole("button", {
      name: /leaves an option that no longer exists/,
    });

    fireEvent.click(diagnostic);
    await waitFor(() => expect(canvas.fitView).toHaveBeenCalledTimes(1));
    expect(canvas.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({ nodes: [{ id: "manual" }, { id: "session" }] }),
    );
    expect(
      canvas.edges.find(({ id }) => id === "trigger-to-session")?.selected,
    ).toBe(true);
    expect(screen.getByText("Selected connection")).toBeTruthy();
    expect(
      screen.getAllByText(
        'Release choices (Removed option "legacy") → Wait for release',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: "Delete connection" }),
    ).toBeTruthy();

    fireEvent.click(diagnostic);
    await waitFor(() => expect(canvas.fitView).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    expect(canvas.edges).toEqual([]);
    expect(screen.queryByText("Selected connection")).toBeNull();
  });

  test("revealing an error exits Basic preview and unlocks a locked canvas", async () => {
    const { definition } = orphanedChoice();
    definition.editor.displayLayout = "BASIC";
    await renderEditor();
    const diagnostic = await screen.findByRole("button", {
      name: /leaves an option that no longer exists/,
    });
    fireEvent.click(screen.getByRole("button", { name: "Lock to fit" }));
    expect(screen.getByRole("button", { name: "Unlock view" })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Preview basic layout" }),
    );
    expect(
      screen.getByRole("button", { name: "Basic preview graph" }),
    ).toBeTruthy();
    canvas.fitView.mockClear();

    fireEvent.click(diagnostic);

    await waitFor(() =>
      expect(canvas.fitView).toHaveBeenCalledWith(
        expect.objectContaining({
          nodes: [{ id: "manual" }, { id: "session" }],
        }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Basic preview graph" }),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Preview basic layout" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByRole("button", { name: "Lock to fit" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete connection" }),
    ).toBeTruthy();
  });

  test("an invisible connection with both endpoints missing can be deleted from its diagnostic", async () => {
    const { definition } = mockValidation(true);
    definition.edges[0] = {
      ...definition.edges[0]!,
      source: "removed-trigger",
      target: "removed-step",
    };
    await renderEditor();
    const diagnostic = await screen.findByRole("button", {
      name: /references a missing endpoint/,
    });

    fireEvent.click(diagnostic);
    await act(async () => {});

    expect(canvas.fitView).not.toHaveBeenCalled();
    expect(screen.getByText("Selected connection")).toBeTruthy();
    expect(
      screen.getAllByText(
        "Missing node (removed-trigger) (Success) → Missing node (removed-step)",
      ).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Delete connection" }));
    expect(canvas.edges).toEqual([]);
    expect(
      screen.queryByRole("button", { name: /references a missing endpoint/ }),
    ).toBeNull();
  });

  test("direct canvas selection cancels a pending diagnostic focus", async () => {
    const { definition } = mockValidation(true);
    definition.nodes[0]!.name = "Wait for release";
    definition.edges = [];
    let finishFit!: (value: boolean) => void;
    canvas.fitView.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFit = resolve;
        }),
    );
    await renderEditor();
    const diagnostic = await screen.findByRole("button", {
      name: /Step is not reachable from a trigger/,
    });

    fireEvent.click(diagnostic);
    expect(canvas.fitView).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Select canvas node Manual" }),
    );
    await act(async () => finishFit(true));

    expect(canvas.selectedId).toBe("manual");
    expect(
      screen.queryByRole("heading", { name: "Wait for release" }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test.each(["validate", "publish"] as const)(
    "%s exposes structured blocking server errors and does not publish",
    async (action) => {
      const message = "The pinned sub-workflow version does not exist";
      const { definition } = mockValidation(true, false, {
        valid: false,
        diagnostics: [
          {
            severity: "ERROR",
            code: "SUBWORKFLOW_NOT_FOUND",
            message,
            nodeId: "session",
            triggerId: null,
            edgeId: null,
            path: null,
          },
        ],
      });
      definition.nodes[0]!.name = "Wait for release";
      await renderEditor();
      if (action === "validate") {
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        fireEvent.click(screen.getByRole("button", { name: "Validate" }));
      } else fireEvent.click(screen.getByRole("button", { name: "Publish" }));

      const diagnostic = await screen.findByRole("button", {
        name: new RegExp(message),
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        request.mock.calls.some(([query]) =>
          query.includes("mutation PublishWorkflow"),
        ),
      ).toBe(false);
      fireEvent.click(diagnostic);
      await waitFor(() =>
        expect(canvas.fitView).toHaveBeenCalledWith(
          expect.objectContaining({ nodes: [{ id: "session" }] }),
        ),
      );
      expect(
        await screen.findByRole("heading", { name: "Wait for release" }),
      ).toBeTruthy();
    },
  );

  test("a late save response preserves edits made while saving", async () => {
    const { workflow } = mockValidation(true);
    const original = request.getMockImplementation()!;
    let finishSave!: () => void;
    request.mockImplementation((query, variables, options) => {
      if (!query.includes("mutation SaveWorkflow"))
        return original(query, variables, options);
      const snapshot = (
        variables as { input: { definition: typeof workflow.draftDefinition } }
      ).input.definition;
      return new Promise((resolve) => {
        finishSave = () =>
          resolve({
            saveWorkflowDraft: { ...workflow, draftDefinition: snapshot },
          } as never);
      });
    });
    await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Edited while saving" },
    });
    await act(async () => finishSave());

    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
    ).toBe("Edited while saving");
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining("mutation SaveWorkflow"),
      expect.objectContaining({
        input: expect.objectContaining({
          definition: expect.objectContaining({ name: "Edited while saving" }),
        }),
      }),
    );
    await act(async () => finishSave());
  });

  test("creating a workflow preserves newer edits and updates its URL without remounting", async () => {
    const previousUrl = window.location.href;
    const previousState = window.history.state;
    try {
      window.history.replaceState(
        null,
        "",
        "/fr/dashboard/workflows/new?from=palette&view=diagram#canvas",
      );
      const { workflow } = mockValidation(false);
      const original = request.getMockImplementation()!;
      let finishCreate!: () => void;
      request.mockImplementation((query, variables, options) => {
        if (!query.includes("mutation CreateWorkflow"))
          return original(query, variables, options);
        const snapshot = (
          variables as {
            input: { definition: typeof workflow.draftDefinition };
          }
        ).input.definition;
        return new Promise((resolve) => {
          finishCreate = () =>
            resolve({
              createWorkflow: { ...workflow, draftDefinition: snapshot },
            } as never);
        });
      });
      await act(async () => {
        render(
          <TooltipProvider>
            <WorkflowEditor />
          </TooltipProvider>,
        );
      });
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Edited while creating" },
      });

      await act(async () => finishCreate());

      expect(
        (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement)
          .value,
      ).toBe("Edited while creating");
      expect(window.location.pathname).toBe(
        "/fr/dashboard/workflows/workflow-1/edit",
      );
      expect(window.location.search).toBe("?from=palette&view=diagram");
      expect(window.location.hash).toBe("#canvas");
      expect(navigation.replace).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(previousState, "", previousUrl);
    }
  });

  test("a completed publish retains newer edits and stays in the editor", async () => {
    mockValidation(true);
    const original = request.getMockImplementation()!;
    let finishPublish!: () => void;
    request.mockImplementation((query, variables, options) => {
      if (!query.includes("mutation PublishWorkflow"))
        return original(query, variables, options);
      return new Promise((resolve) => {
        finishPublish = () =>
          resolve({
            publishWorkflow: {
              id: "version-1",
              version: 1,
              contentHash: "published",
            },
          } as never);
      });
    });
    await renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(
        request.mock.calls.some(([query]) =>
          query.includes("mutation PublishWorkflow"),
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "New draft after publishing" },
    });

    await act(async () => finishPublish());

    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value,
    ).toBe("New draft after publishing");
    expect(
      screen.getByText(
        "The validated draft was published. Your newer edits are still in the editor.",
      ),
    ).toBeTruthy();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  test.each(["validate", "publish"] as const)(
    "%s ignores late validation after edits, even when the original name is restored",
    async (action) => {
      let finishValidation!: (result: ValidationResult) => void;
      mockValidation(
        true,
        false,
        new Promise((resolve) => {
          finishValidation = resolve;
        }),
      );
      await renderEditor();
      if (action === "validate") {
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        fireEvent.click(screen.getByRole("button", { name: "Validate" }));
      } else fireEvent.click(screen.getByRole("button", { name: "Publish" }));
      await waitFor(() =>
        expect(
          request.mock.calls.some(([query]) =>
            query.includes("query ValidateWorkflow"),
          ),
        ).toBe(true),
      );
      if (action === "publish")
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Changed while checking" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Validation" },
      });
      await act(async () =>
        finishValidation({
          valid: true,
          diagnostics: [
            {
              severity: "WARNING",
              code: "OLD_CHECK",
              message: "Stale validation warning",
              nodeId: "session",
              triggerId: null,
              edgeId: null,
              path: null,
            },
          ],
        }),
      );

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByText("Stale validation warning")).toBeNull();
      expect(screen.queryByText("Validation passed.")).toBeNull();
      expect(
        screen.getByText(
          "The workflow changed during validation. Review the current draft and validate or publish again.",
        ),
      ).toBeTruthy();
      expect(
        request.mock.calls.some(([query]) =>
          query.includes("mutation PublishWorkflow"),
        ),
      ).toBe(false);
    },
  );

  test.each([true, false])(
    "saves the current canvas before validating an existing=%s workflow",
    async (existing) => {
      mockValidation(existing);
      render(
        <TooltipProvider>
          <WorkflowEditor workflowId={existing ? "workflow-1" : null} />
        </TooltipProvider>,
      );
      await screen.findByRole("button", { name: "Settings" });
      if (existing)
        fireEvent.click(
          screen.getByRole("button", { name: "Remove test edge" }),
        );
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "Updated canvas" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));

      await screen.findByText("Validation passed.");
      const saveIndex = request.mock.calls.findIndex(([query]) =>
        query.includes(
          existing ? "mutation SaveWorkflow" : "mutation CreateWorkflow",
        ),
      );
      const validateIndex = request.mock.calls.findIndex(([query]) =>
        query.includes("query ValidateWorkflow"),
      );
      expect(saveIndex).toBeGreaterThan(-1);
      expect(validateIndex).toBeGreaterThan(saveIndex);
      expect(request.mock.calls[saveIndex]?.[1]).toMatchObject({
        input: { definition: { name: "Updated canvas", edges: [] } },
      });
      expect(request.mock.calls[validateIndex]?.[1]).toEqual({
        id: "workflow-1",
      });
    },
  );

  test("does not validate a stale saved draft when saving the canvas fails", async () => {
    mockValidation(true, true);
    render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));

    await screen.findByText("Unable to save draft.");
    expect(
      request.mock.calls.some(([query]) =>
        query.includes("query ValidateWorkflow"),
      ),
    ).toBe(false);
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

describe("workflow editor basic layout preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.ResizeObserver = ResizeObserverMock;
    canvas.nodes = [];
    canvas.selectedId = null;
  });

  test("saves the display choice while preserving authored positions and previews read-only", async () => {
    const definition = emptyDefinition("Basic preview");
    definition.nodes.push({
      id: "notify",
      kind: "NOTIFICATION_SEND",
      name: "Notify reviewer",
      position: { x: 444, y: 222 },
      config: { message: "Ready for review" },
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
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
      if (
        query.includes("workflowCatalog") ||
        query.includes("query WorkflowEditorDefinition")
      )
        return {
          workflowCatalog: {
            schemaVersion: 1,
            globalConcurrency: 1,
            steps: [],
            triggers: [],
          },
          workflow,
        } as never;
      const input = (variables as { input: { definition: typeof definition } })
        .input;
      return {
        saveWorkflowDraft: { ...workflow, draftDefinition: input.definition },
      } as never;
    });

    render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Viewer layout" }));
    fireEvent.click(await screen.findByRole("option", { name: "Basic" }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    fireEvent.click(
      await screen.findByRole("button", { name: "Preview basic layout" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Basic preview graph" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Notify reviewer" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Duplicate step" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(request).toHaveBeenLastCalledWith(
        expect.stringContaining("mutation SaveWorkflow"),
        expect.objectContaining({
          input: expect.objectContaining({
            definition: expect.objectContaining({
              editor: expect.objectContaining({ displayLayout: "BASIC" }),
              nodes: [
                expect.objectContaining({
                  id: "notify",
                  position: { x: 444, y: 222 },
                }),
              ],
            }),
          }),
        }),
      ),
    );
  });

  test("exits Basic preview when importing a regular definition", async () => {
    const definition = emptyDefinition("Basic preview import");
    definition.editor.displayLayout = "BASIC";
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
    const { container } = render(
      <TooltipProvider>
        <WorkflowEditor workflowId="workflow-1" />
      </TooltipProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Preview basic layout" }),
    );
    expect(
      screen.getByRole("button", { name: "Basic preview graph" }),
    ).toBeTruthy();

    const regular = emptyDefinition("Imported regular workflow");
    const file = new File([JSON.stringify(regular)], "regular.workflow.json", {
      type: "application/json",
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Basic preview graph" }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: "Select test edge" }),
    ).toBeTruthy();
  });
});
