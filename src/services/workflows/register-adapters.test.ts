import { describe, expect, test, vi } from "vitest";

import type { WorkflowExecutionContext } from "./step-executor";
import { WorkflowStepExecutor } from "./step-executor";
import {
  registerWorkflowAdapters,
  type WorkflowAdapterServices,
} from "./register-adapters";
import type { WorkflowsService } from "./workflows.service";

function context(worktreeId: string): WorkflowExecutionContext {
  return {
    run: { id: "workflow-run", workflowId: "workflow-definition" },
    attempt: { id: "attempt" },
    node: {
      id: "session",
      kind: "RUN_CREATE_SESSION",
      position: { x: 0, y: 0 },
      config: {
        worktreeId,
        provider: "CODEX",
        model: "gpt-test",
        prompt: "Implement the change",
      },
      requiredPaths: [],
      providedPaths: [],
      retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 1 },
      failurePolicy: "FAIL",
    },
    sessionData: {
      workflow: { id: "workflow-definition" },
      worktree: { id: "actual-worktree" },
    },
    signal: new AbortController().signal,
  } as unknown as WorkflowExecutionContext;
}

function executorWithCreate(create: ReturnType<typeof vi.fn>) {
  const executor = new WorkflowStepExecutor();
  const workflows = {
    registerWaitPoller: vi.fn(),
  } as unknown as WorkflowsService;
  const services = {
    runs: { create },
  } as unknown as WorkflowAdapterServices;
  registerWorkflowAdapters(workflows, executor, services);
  return executor;
}

describe("workflow run adapters", () => {
  test("recovers a worktree id accidentally bound to workflow.id", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "agent-run", kind: "SESSION" });
    const executor = executorWithCreate(create);

    await executor.execute(context("workflow-definition"));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "actual-worktree" }),
    );
  });

  test("preserves an intentional configured worktree override", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "agent-run", kind: "SESSION" });
    const executor = executorWithCreate(create);

    await executor.execute(context("override-worktree"));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: "override-worktree" }),
    );
  });

  test("links created runs to their internal detail pages", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "agent-run", kind: "SESSION" });
    const executor = executorWithCreate(create);

    const result = await executor.execute(context("actual-worktree"));

    expect(result.links).toEqual([
      expect.objectContaining({
        kind: "AGENT_RUN",
        resourceId: "agent-run",
        url: "/sessions/agent-run",
        metadata: { runKind: "SESSION" },
      }),
    ]);
  });

  test("links Jira actions to the affected ticket", async () => {
    const executor = new WorkflowStepExecutor();
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        jira: {
          ticket: vi.fn().mockResolvedValue({
            key: "AIDE-42",
            summary: "Resource navigation",
            issueType: { name: "Task" },
            status: { name: "In Progress" },
          }),
        },
      } as unknown as WorkflowAdapterServices,
    );
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "ticket",
      kind: "JIRA_LOAD_TICKET",
      config: { issueKey: "AIDE-42" },
    };

    const result = await executor.execute(input);

    expect(result.links).toEqual([
      {
        kind: "JIRA_TICKET",
        resourceId: "AIDE-42",
        label: "Resource navigation",
      },
    ]);
  });
});
