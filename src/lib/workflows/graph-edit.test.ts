import { describe, expect, test } from "vitest";

import {
  emptyWorkflowDefinition,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from "./definition";
import {
  addWorkflowStep,
  addWorkflowTrigger,
  connectWorkflowNodes,
  disconnectWorkflowNodes,
  layoutWorkflowDefinition,
  removeWorkflowGraphNode,
  updateWorkflowStep,
  updateWorkflowTrigger,
} from "./graph-edit";

/** A definition with the default manual trigger and nothing else. */
function base(): WorkflowDefinition {
  return emptyWorkflowDefinition("Test workflow");
}

/** Trigger → step → step, the shape most tests here start from. */
function chain() {
  const first = addWorkflowStep(base(), {
    kind: "JIRA_LOAD_TICKET",
    connectFrom: { from: "manual" },
  });
  const second = addWorkflowStep(first.definition, {
    kind: "JIRA_COMMENT",
    connectFrom: { from: first.nodeId },
  });
  return {
    definition: second.definition,
    firstId: first.nodeId,
    secondId: second.nodeId,
  };
}

describe("addWorkflowStep", () => {
  test("adds a step and wires it to its source on the success handle", () => {
    const { definition, nodeId } = addWorkflowStep(base(), {
      kind: "JIRA_LOAD_TICKET",
      connectFrom: { from: "manual" },
    });
    expect(definition.nodes).toHaveLength(1);
    expect(definition.edges).toEqual([
      expect.objectContaining({
        source: "manual",
        target: nodeId,
        sourceHandle: "success",
        targetHandle: "input",
      }),
    ]);
  });

  test("leaves the step unconnected when no source is given", () => {
    const { definition } = addWorkflowStep(base(), { kind: "CONTROL_DELAY" });
    expect(definition.edges).toHaveLength(0);
  });

  test("places each step clear of the ones already there", () => {
    const { definition } = chain();
    const positions = definition.nodes.map(({ position }) => position);
    expect(new Set(positions.map(({ x }) => x)).size).toBe(2);
    expect(positions[0]).not.toEqual(positions[1]);
  });

  test("mints ids that do not collide with existing ones", () => {
    const { definition, firstId, secondId } = chain();
    const ids = definition.nodes.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(firstId).not.toBe(secondId);
  });
});

describe("updateWorkflowStep", () => {
  test("patches config keys without dropping the others", () => {
    const { definition, firstId } = chain();
    const seeded = updateWorkflowStep(definition, {
      nodeId: firstId,
      config: { issueKey: "APP-1", force: true },
    });
    const patched = updateWorkflowStep(seeded, {
      nodeId: firstId,
      configPatch: { issueKey: "APP-2" },
    });
    expect(patched.nodes[0]!.config).toEqual({
      issueKey: "APP-2",
      force: true,
    });
  });

  test("a null in a patch deletes the key", () => {
    const { definition, firstId } = chain();
    const seeded = updateWorkflowStep(definition, {
      nodeId: firstId,
      config: { issueKey: "APP-1", force: true },
    });
    const patched = updateWorkflowStep(seeded, {
      nodeId: firstId,
      configPatch: { force: null },
    });
    expect(patched.nodes[0]!.config).toEqual({ issueKey: "APP-1" });
  });

  test("replacing config drops what was not restated", () => {
    const { definition, firstId } = chain();
    const seeded = updateWorkflowStep(definition, {
      nodeId: firstId,
      config: { issueKey: "APP-1", force: true },
    });
    const replaced = updateWorkflowStep(seeded, {
      nodeId: firstId,
      config: { issueKey: "APP-2" },
    });
    expect(replaced.nodes[0]!.config).toEqual({ issueKey: "APP-2" });
  });

  test("rejects an unknown step and a contradictory config edit", () => {
    const { definition, firstId } = chain();
    expect(() => updateWorkflowStep(definition, { nodeId: "nope" })).toThrow(
      /not in this workflow/,
    );
    expect(() =>
      updateWorkflowStep(definition, {
        nodeId: firstId,
        config: {},
        configPatch: {},
      }),
    ).toThrow(/not both/);
  });
});

describe("connectWorkflowNodes", () => {
  test("rejects a handle the source does not offer, naming the real ones", () => {
    const { definition, firstId, secondId } = chain();
    expect(() =>
      connectWorkflowNodes(definition, {
        source: firstId,
        target: secondId,
        sourceHandle: "true",
      }),
    ).toThrow(/offers success, failure/);
  });

  test("accepts the branch handles of a control step", () => {
    const gate = addWorkflowStep(base(), {
      kind: "CONTROL_IF",
      connectFrom: { from: "manual" },
    });
    const branch = addWorkflowStep(gate.definition, { kind: "CONTROL_DELAY" });
    const connected = connectWorkflowNodes(branch.definition, {
      source: gate.nodeId,
      target: branch.nodeId,
      sourceHandle: "false",
    });
    expect(connected.definition.edges).toContainEqual(
      expect.objectContaining({ sourceHandle: "false" }),
    );
  });

  test("refuses to point an edge at a trigger", () => {
    const { definition, firstId } = chain();
    expect(() =>
      connectWorkflowNodes(definition, { source: firstId, target: "manual" }),
    ).toThrow(/triggers cannot have incoming/);
  });

  test("connecting the same pair twice reuses the existing edge", () => {
    const { definition, firstId, secondId } = chain();
    const again = connectWorkflowNodes(definition, {
      source: firstId,
      target: secondId,
    });
    expect(again.definition.edges).toHaveLength(definition.edges.length);
  });
});

describe("removeWorkflowGraphNode", () => {
  test("drops the node and every edge touching it", () => {
    const { definition, firstId } = chain();
    const next = removeWorkflowGraphNode(definition, firstId);
    expect(next.nodes.map(({ id }) => id)).not.toContain(firstId);
    expect(
      next.edges.some(
        ({ source, target }) => source === firstId || target === firstId,
      ),
    ).toBe(false);
  });

  test("reconnect stitches the predecessor to the successor", () => {
    const { definition, firstId, secondId } = chain();
    const next = removeWorkflowGraphNode(definition, firstId, {
      reconnect: true,
    });
    expect(next.edges).toEqual([
      expect.objectContaining({ source: "manual", target: secondId }),
    ]);
  });
});

describe("disconnectWorkflowNodes", () => {
  test("removes by endpoint pair", () => {
    const { definition, firstId, secondId } = chain();
    const next = disconnectWorkflowNodes(definition, {
      source: firstId,
      target: secondId,
    });
    expect(next.removedEdgeIds).toHaveLength(1);
    expect(next.definition.edges).toHaveLength(1);
  });

  test("reports when nothing matches instead of silently succeeding", () => {
    const { definition } = chain();
    expect(() =>
      disconnectWorkflowNodes(definition, { edgeId: "edge-99" }),
    ).toThrow(/No matching connection/);
  });
});

describe("updateWorkflowTrigger", () => {
  test("a choice trigger's options become its handles", () => {
    const added = addWorkflowTrigger(base(), {
      kind: "MANUAL_CHOICE",
      config: {
        choices: [
          { key: "fix", label: "Fix" },
          { key: "review", label: "Review" },
        ],
      },
    });
    const step = addWorkflowStep(added.definition, {
      kind: "CONTROL_DELAY",
      connectFrom: { from: added.triggerId, sourceHandle: "review" },
    });
    expect(step.definition.edges).toContainEqual(
      expect.objectContaining({ sourceHandle: "review" }),
    );
  });

  test("dropping an option removes the edges that left it", () => {
    const added = addWorkflowTrigger(base(), {
      kind: "MANUAL_CHOICE",
      config: { choices: [{ key: "fix", label: "Fix" }] },
    });
    const wired = addWorkflowStep(added.definition, {
      kind: "CONTROL_DELAY",
      connectFrom: { from: added.triggerId, sourceHandle: "fix" },
    });
    const narrowed = updateWorkflowTrigger(wired.definition, {
      triggerId: added.triggerId,
      config: { choices: [{ key: "review", label: "Review" }] },
    });
    expect(narrowed.edges).toHaveLength(0);
  });

  test("a choice trigger with no options yet cannot be connected blind", () => {
    const added = addWorkflowTrigger(base(), { kind: "MANUAL_CHOICE" });
    const step = addWorkflowStep(added.definition, { kind: "CONTROL_DELAY" });
    expect(() =>
      connectWorkflowNodes(step.definition, {
        source: added.triggerId,
        target: step.nodeId,
      }),
    ).toThrow(/options set first/);
  });
});

describe("layoutWorkflowDefinition", () => {
  test("lays the graph out left to right by depth", () => {
    const { definition, firstId, secondId } = chain();
    const laid = layoutWorkflowDefinition(definition);
    const x = (id: string) =>
      [...laid.nodes, ...laid.triggers].find((item) => item.id === id)!.position
        .x;
    expect(x("manual")).toBeLessThan(x(firstId));
    expect(x(firstId)).toBeLessThan(x(secondId));
  });

  test("gives disconnected steps a column of their own", () => {
    const { definition } = chain();
    const orphan = addWorkflowStep(definition, { kind: "CONTROL_DELAY" });
    const laid = layoutWorkflowDefinition(orphan.definition);
    const positions = laid.nodes.map(({ position }) => position);
    expect(new Set(positions.map(({ x }) => x)).size).toBe(3);
  });

  test("leaves the graph valid and unchanged apart from positions", () => {
    const { definition } = chain();
    const laid = layoutWorkflowDefinition(definition);
    expect(laid.edges).toEqual(definition.edges);
    expect(laid.nodes.map(({ id, kind }) => ({ id, kind }))).toEqual(
      definition.nodes.map(({ id, kind }) => ({ id, kind })),
    );
  });
});

describe("edits compose into a publishable workflow", () => {
  /** A worktree-launched entry point, replacing the default manual trigger. */
  function worktreeTriggered() {
    const added = addWorkflowTrigger(
      removeWorkflowGraphNode(base(), "manual"),
      { kind: "RESOURCE_MANUAL", config: { resourceKind: "WORKTREE" } },
    );
    return added;
  }

  test("trigger, two steps, and a connection validate cleanly", () => {
    const entry = worktreeTriggered();
    const first = addWorkflowStep(entry.definition, {
      kind: "WORKTREE_INSPECT",
      connectFrom: { from: entry.triggerId },
    });
    const second = addWorkflowStep(first.definition, {
      kind: "NOTIFICATION_SEND",
      config: { title: "Done", body: "Inspection finished" },
      connectFrom: { from: first.nodeId },
    });
    const { diagnostics } = validateWorkflowDefinition(
      layoutWorkflowDefinition(second.definition),
    );
    expect(diagnostics.filter(({ severity }) => severity === "ERROR")).toEqual(
      [],
    );
  });

  test("a step whose requirement the trigger cannot seed is reported", () => {
    // The mistake an author makes first: a manual trigger seeds only
    // `workflow.*`, so a worktree step hung off it can never resolve.
    const { definition } = addWorkflowStep(base(), {
      kind: "WORKTREE_INSPECT",
      connectFrom: { from: "manual" },
    });
    const { diagnostics } = validateWorkflowDefinition(definition);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        code: "REQUIREMENT_UNSATISFIED",
        path: "worktree.id",
      }),
    );
  });
});
