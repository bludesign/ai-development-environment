import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  emptyWorkflowDefinition,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import { WorkflowEventsService } from "./workflow-events.service";
import { WorkflowsService } from "./workflows.service";

const prisma = vi.hoisted(() => ({
  workflow: { findUnique: vi.fn() },
  workflowVersion: { findMany: vi.fn() },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => prisma,
}));

function subworkflowDefinition(
  name: string,
  versionId: string,
): WorkflowDefinition {
  const definition = emptyWorkflowDefinition(name);
  return {
    ...definition,
    nodes: [
      {
        id: "subworkflow",
        kind: "CONTROL_SUBWORKFLOW",
        position: { x: 200, y: 100 },
        config: { versionId },
        requiredPaths: [],
        providedPaths: [],
        retry: {
          maxAttempts: 1,
          strategy: "EXPONENTIAL",
          delaySeconds: 5,
        },
        failurePolicy: "FAIL",
      },
    ],
    edges: [
      {
        id: "manual-to-subworkflow",
        source: "manual",
        target: "subworkflow",
        sourceHandle: "success",
        targetHandle: "input",
      },
    ],
  };
}

describe("workflow sub-workflow validation", () => {
  beforeEach(() => vi.clearAllMocks());

  test("rejects indirect recursion through pinned versions", async () => {
    const draft = subworkflowDefinition("Workflow A", "version-b");
    prisma.workflow.findUnique.mockResolvedValue({
      id: "workflow-a",
      draftDefinitionJson: JSON.stringify(draft),
      activeVersion: null,
      versions: [],
      _count: { runs: 0 },
    });
    const versions = [
      {
        id: "version-b",
        workflowId: "workflow-b",
        definitionJson: JSON.stringify(
          subworkflowDefinition("Workflow B", "version-a"),
        ),
      },
      {
        id: "version-a",
        workflowId: "workflow-a",
        definitionJson: JSON.stringify(emptyWorkflowDefinition("Workflow A")),
      },
    ];
    prisma.workflowVersion.findMany.mockImplementation(
      async ({ where }: { where: { id: { in: string[] } } }) =>
        versions.filter(({ id }) => where.id.in.includes(id)),
    );

    const service = new WorkflowsService(new WorkflowEventsService());
    const result = await service.validateDraft("workflow-a");

    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "SUBWORKFLOW_RECURSION",
        nodeId: "subworkflow",
      }),
    );
  });
});
