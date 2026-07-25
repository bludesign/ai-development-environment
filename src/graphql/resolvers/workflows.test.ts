import { describe, expect, test } from "vitest";

import { emptyWorkflowDefinition } from "@/lib/workflows/definition";
import type { WorkflowsService } from "@/services/workflows";

import { createWorkflowResolvers } from "./workflows";

describe("workflow trigger metadata", () => {
  test("reports matching plain manual and resource triggers", () => {
    const definition = emptyWorkflowDefinition("Runnable workflow");
    definition.triggers.push({
      id: "worktree-manual",
      kind: "RESOURCE_MANUAL",
      position: { x: 0, y: 160 },
      config: { resourceKind: "WORKTREE" },
    });
    const workflow = {
      activeVersion: { definitionJson: JSON.stringify(definition) },
    };
    const resolver = createWorkflowResolvers({} as WorkflowsService).Workflow
      .hasPlainTrigger;

    expect(resolver(workflow, {})).toBe(true);
    expect(resolver(workflow, { resourceKind: "worktree" })).toBe(true);
    expect(resolver(workflow, { resourceKind: "PULL_REQUEST" })).toBe(false);
    expect(resolver({ activeVersion: null }, {})).toBe(false);
  });
});
