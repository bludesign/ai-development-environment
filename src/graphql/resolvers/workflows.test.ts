import { describe, expect, test, vi } from "vitest";

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

  test("forwards worktree and workflow queue scopes", async () => {
    const runQueue = vi.fn().mockResolvedValue([]);
    const runQueueForWorkflowRun = vi.fn().mockResolvedValue([]);
    const resolver = createWorkflowResolvers({
      runQueue,
      runQueueForWorkflowRun,
    } as unknown as WorkflowsService).Query.worktreeRunQueue;

    await expect(
      resolver(undefined, { worktreeId: "worktree-1" }, {} as never),
    ).resolves.toEqual([]);
    await expect(
      resolver(undefined, { workflowId: "workflow-1" }, {} as never),
    ).resolves.toEqual([]);
    expect(runQueue).toHaveBeenNthCalledWith(1, {
      worktreeId: "worktree-1",
    });
    expect(runQueue).toHaveBeenNthCalledWith(2, {
      workflowId: "workflow-1",
    });

    await expect(
      createWorkflowResolvers({
        runQueueForWorkflowRun,
      } as unknown as WorkflowsService).WorkflowRun.queue({ id: "run-1" }),
    ).resolves.toEqual([]);
    expect(runQueueForWorkflowRun).toHaveBeenCalledWith("run-1");
  });
});
