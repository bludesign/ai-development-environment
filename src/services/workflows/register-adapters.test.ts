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

  test.each([
    ["GITHUB_REPLY_REVIEW_THREAD", "replyToReviewThread"],
    ["GITHUB_SET_REVIEW_THREAD_RESOLVED", "setReviewThreadResolved"],
  ] as const)(
    "%s succeeds without repository or pull request link context",
    async (kind, operation) => {
      const mutation = vi.fn().mockResolvedValue({ id: "result-1" });
      const executor = new WorkflowStepExecutor();
      registerWorkflowAdapters(
        { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
        executor,
        {
          github: { [operation]: mutation },
        } as unknown as WorkflowAdapterServices,
      );
      const input = context("actual-worktree");
      input.node = {
        ...input.node,
        id: "review-thread",
        kind,
        config:
          kind === "GITHUB_REPLY_REVIEW_THREAD"
            ? { threadId: "thread-1", body: "Fixed" }
            : { threadId: "thread-1", resolved: true },
      };

      const result = await executor.execute(input);

      expect(mutation).toHaveBeenCalled();
      expect(result.output).toEqual({ id: "result-1" });
      expect(result.links).toBeUndefined();
    },
  );

  test("prepares an answer revision without optional run context", async () => {
    const questionBatch = vi
      .fn()
      .mockResolvedValue({ id: "batch-1", revisionPreparedAt: null });
    const prepareAnswerRevision = vi.fn().mockResolvedValue(undefined);
    const executor = new WorkflowStepExecutor();
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        runs: { questionBatch, prepareAnswerRevision },
      } as unknown as WorkflowAdapterServices,
    );
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "revise-answer",
      kind: "RUN_REVISE_ANSWER",
      config: { batchId: "batch-1", answers: { answer: "Updated" } },
    };
    input.sessionData = { ...input.sessionData, run: { kind: "SESSION" } };

    const result = await executor.execute(input);

    expect(prepareAnswerRevision).toHaveBeenCalledWith("batch-1");
    expect(result.links).toBeUndefined();
    expect(result.wait).toEqual(
      expect.objectContaining({ kind: "RUN_ANSWER_REVISION" }),
    );
  });
});

describe("saved command workflow adapter", () => {
  function commandExecutor(restartPolicy = "NEVER") {
    const executor = new WorkflowStepExecutor();
    const startRun = vi.fn().mockResolvedValue({
      id: "command-run-1",
      displayNumber: 7,
      status: "RUNNING",
    });
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        commands: {
          getDefinition: vi.fn().mockResolvedValue({
            id: "command-1",
            archivedAt: null,
            targetKind: "ANY_WORKTREE",
            restartPolicy,
          }),
          startRun,
        },
      } as unknown as WorkflowAdapterServices,
    );
    return { executor, startRun };
  }

  function commandContext(completionMode: string) {
    const input = context("actual-worktree");
    input.attempt = {
      ...input.attempt,
      idempotencyKey: "workflow-command-attempt",
    };
    input.node = {
      ...input.node,
      id: "saved-command",
      kind: "SAVED_COMMAND",
      config: {
        commandId: "command-1",
        completionMode,
        targetMode: "CONTEXT",
      },
    };
    return input;
  }

  test("uses workflow context, waits, and links the command resource", async () => {
    const { executor, startRun } = commandExecutor();
    const result = await executor.execute(commandContext("WAIT_FOR_EXIT"));

    expect(startRun).toHaveBeenCalledWith({
      commandId: "command-1",
      agentId: null,
      worktreeId: "actual-worktree",
      origin: "WORKFLOW",
      idempotencyKey: "workflow-command-attempt",
    });
    expect(result.wait).toEqual(
      expect.objectContaining({
        kind: "COMMAND_RUN",
        externalKey: "command-run-1",
      }),
    );
    expect(result.links).toEqual([
      expect.objectContaining({
        kind: "COMMAND_RUN",
        resourceId: "command-run-1",
        url: "/commands/runs/command-run-1",
      }),
    ]);
  });

  test("fire and forget succeeds after dispatch without a wait", async () => {
    const { executor } = commandExecutor("ALWAYS");
    const result = await executor.execute(commandContext("FIRE_AND_FORGET"));
    expect(result.wait).toBeUndefined();
  });

  test("rejects always-restart commands when waiting for exit", async () => {
    const { executor } = commandExecutor("ALWAYS");
    await expect(
      executor.execute(commandContext("WAIT_FOR_EXIT")),
    ).rejects.toThrow("require fire and forget");
  });
});

