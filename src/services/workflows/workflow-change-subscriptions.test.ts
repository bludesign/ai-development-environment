// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));
vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import {
  WORKFLOWS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import { WorkflowEventsService } from "./workflow-events.service";
import { WorkflowsService } from "./workflows.service";

afterEach(() => vi.clearAllMocks());

test("looks a changed run up once, however many resource subscriptions filter on it", async () => {
  const findUnique = vi.fn(async () => ({
    worktreeId: "worktree-2",
    workflowId: "workflow",
    resourceLinks: [{ kind: "WORKTREE", resourceId: "worktree-2" }],
  }));
  mocks.getPrismaClient.mockResolvedValue({ workflowRun: { findUnique } });
  const service = new WorkflowsService(new WorkflowEventsService());

  // A page showing one card per worktree opens one subscription per card.
  const subscriptions = ["worktree-1", "worktree-2", "worktree-3"].map(
    (resourceId) =>
      service.subscribeChanges({ resourceKind: "worktree", resourceId }),
  );
  const delivered = subscriptions.map((subscription) => subscription.next());
  try {
    const runChange = { workflowChanged: { id: "runs", runId: "run-1" } };
    agentEventBus.publish(WORKFLOWS_CHANGED_TOPIC, runChange);
    expect((await delivered[1]).value).toBe(runChange);

    // The cards for other worktrees are still waiting; a definitions change
    // reaches every subscription and proves they skipped the run change.
    const definitionChange = { workflowChanged: { id: "workflow" } };
    agentEventBus.publish(WORKFLOWS_CHANGED_TOPIC, definitionChange);
    expect((await delivered[0]).value).toBe(definitionChange);
    expect((await delivered[2]).value).toBe(definitionChange);
    expect(findUnique).toHaveBeenCalledTimes(1);
  } finally {
    await Promise.all(
      subscriptions.map((subscription) => subscription.return?.()),
    );
  }
});
