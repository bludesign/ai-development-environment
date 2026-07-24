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
});
