import { describe, expect, test } from "vitest";

import {
  applyWorkflowDiagnostics,
  workflowBasicHorizontalWheelDelta,
  workflowConstrainViewportAxis,
  workflowFlowElements,
  workflowSourceHandles,
} from "./workflow-graph";
import {
  emptyDefinition,
  type WorkflowAttempt,
  type WorkflowDiagnostic,
} from "./types";

function diagnosticGraph() {
  const definition = emptyDefinition("Diagnostics");
  definition.triggers[0]!.name = "Start";
  definition.nodes.push({
    id: "notify",
    kind: "NOTIFICATION_SEND",
    name: "Notify team",
    position: { x: 200, y: 100 },
    config: {},
    requiredPaths: [],
    providedPaths: [],
    retry: { maxAttempts: 1, strategy: "FIXED", delaySeconds: 1 },
    failurePolicy: "FAIL",
  });
  definition.edges.push({
    id: "start-notify",
    source: "manual",
    target: "notify",
    sourceHandle: "success",
    targetHandle: "input",
  });
  return definition;
}

function connectionDiagnostic(
  patch: Partial<WorkflowDiagnostic> = {},
): WorkflowDiagnostic {
  return {
    severity: "ERROR",
    code: "EDGE_ENDPOINT_MISSING",
    message: "The connection has a problem",
    edgeId: "start-notify",
    nodeId: null,
    triggerId: null,
    path: "edges.0",
    ...patch,
  };
}

