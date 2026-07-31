import { describe, expect, test } from "vitest";

import {
  workflowBasicHorizontalWheelDelta,
  workflowConstrainViewportAxis,
  workflowFlowElements,
} from "./workflow-graph";
import { emptyDefinition, type WorkflowAttempt } from "./types";

describe("workflow run graph projection", () => {
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
