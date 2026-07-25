import { describe, expect, test, vi } from "vitest";

import { emptyWorkflowDefinition } from "@/lib/workflows/definition";
import type { WorkflowsService } from "@/services/workflows";

import {
  BuiltInToolRegistry,
  type BuiltInToolDefinition,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { createWorkflowToolGroup } from "./workflows";

/**
 * A `WorkflowsService` double backed by one in-memory draft. The authoring tools
 * are all read-modify-write over `get` + `saveDraft`, so those two are enough to
 * exercise them end to end.
 */
function service(initial = emptyWorkflowDefinition("Test workflow")) {
  const state = { definition: initial };
  const saveDraft = vi.fn(
    async ({ definition }: { id: string; definition: unknown }) => {
      state.definition = definition as typeof initial;
      return null;
    },
  );
  const value = {
    get: vi.fn(async (id: string) =>
      id === "wf-1"
        ? {
            id: "wf-1",
            draftDefinitionJson: JSON.stringify(state.definition),
          }
        : null,
    ),
    saveDraft,
    validateDraft: vi.fn(),
    publish: vi.fn(),
    trigger: vi.fn(),
    run: vi.fn(),
  } as unknown as WorkflowsService;
  return { state, saveDraft, value };
}

function registry(double = service()) {
  return {
    ...double,
    registry: new BuiltInToolRegistry([
      createWorkflowToolGroup(() => double.value),
    ]),
  };
}

function allTools(group: BuiltInToolGroup): BuiltInToolDefinition[] {
  return [
    ...group.tools,
    ...group.children.flatMap((child) => allTools(child)),
  ];
}

/** Calls a tool and returns its structured content. */
async function call(
  instance: BuiltInToolRegistry,
  name: string,
  args: unknown = {},
) {
  const result = await instance.callByName(name, args);
  return result.structuredContent as Record<string, unknown>;
}

describe("workflow tool group", () => {
  test("groups tools by discovery, authoring, and runs", () => {
    const group = createWorkflowToolGroup(() => service().value);
    expect(group.tools).toEqual([]);
    expect(group.children.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "builtin:workflows:discovery", name: "Discovery" },
      { id: "builtin:workflows:authoring", name: "Authoring" },
      { id: "builtin:workflows:runs", name: "Runs" },
    ]);
    expect(group.children[0]!.tools.map(({ name }) => name)).toEqual([
      "list_workflow_step_kinds",
      "list_workflow_trigger_kinds",
      "describe_workflow_kind",
      "list_workflow_session_paths",
      "get_workflow_path_availability",
    ]);
    expect(group.children[1]!.tools.map(({ name }) => name)).toEqual([
      "list_workflows",
      "get_workflow",
      "create_workflow",
      "update_workflow_settings",
      "set_workflow_enabled",
      "archive_workflow",
      "delete_workflow",
      "add_workflow_step",
      "update_workflow_step",
      "add_workflow_trigger",
      "update_workflow_trigger",
      "remove_workflow_node",
      "connect_workflow_nodes",
      "disconnect_workflow_nodes",
      "layout_workflow",
      "set_workflow_definition",
      "validate_workflow",
      "publish_workflow",
      "export_workflow",
      "import_workflow",
    ]);
    expect(group.children[2]!.tools.map(({ name }) => name)).toEqual([
      "trigger_workflow",
      "list_workflow_runs",
      "get_workflow_run",
      "get_workflow_run_events",
      "control_workflow_run",
      "answer_workflow_question",
      "prepare_workflow_replay",
      "replay_workflow_run",
    ]);

    const names = allTools(group).map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    // The registry itself throws on a collision, so constructing it is the check.
    expect(() => new BuiltInToolRegistry([group])).not.toThrow();
  });

  test("every tool declares a title, description, and annotations", () => {
    for (const tool of allTools(
      createWorkflowToolGroup(() => service().value),
    )) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });

  test("destructive tools are annotated as such", () => {
    const byName = new Map(
      allTools(createWorkflowToolGroup(() => service().value)).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    for (const name of [
      "delete_workflow",
      "remove_workflow_node",
      "control_workflow_run",
      "replay_workflow_run",
    ]) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(true);
    }
    expect(byName.get("validate_workflow")?.annotations.readOnlyHint).toBe(
      true,
    );
  });

  test("routes catalog calls through the owning child group", async () => {
    const { registry: instance } = registry();
    await expect(
      instance.call(
        "builtin:workflows:discovery",
        "list_workflow_step_kinds",
        {},
      ),
    ).resolves.toMatchObject({
      structuredContent: { steps: expect.any(Array) },
    });
    await expect(
      instance.call("builtin:workflows", "list_workflow_step_kinds", {}),
    ).rejects.toThrow("Unknown built-in tool");
    await expect(
      instance.call("builtin:workflows:runs", "list_workflow_step_kinds", {}),
    ).rejects.toThrow("Unknown built-in tool");
  });
});

