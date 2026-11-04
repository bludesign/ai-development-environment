import { describe, expect, test } from "vitest";

import {
  mergeWorkflowDiagnostics,
  normalizeWorkflowDiagnostics,
  workflowDiagnosticTarget,
  workflowRenderableDefinition,
  workflowSemanticKey,
} from "./workflow-diagnostics";
import { emptyDefinition, type WorkflowDefinition } from "./types";

function definition(): WorkflowDefinition {
  const result = emptyDefinition("Checks");
  result.nodes = ["build", "tests"].map((id) => ({
    id,
    kind: "CUSTOM_COMMAND",
    name: id === "build" ? "Build" : "Run tests",
    position: { x: 250, y: 150 },
    config: {},
    requiredPaths: [],
    providedPaths: [],
    retry: { maxAttempts: 1, strategy: "FIXED", delaySeconds: 1 },
    failurePolicy: "FAIL",
  }));
  result.edges = [
    {
      id: "build-tests",
      source: "build",
      target: "tests",
      sourceHandle: "success",
      targetHandle: "input",
    },
  ];
  return result;
}

const issue = {
  severity: "ERROR" as const,
  code: "TEST_ERROR",
  message: "Needs repair",
};

describe("workflow diagnostic snapshots", () => {
  test("ignores presentation changes while retaining semantic changes and edge order", () => {
    const original = definition();
    const moved = structuredClone(original);
    moved.nodes[0]!.position = { x: 2000, y: 50 };
    moved.triggers[0]!.position = { x: 30, y: 500 };
    moved.editor = {
      handleLayout: "TOP_BOTTOM",
      viewport: { x: 1, y: 2, zoom: 2 },
    };
    expect(workflowSemanticKey(moved)).toBe(workflowSemanticKey(original));
    moved.nodes[0]!.name = "Compile";
    expect(workflowSemanticKey(moved)).not.toBe(workflowSemanticKey(original));

    const second = { ...original.edges[0]!, id: "second" };
    original.edges.push(second);
    const reversed = { ...original, edges: original.edges.toReversed() };
    expect(workflowSemanticKey(reversed)).not.toBe(
      workflowSemanticKey(original),
    );
  });

  test("treats differently ordered config properties as the same semantic snapshot", () => {
    const first = definition();
    first.nodes[0]!.config = {
      command: "make",
      args: ["test"],
      nested: { a: 1, b: 2 },
    };
    const second = structuredClone(first);
    second.nodes[0]!.config = {
      nested: { b: 2, a: 1 },
      args: ["test"],
      command: "make",
    };
    expect(workflowSemanticKey(first)).toBe(workflowSemanticKey(second));
  });

  test("normalizes local and server targets and deduplicates only identical diagnostics", () => {
    expect(normalizeWorkflowDiagnostics([issue])[0]).toEqual({
      ...issue,
      nodeId: null,
      triggerId: null,
      edgeId: null,
      path: null,
    });
    const local = { ...issue, edgeId: "build-tests" };
    expect(
      mergeWorkflowDiagnostics([local], normalizeWorkflowDiagnostics([local]), [
        { ...local, path: "edges.0" },
        { ...local, severity: "WARNING" },
      ]),
    ).toHaveLength(3);
  });
});

describe("workflow diagnostic navigation", () => {
  test("resolves a named connection and both endpoints", () => {
    const target = workflowDiagnosticTarget(definition(), {
      ...issue,
      edgeId: "build-tests",
    });
    expect(target).toMatchObject({
      label: "Build (Success) → Run tests",
      nodeIds: ["build", "tests"],
      edgeId: "build-tests",
      inspectorId: null,
    });
  });

  test("uses the indexed connection for the label and focuses all duplicate-ID endpoints", () => {
    const value = definition();
    value.edges.push({ ...value.edges[0]!, source: "manual", target: "build" });
    const target = workflowDiagnosticTarget(value, {
      ...issue,
      edgeId: "build-tests",
      path: "edges.1.sourceHandle",
    });
    expect(target.label).toBe("Manual (Success) → Build");
    expect(target.edgeId).toBeNull();
    expect(target.nodeIds).toEqual(["build", "tests", "manual"]);
  });

  test("selects a uniquely identified broken edge while revealing its surviving endpoint", () => {
    const value = definition();
    value.edges[0]!.target = "deleted-step";
    expect(
      workflowDiagnosticTarget(value, { ...issue, path: "edges.0" }),
    ).toEqual({
      label: "Build (Success) → Missing node (deleted-step)",
      nodeIds: ["build"],
      edgeId: "build-tests",
      inspectorId: null,
    });
  });

  test("retains connection selection for an incoming trigger edge or two missing endpoints", () => {
    const value = definition();
    value.edges[0]!.target = "manual";
    expect(
      workflowDiagnosticTarget(value, { ...issue, edgeId: "build-tests" }),
    ).toMatchObject({ edgeId: "build-tests", nodeIds: ["build", "manual"] });

    value.edges[0]!.source = "missing-source";
    value.edges[0]!.target = "missing-target";
    expect(
      workflowDiagnosticTarget(value, { ...issue, edgeId: "build-tests" }),
    ).toMatchObject({ edgeId: "build-tests", nodeIds: [] });
  });

  test("prefers a failing step over the trigger that supplies its requirement", () => {
    expect(
      workflowDiagnosticTarget(definition(), {
        ...issue,
        nodeId: "tests",
        triggerId: "manual",
        path: "ticket.key",
      }),
    ).toEqual({
      label: "Run tests",
      nodeIds: ["tests"],
      edgeId: null,
      inspectorId: "tests",
    });
  });

  test("targets schema-invalid indexed cards and leaves global or deleted targets inert", () => {
    expect(
      workflowDiagnosticTarget(definition(), {
        ...issue,
        path: "nodes.1.name",
      }),
    ).toMatchObject({ inspectorId: "tests", nodeIds: ["tests"] });
    expect(workflowDiagnosticTarget(definition(), issue)).toEqual({
      label: "Workflow",
      nodeIds: [],
      edgeId: null,
      inspectorId: null,
    });
    expect(
      workflowDiagnosticTarget(definition(), { ...issue, nodeId: "gone" })
        .nodeIds,
    ).toEqual([]);
  });
});

describe("workflow import rendering guard", () => {
  test("accepts safely drawable content even when a name or ID fails schema validation", () => {
    const value = definition();
    value.name = "";
    value.nodes[0]!.id = "invalid id";
    expect(workflowRenderableDefinition(value)).toBe(true);
  });

  test("rejects malformed collections, unknown kinds, unsafe positions, and malformed config", () => {
    const value = definition();
    expect(workflowRenderableDefinition({ ...value, nodes: null })).toBe(false);
    expect(workflowRenderableDefinition({ ...value, editor: [] })).toBe(false);
    for (const patch of [
      { kind: "FUTURE_KIND" },
      { position: { x: Infinity, y: 0 } },
      { config: [] },
      { retry: null },
      { requiredPaths: 2 },
    ]) {
      expect(
        workflowRenderableDefinition({
          ...value,
          nodes: [{ ...value.nodes[0], ...patch }],
        }),
      ).toBe(false);
    }
    expect(
      workflowRenderableDefinition({
        ...value,
        edges: [{ ...value.edges[0], target: 4 }],
      }),
    ).toBe(false);
  });
});
