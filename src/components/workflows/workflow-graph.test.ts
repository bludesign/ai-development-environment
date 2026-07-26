import { describe, expect, test } from "vitest";

import { workflowFlowElements } from "./workflow-graph";
import { emptyDefinition, type WorkflowAttempt } from "./types";

describe("workflow run graph projection", () => {
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
    expect(build?.data.attemptLabel).toContain("generation 2");
    expect(edges[0]?.source).toBe("manual");
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