describe("workflow run graph projection", () => {
  test("renders the command match connector", () => {
    for (const kind of ["SAVED_COMMAND", "CUSTOM_COMMAND"]) {
      expect(workflowSourceHandles(kind).map(({ id }) => id)).toEqual([
        "success",
        "failure",
        "match",
      ]);
    }
  });

  test("leaves vertical wheel gestures to the page in horizontal Basic mode", () => {
    expect(
      workflowBasicHorizontalWheelDelta(
        { deltaMode: 0, deltaX: 2, deltaY: 40, shiftKey: false },
        800,
      ),
    ).toBeNull();
    expect(
      workflowBasicHorizontalWheelDelta(
        { deltaMode: 0, deltaX: 30, deltaY: 2, shiftKey: false },
        800,
      ),
    ).toBe(30);
    expect(
      workflowBasicHorizontalWheelDelta(
        { deltaMode: 0, deltaX: 0, deltaY: 30, shiftKey: true },
        800,
      ),
    ).toBe(30);
  });

  test("clamps horizontal panning at both padded content edges", () => {
    expect(
      workflowConstrainViewportAxis(-1_000, 686, 0.8, [-24, 1_024]),
    ).toBeCloseTo(-133.2);
    expect(
      workflowConstrainViewportAxis(1_000, 686, 0.8, [-24, 1_024]),
    ).toBeCloseTo(19.2);
    expect(workflowConstrainViewportAxis(0, 800, 1, [-24, 624])).toBeCloseTo(
      100,
    );
  });

  test("shows the latest retry, iteration count, and replay generation", () => {
    const definition = emptyDefinition("Graph");
    definition.nodes.push({
      id: "build",
      kind: "BUILD_START",
      name: "Build",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 3, strategy: "FIXED", delaySeconds: 1 },
      failurePolicy: "FAIL",
    });
    definition.edges.push({
      id: "start-build",
      source: "manual",
      target: "build",
      sourceHandle: "success",
      targetHandle: "input",
    });
    const base = {
      id: "attempt",
      nodeId: "build",
      kind: "BUILD_START",
      generation: 2,
      iterationKey: "",
      attempt: 0,
      status: "FAILED",
      phase: "FAILED",
      input: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      supersededAt: null,
      resourceLinks: [],
    } satisfies WorkflowAttempt;
    const attempts: WorkflowAttempt[] = [
      base,
      { ...base, id: "retry", attempt: 1, status: "RUNNING" },
      { ...base, id: "iteration", iterationKey: "item-0", status: "SUCCEEDED" },
    ];
    const { nodes, edges } = workflowFlowElements(definition, {
      attempts,
      generation: 2,
    });
    const build = nodes.find(({ id }) => id === "build");
    expect(build?.data.status).toBe("RUNNING");
    expect(build?.data.attemptLabel).toContain("1 retry");
    expect(build?.data.attemptLabel).toContain("1 iterations");
    expect(build?.data.attemptLabel).toContain("Generation 2");
    expect(build?.data.reused).toBe(false);
    expect(edges[0]?.source).toBe("manual");
  });

  test("shows match branch executions instead of their pending base template", () => {
    const definition = emptyDefinition("Graph");
    definition.nodes.push({
      id: "matched-step",
      kind: "SAVED_COMMAND",
      name: "Matched step",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "FIXED", delaySeconds: 1 },
      failurePolicy: "FAIL",
    });
    const base = {
      id: "template",
      nodeId: "matched-step",
      kind: "SAVED_COMMAND",
      generation: 0,
      iterationKey: "",
      attempt: 0,
      status: "PENDING",
      phase: "PENDING",
      input: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      supersededAt: null,
      resourceLinks: [],
    } satisfies WorkflowAttempt;
    const { nodes } = workflowFlowElements(definition, {
      attempts: [
        base,
        {
          ...base,
          id: "first-match",
          iterationKey: "match.command-attempt.1",
          status: "SUCCEEDED",
          phase: "SUCCEEDED",
        },
        {
          ...base,
          id: "second-match",
          iterationKey: "match.command-attempt.2",
          status: "WAITING",
          phase: "COMMAND",
        },
      ],
      generation: 0,
    });

    const matchedStep = nodes.find(({ id }) => id === "matched-step");
    expect(matchedStep?.data.status).toBe("WAITING");
    expect(matchedStep?.data.phase).toBe("COMMAND");
    expect(matchedStep?.data.attemptLabel).toContain("2 iterations");

    const afterSourceExit = workflowFlowElements(definition, {
      attempts: [
        {
          ...base,
          status: "SKIPPED",
          phase: "INACTIVE_BRANCH",
        },
        {
          ...base,
          id: "first-match",
          iterationKey: "match.command-attempt.1",
          status: "SUCCEEDED",
          phase: "SUCCEEDED",
        },
      ],
      generation: 0,
    });
    expect(
      afterSourceExit.nodes.find(({ id }) => id === "matched-step")?.data
        .status,
    ).toBe("SUCCEEDED");
  });

  test("keeps a command source status ahead of synthetic match emissions", () => {
    const definition = emptyDefinition("Graph");
    definition.nodes.push({
      id: "command",
      kind: "SAVED_COMMAND",
      name: "Command",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "FIXED", delaySeconds: 1 },
      failurePolicy: "FAIL",
    });
    const base = {
      id: "command-attempt",
      nodeId: "command",
      kind: "SAVED_COMMAND",
      generation: 0,
      iterationKey: "",
      attempt: 0,
      status: "WAITING",
      phase: "COMMAND",
      input: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      supersededAt: null,
      resourceLinks: [],
    } satisfies WorkflowAttempt;
    const { nodes } = workflowFlowElements(definition, {
      attempts: [
        base,
        {
          ...base,
          id: "emission",
          iterationKey: "match.command-attempt.1",
          status: "SUCCEEDED",
          phase: "MATCH_EMITTED",
        },
      ],
      generation: 0,
    });

    expect(nodes.find(({ id }) => id === "command")?.data.status).toBe(
      "WAITING",
    );
  });

  test("marks steps a replay carried forward instead of re-running", () => {
    const definition = emptyDefinition("Graph");
    definition.nodes.push({
      id: "build",
      kind: "BUILD_START",
      name: "Build",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 3, strategy: "FIXED", delaySeconds: 1 },
      failurePolicy: "FAIL",
    });
    const carriedForward: WorkflowAttempt = {
      id: "carried",
      nodeId: "build",
      kind: "BUILD_START",
      generation: 1,
      iterationKey: "",
      attempt: 0,
      status: "SUCCEEDED",
      phase: "REUSED_FROM_PRIOR_GENERATION",
      input: null,
      output: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      supersededAt: null,
      resourceLinks: [],
    };
    const { nodes } = workflowFlowElements(definition, {
      attempts: [carriedForward],
      generation: 1,
    });
    const build = nodes.find(({ id }) => id === "build");
    expect(build?.data.reused).toBe(true);
    // The generation belongs to the replay, not to this step's result, so the
    // card says "reused" rather than claiming the step ran in generation 1.
    expect(build?.data.attemptLabel).toBeNull();
  });

  test("attaches node diagnostics for editor highlighting", () => {
    const definition = emptyDefinition("Graph");
    definition.nodes.push({
      id: "blocked",
      kind: "JIRA_TRANSITION",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    });
    const result = workflowFlowElements(definition, {
      diagnostics: [
        {
          severity: "ERROR",
          code: "REQUIREMENT_UNSATISFIED",
          message: "ticket.key is missing",
          nodeId: "blocked",
          triggerId: null,
          path: "ticket.key",
        },
      ],
    });
    expect(
      result.nodes.find(({ id }) => id === "blocked")?.data.diagnostics,
    ).toHaveLength(1);
  });

  test("highlights named connections while preserving live canvas state", () => {
    const definition = diagnosticGraph();
    definition.edges.push({ ...definition.edges[0]!, id: "unrelated" });
    const elements = workflowFlowElements(definition);
    elements.nodes[1] = {
      ...elements.nodes[1]!,
      position: { x: 500, y: 600 },
      selected: true,
      dragging: true,
      measured: { width: 240, height: 130 },
    };
    elements.edges[0] = {
      ...elements.edges[0]!,
      selected: true,
      animated: true,
      style: { stroke: "purple", opacity: 0.3, strokeDasharray: "4" },
      label: "Original label",
      data: { retained: true },
    };
    const highlighted = applyWorkflowDiagnostics(
      definition,
      elements.nodes,
      elements.edges,
      [connectionDiagnostic()],
    );

    expect(highlighted.nodes[1]).toMatchObject({
      position: { x: 500, y: 600 },
      selected: true,
      dragging: true,
      measured: { width: 240, height: 130 },
    });
    expect(highlighted.edges[0]).toMatchObject({
      selected: true,
      animated: true,
      style: {
        stroke: "var(--destructive)",
        opacity: 1,
        strokeWidth: 3,
        strokeDasharray: "4",
      },
      label: "⚠ Start (Success) → Notify team",
      ariaLabel: "Start (Success) → Notify team: The connection has a problem",
      data: { retained: true },
    });
    expect(highlighted.edges[1]).toBe(elements.edges[1]);
    expect(elements.edges[0].style?.stroke).toBe("purple");

    const cleared = applyWorkflowDiagnostics(
      definition,
      highlighted.nodes,
      highlighted.edges,
      [],
    );
    expect(cleared.edges[0]).toMatchObject({
      style: elements.edges[0].style,
      label: "Original label",
      data: { retained: true },
    });
    expect(cleared.edges[0]?.data).not.toHaveProperty(
      "workflowDiagnosticPresentation",
    );
    expect(cleared.edges[0]?.ariaLabel).toBeUndefined();
  });

  test("distinguishes warnings and gives errors precedence", () => {
    const definition = diagnosticGraph();
    const warning = connectionDiagnostic({ severity: "WARNING" });
    const warned = workflowFlowElements(definition, { diagnostics: [warning] });
    expect(warned.edges[0]?.style?.stroke).toBe("var(--color-amber-500)");
    const failed = applyWorkflowDiagnostics(
      definition,
      warned.nodes,
      warned.edges,
      [warning, connectionDiagnostic()],
    );
    expect(failed.edges[0]?.style?.stroke).toBe("var(--destructive)");
  });

  test("uses indexed paths to locate errors and marks all duplicated IDs", () => {
    const definition = diagnosticGraph();
    definition.edges.push({
      ...definition.edges[0]!,
      sourceHandle: "failure",
    });
    const indexed = workflowFlowElements(definition, {
      diagnostics: [connectionDiagnostic({ path: "edges.1.sourceHandle" })],
    });
    expect(indexed.edges[0]?.style?.stroke).toBeUndefined();
    expect(indexed.edges[1]?.style?.stroke).toBe("var(--destructive)");
    const duplicate = workflowFlowElements(definition, {
      diagnostics: [
        connectionDiagnostic({ code: "DUPLICATE_EDGE_ID", path: "edges.1" }),
      ],
    });
    expect(duplicate.edges.map(({ style }) => style?.stroke)).toEqual([
      "var(--destructive)",
      "var(--destructive)",
    ]);
  });

  test("highlights a dangling connection's surviving endpoint", () => {
    const definition = diagnosticGraph();
    definition.edges[0]!.target = "removed-step";
    const result = workflowFlowElements(definition, {
      diagnostics: [connectionDiagnostic()],
    });
    expect(result.nodes[0]?.data.diagnostics).toHaveLength(1);
    expect(result.nodes[1]?.data.diagnostics).toEqual([]);
  });

  test("renders removed choices as disabled handles without changing the draft", () => {
    const definition = diagnosticGraph();
    definition.triggers[0] = {
      ...definition.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: { choices: [{ key: "ready", label: "Ready for review" }] },
    };
    definition.edges[0]!.sourceHandle = "removed";
    const original = JSON.stringify(definition);
    const result = workflowFlowElements(definition);
    expect(result.nodes[0]?.data.handles).toEqual([
      { id: "ready", label: "Ready for review" },
      { id: "removed", label: "removed", invalid: true },
    ]);
    expect(JSON.stringify(definition)).toBe(original);

    definition.edges = [];
    const cleared = applyWorkflowDiagnostics(definition, result.nodes, [], []);
    expect(cleared.nodes[0]?.data.handles).toEqual([
      { id: "ready", label: "Ready for review" },
    ]);
  });

  test("gives a choice trigger one output per option, and steps the usual pair", () => {
    const definition = emptyDefinition("Choice graph");
    definition.triggers[0] = {
      ...definition.triggers[0]!,
      kind: "MANUAL_CHOICE",
      config: {
        choices: [
          { key: "draft", label: "Draft" },
          { key: "ready", label: "Ready for review" },
        ],
      },
    };
    definition.nodes.push({
      id: "notify",
      kind: "NOTIFICATION_SEND",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    });
    const { nodes } = workflowFlowElements(definition);

    expect(nodes.find(({ id }) => id === "manual")?.data.handles).toEqual([
      { id: "draft", label: "Draft" },
      { id: "ready", label: "Ready for review" },
    ]);
    expect(
      nodes.find(({ id }) => id === "notify")?.data.handles.map(({ id }) => id),
    ).toEqual(["success", "failure"]);
  });

  test("projects current-page and navigation state onto triggers and steps", () => {
    const definition = emptyDefinition("Linked graph");
    definition.nodes.push({
      id: "ticket",
      kind: "JIRA_LOAD_TICKET",
      position: { x: 200, y: 100 },
      config: {},
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
      failurePolicy: "FAIL",
    });
    const result = workflowFlowElements(definition, {
      currentPageNodeIds: new Set(["manual", "ticket"]),
      destinations: new Map([
        ["ticket", { href: "/jira/tickets/AIDE-1", external: false }],
      ]),
      navigationEnabled: true,
    });

    expect(
      result.nodes.find(({ id }) => id === "manual")?.data.currentPage,
    ).toBe(true);
    expect(result.nodes.find(({ id }) => id === "ticket")?.data).toEqual(
      expect.objectContaining({
        currentPage: true,
        destination: { href: "/jira/tickets/AIDE-1", external: false },
        navigationEnabled: true,
      }),
    );
  });

  test("supports responsive connector overrides and controlled selection", () => {
    const definition = emptyDefinition("Responsive graph");
    const result = workflowFlowElements(definition, {
      handleLayout: "TOP_BOTTOM",
      selectedNodeId: "manual",
    });

    expect(result.nodes[0]?.selected).toBe(true);
    expect(result.nodes[0]?.data.handleLayout).toBe("TOP_BOTTOM");
  });
});