describe("custom command workflow adapter", () => {
  function customExecutor() {
    const executor = new WorkflowStepExecutor();
    const startCustomRun = vi.fn().mockResolvedValue({
      id: "custom-run-1",
      displayNumber: 8,
      status: "RUNNING",
    });
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      { commands: { startCustomRun } } as unknown as WorkflowAdapterServices,
    );
    return { executor, startCustomRun };
  }

  test("prefers the workflow worktree context and waits for exit", async () => {
    const { executor, startCustomRun } = customExecutor();
    const input = context("actual-worktree");
    input.attempt = { ...input.attempt, idempotencyKey: "custom-attempt" };
    input.node = {
      ...input.node,
      id: "custom-command",
      kind: "CUSTOM_COMMAND",
      config: {
        script: "printf custom",
        completionMode: "WAIT_FOR_EXIT",
        targetMode: "CONTEXT",
      },
    };

    const result = await executor.execute(input);

    expect(startCustomRun).toHaveBeenCalledWith({
      script: "printf custom",
      agentId: null,
      worktreeId: "actual-worktree",
      origin: "WORKFLOW",
      idempotencyKey: "custom-attempt",
    });
    expect(result.wait).toEqual(
      expect.objectContaining({
        kind: "COMMAND_RUN",
        externalKey: "custom-run-1",
      }),
    );
    expect(result.links).toEqual([
      expect.objectContaining({
        kind: "COMMAND_RUN",
        resourceId: "custom-run-1",
      }),
    ]);
  });

  test("supports a fixed agent with fire and forget", async () => {
    const { executor, startCustomRun } = customExecutor();
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "custom-command",
      kind: "CUSTOM_COMMAND",
      config: {
        script: "printf fixed",
        completionMode: "FIRE_AND_FORGET",
        targetMode: "FIXED_AGENT",
        agentId: "agent-fixed",
      },
    };

    const result = await executor.execute(input);

    expect(startCustomRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-fixed",
        worktreeId: null,
      }),
    );
    expect(result.wait).toBeUndefined();
  });

  test("applies the step's configured wait timing", async () => {
    const { executor } = customExecutor();
    const input = context("actual-worktree");
    input.attempt = { ...input.attempt, idempotencyKey: "custom-attempt" };
    input.node = {
      ...input.node,
      id: "custom-command",
      kind: "CUSTOM_COMMAND",
      config: {
        script: "printf custom",
        completionMode: "WAIT_FOR_EXIT",
        cadenceSeconds: 30,
        timeoutSeconds: 7_200,
      },
    };

    const result = await executor.execute(input);
    const seconds = (value: Date | null | undefined) =>
      Math.round(((value?.getTime() ?? 0) - Date.now()) / 1_000);

    expect(seconds(result.wait?.resumeAfter)).toBe(30);
    expect(seconds(result.wait?.timeoutAt)).toBe(7_200);
  });

  test("keeps the built-in wait timing when the step configures none", async () => {
    const { executor } = customExecutor();
    const input = context("actual-worktree");
    input.attempt = { ...input.attempt, idempotencyKey: "custom-attempt" };
    input.node = {
      ...input.node,
      id: "custom-command",
      kind: "CUSTOM_COMMAND",
      config: { script: "printf custom", completionMode: "WAIT_FOR_EXIT" },
    };

    const result = await executor.execute(input);

    expect(
      Math.round(
        ((result.wait?.resumeAfter?.getTime() ?? 0) - Date.now()) / 1_000,
      ),
    ).toBe(1);
    expect(result.wait?.timeoutAt).toBeNull();
  });
});