describe("discovery tools", () => {
  test("step kinds carry a description and can be searched", () => {
    const { registry: instance } = registry();
    return call(instance, "list_workflow_step_kinds", {
      search: "merge",
    }).then((result) => {
      const steps = result.steps as Array<Record<string, unknown>>;
      expect(steps.map(({ kind }) => kind)).toContain("GITHUB_MERGE_PR");
      expect(String(steps[0]!.description).length).toBeGreaterThan(20);
      // The long form is reserved for describe_workflow_kind.
      expect(steps[0]).not.toHaveProperty("details");
    });
  });

  test("describing a kind returns its config schema and handles", async () => {
    const { registry: instance } = registry();
    const result = await call(instance, "describe_workflow_kind", {
      kind: "CONTROL_IF",
    });
    expect(result.scope).toBe("step");
    expect(result.sourceHandles).toEqual(["true", "false"]);
    expect(String(result.details).length).toBeGreaterThan(
      String(result.description).length,
    );
    const schema = result.configSchema as Record<string, unknown>;
    expect(schema.required).toContain("condition");
  });

  test("describing a trigger reports its seed paths", async () => {
    const { registry: instance } = registry();
    const result = await call(instance, "describe_workflow_kind", {
      kind: "GITHUB_PR_STATE",
    });
    expect(result.scope).toBe("trigger");
    expect(result.seedPaths).toEqual(["repo.*", "pr.*"]);
  });

  test("an unknown kind is rejected rather than returned empty", async () => {
    const { registry: instance } = registry();
    await expect(
      call(instance, "describe_workflow_kind", { kind: "NOPE" }),
    ).rejects.toThrow(/Unknown trigger kind/);
  });
});

describe("authoring tools", () => {
  test("adding a step saves the draft and reports diagnostics", async () => {
    const { registry: instance, saveDraft } = registry();
    const result = await call(instance, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "NOTIFICATION_SEND",
      config: { title: "Hi", body: "There" },
      connectFrom: { from: "manual" },
    });
    expect(saveDraft).toHaveBeenCalledOnce();
    expect(result.nodeId).toBeTruthy();
    expect(result.edgeId).toBeTruthy();
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("edits accumulate across calls against the same draft", async () => {
    const double = registry();
    const first = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "NOTIFICATION_SEND",
      config: { title: "Hi", body: "There" },
      connectFrom: { from: "manual" },
    });
    await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "CONTROL_DELAY",
      config: { seconds: 30 },
      connectFrom: { from: first.nodeId },
    });
    expect(double.state.definition.nodes).toHaveLength(2);
    expect(double.state.definition.edges).toHaveLength(2);
  });

  test("a config patch merges rather than replacing", async () => {
    const double = registry();
    const added = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "NOTIFICATION_SEND",
      config: { title: "Hi", body: "There" },
      connectFrom: { from: "manual" },
    });
    await call(double.registry, "update_workflow_step", {
      workflowId: "wf-1",
      nodeId: added.nodeId,
      configPatch: { title: "Updated" },
    });
    expect(double.state.definition.nodes[0]!.config).toEqual({
      title: "Updated",
      body: "There",
    });
  });

  test("an incomplete workflow reports the errors that block publishing", async () => {
    const { registry: instance } = registry();
    // A step nobody connected is unreachable, and the trigger now leads nowhere.
    const result = await call(instance, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "CONTROL_DELAY",
      config: { seconds: 5 },
    });
    expect(result.valid).toBe(false);
    const codes = (result.diagnostics as Array<{ code: string }>).map(
      ({ code }) => code,
    );
    expect(codes).toContain("UNREACHABLE_STEP");
    expect(codes).toContain("TRIGGER_DISCONNECTED");
  });

  test("connecting to a handle a step does not have fails loudly", async () => {
    const double = registry();
    const first = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "NOTIFICATION_SEND",
      connectFrom: { from: "manual" },
    });
    const second = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "CONTROL_DELAY",
    });
    await expect(
      call(double.registry, "connect_workflow_nodes", {
        workflowId: "wf-1",
        source: first.nodeId,
        target: second.nodeId,
        sourceHandle: "body",
      }),
    ).rejects.toThrow(/offers success, failure/);
  });

  test("removing a step can keep the chain intact", async () => {
    const double = registry();
    const first = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "NOTIFICATION_SEND",
      connectFrom: { from: "manual" },
    });
    const second = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "CONTROL_DELAY",
      connectFrom: { from: first.nodeId },
    });
    await call(double.registry, "remove_workflow_node", {
      workflowId: "wf-1",
      id: first.nodeId,
      reconnect: true,
    });
    expect(double.state.definition.nodes).toHaveLength(1);
    expect(double.state.definition.edges).toEqual([
      expect.objectContaining({ source: "manual", target: second.nodeId }),
    ]);
  });

  test("layout spreads the graph into columns", async () => {
    const double = registry();
    const first = await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "NOTIFICATION_SEND",
      connectFrom: { from: "manual" },
      position: { x: 0, y: 0 },
    });
    await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "CONTROL_DELAY",
      connectFrom: { from: first.nodeId },
      position: { x: 0, y: 0 },
    });
    await call(double.registry, "layout_workflow", { workflowId: "wf-1" });
    const xs = double.state.definition.nodes.map(({ position }) => position.x);
    expect(new Set(xs).size).toBe(2);
  });

  test("a missing workflow is reported by id", async () => {
    const { registry: instance } = registry();
    await expect(
      call(instance, "add_workflow_step", {
        workflowId: "missing",
        kind: "CONTROL_DELAY",
      }),
    ).rejects.toThrow(/Workflow missing was not found/);
  });
});

describe("path availability", () => {
  test("reports what a step may bind to and what is unsatisfied", async () => {
    const double = registry();
    await call(double.registry, "add_workflow_step", {
      workflowId: "wf-1",
      kind: "WORKTREE_INSPECT",
      connectFrom: { from: "manual" },
    });
    const result = await call(
      double.registry,
      "get_workflow_path_availability",
      {
        workflowId: "wf-1",
      },
    );
    const steps = result.steps as Array<{ availableBefore: string[] }>;
    expect(steps[0]!.availableBefore).toEqual(["workflow.*"]);
    // A manual trigger cannot seed `worktree.id`, so the step is unsatisfiable.
    expect(result.violations).toContainEqual(
      expect.objectContaining({ path: "worktree.id" }),
    );
  });
});
