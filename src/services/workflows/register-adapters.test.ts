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
      workflow: { id: "workflow-definition", name: "Test with coverage" },
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

const diskSnapshot = {
  agent: {
    id: "agent-1",
    name: "Studio Mac",
    hostname: "studio.local",
    connected: true,
    diskTotalBytes: 200,
    diskFreeBytes: 100,
  },
  codebase: { agentId: "agent-1" },
  disk: {
    enabled: true,
    status: "IDLE",
    pressureMode: "NORMAL",
    manualPressureMode: false,
    automaticPressureMode: false,
    lastReportedAt: "2026-07-25T12:01:00.000Z",
    lastError: null,
    warnings: [],
    monitoredVolumeId: "derived",
    freeBytes: 50,
    totalBytes: 100,
    freeGiB: 50 / 1024 ** 3,
    freePercent: 50,
    usedPercent: 50,
    effectiveThresholdBytes: 40,
    normalThresholdGiB: 40,
    pressureThresholdGiB: 10,
    pollIntervalSeconds: 60,
    staleAfterSeconds: 120,
    changeReason: null,
    volumes: [],
  },
};

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

  test("passes selected MCP presets to newly created runs", async () => {
    const create = vi
      .fn()
      .mockResolvedValue({ id: "agent-run", kind: "SESSION" });
    const executor = executorWithCreate(create);
    const input = context("actual-worktree");
    input.node.config.mcpPresetIds = ["preset-1", "preset-2"];

    await executor.execute(input);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpPresetIds: ["preset-1", "preset-2"],
      }),
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

  test("refreshes ticket session data after adding a comment", async () => {
    const executor = new WorkflowStepExecutor();
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        jira: {
          addComment: vi.fn().mockResolvedValue({
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
      id: "comment",
      kind: "JIRA_COMMENT",
      config: { issueKey: "AIDE-42", content: "Done" },
    };

    const result = await executor.execute(input);

    expect(result.sessionPatch).toMatchObject({
      ticket: {
        key: "AIDE-42",
        title: "Resource navigation",
        type: "Task",
        status: "In Progress",
      },
    });
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

describe("workflow expansion adapters", () => {
  function expansionExecutor(callTool: ReturnType<typeof vi.fn>) {
    const executor = new WorkflowStepExecutor();
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      { tools: { callTool } } as unknown as WorkflowAdapterServices,
    );
    return executor;
  }

  test("unwraps GitHub action payloads and refreshes pull request context", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "provider result" }],
      structuredContent: {
        pullRequest: {
          id: "pr-1",
          number: 42,
          title: "Expansion actions",
          state: "OPEN",
          headRefName: "feature/expansion-actions",
          headRefOid: "abc123",
          reviewThreads: [],
        },
      },
    });
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "update-pr",
      kind: "GITHUB_UPDATE_PR",
      config: { owner: "acme", name: "widgets", number: 42, title: "Updated" },
    };

    const result = await expansionExecutor(callTool).execute(input);

    expect(result.output).toEqual({
      pullRequest: expect.objectContaining({ id: "pr-1", number: 42 }),
    });
    expect(result.sessionPatch).toMatchObject({
      steps: { "update-pr": { output: { pullRequest: { id: "pr-1" } } } },
      pr: {
        id: "pr-1",
        headBranch: "feature/expansion-actions",
        headSha: "abc123",
      },
    });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: "builtin:github",
        name: "update_pull_request",
      }),
      {
        caller: "workflow:workflow-run",
        correlationId: "attempt",
        source: "WORKFLOW",
      },
    );
  });

  test("unwraps Jira action payloads and refreshes ticket context", async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        ticket: {
          key: "AIDE-42",
          summary: "Expansion actions",
          issueType: { name: "Task" },
          status: { name: "In Progress" },
        },
      },
    });
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "create-ticket",
      kind: "JIRA_CREATE_TICKET",
      config: {
        projectKey: "AIDE",
        issueTypeId: "10001",
        summary: "Expansion actions",
      },
    };

    const result = await expansionExecutor(callTool).execute(input);

    expect(result.output).toEqual({
      ticket: expect.objectContaining({ key: "AIDE-42" }),
    });
    expect(result.sessionPatch).toMatchObject({
      ticket: {
        key: "AIDE-42",
        title: "Expansion actions",
        type: "Task",
        status: "In Progress",
      },
    });
  });

  test("parks a rerun and seeds the canonical command namespace", async () => {
    const callTool = vi.fn().mockResolvedValue({
      structuredContent: {
        run: { id: "command-run-2", commandId: "command-1", status: "QUEUED" },
      },
    });
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "rerun",
      kind: "COMMAND_RERUN",
      config: { cadenceSeconds: 7, timeoutSeconds: 90 },
    };
    input.sessionData = {
      ...input.sessionData,
      command: { id: "command-run-1" },
    };

    const result = await expansionExecutor(callTool).execute(input);

    expect(result.output).toEqual({
      run: expect.objectContaining({ id: "command-run-2" }),
    });
    expect(result.sessionPatch).toMatchObject({
      command: { id: "command-run-2", status: "QUEUED" },
    });
    expect(result.wait).toMatchObject({
      kind: "COMMAND_RUN",
      externalKey: "command-run-2",
    });
  });
});

describe("workflow wait pollers", () => {
  function pollers(services: Partial<WorkflowAdapterServices>) {
    const registered = new Map<
      string,
      (externalKey: string) => Promise<{
        pending: boolean;
        result?: Record<string, unknown>;
      }>
    >();
    registerWorkflowAdapters(
      {
        registerWaitPoller: vi.fn((kind, poller) => {
          registered.set(kind, poller);
        }),
      } as unknown as WorkflowsService,
      new WorkflowStepExecutor(),
      services as WorkflowAdapterServices,
    );
    return registered;
  }

  test("hydrates the destination context after moving a worktree", async () => {
    const richContext = {
      worktree: { id: "worktree-2", branch: "feature/APP-42" },
      codebase: { id: "codebase-2", agentId: "agent-2" },
      agent: { id: "agent-2" },
      repo: { id: "repository-2" },
      ticket: { key: "APP-42" },
    };
    const workflowSessionDataForWorktree = vi
      .fn()
      .mockResolvedValue(richContext);
    const registered = pollers({
      worktrees: {
        getMove: vi.fn().mockResolvedValue({
          id: "move-1",
          status: "SUCCEEDED",
          targetWorktreeId: "worktree-2",
          error: null,
        }),
        workflowSessionDataForWorktree,
      } as unknown as WorkflowAdapterServices["worktrees"],
    });

    const result = await registered.get("WORKTREE_MOVE")?.("move-1");

    expect(workflowSessionDataForWorktree).toHaveBeenCalledWith("worktree-2", {
      includeMissing: true,
    });
    expect(result?.result).toMatchObject({ sessionPatch: richContext });
  });

  test("writes a terminal GitHub check result into pipeline context", async () => {
    const registered = pollers({
      github: {
        autoRetryRun: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "SUCCESS",
          jobs: [{ id: "job-1", status: "SUCCESS" }],
        }),
      } as unknown as WorkflowAdapterServices["github"],
    });

    const result = await registered.get("GITHUB_CHECKS")?.(
      JSON.stringify({ repositoryId: "repo-1", workflowRunId: "run-1" }),
    );

    expect(result?.result).toMatchObject({
      sessionPatch: {
        pipeline: {
          runId: "run-1",
          status: "SUCCESS",
          conclusion: "SUCCESS",
          jobs: [{ id: "job-1" }],
        },
      },
    });
  });

  test("hydrates terminal command context after a queued rerun", async () => {
    const finishedAt = new Date("2026-07-26T12:00:00.000Z");
    const registered = pollers({
      commands: {
        getRun: vi.fn().mockResolvedValue({
          id: "command-run-2",
          commandId: "command-1",
          snapshotName: "Verify",
          displayNumber: 2,
          status: "SUCCEEDED",
          exitCode: 0,
          signal: null,
          error: null,
          finishedAt,
        }),
      } as unknown as WorkflowAdapterServices["commands"],
    });

    const result = await registered.get("COMMAND_RUN")?.("command-run-2");

    expect(result).toMatchObject({
      pending: false,
      result: {
        sessionPatch: {
          command: {
            id: "command-run-2",
            status: "SUCCEEDED",
            finishedAt: finishedAt.toISOString(),
          },
        },
      },
    });
  });

  test("waits for build-data refresh collections to complete", async () => {
    const getCollection = vi
      .fn()
      .mockResolvedValueOnce({ id: "collection-1", status: "COLLECTING" })
      .mockResolvedValueOnce({ id: "collection-1", status: "COMPLETED" });
    const registered = pollers({
      buildData: { getCollection } as never,
    });

    await expect(
      registered.get("BUILD_DATA_COLLECTION")?.("collection-1"),
    ).resolves.toEqual({ pending: true, pollAfterSeconds: 2 });
    await expect(
      registered.get("BUILD_DATA_COLLECTION")?.("collection-1"),
    ).resolves.toMatchObject({
      pending: false,
      result: {
        sessionPatch: {
          buildData: { id: "collection-1", status: "COMPLETED" },
        },
      },
    });
  });

  test("completes a disk refresh only after a newer report", async () => {
    const snapshot = vi.fn().mockResolvedValue(diskSnapshot);
    const registered = pollers({ diskSpace: { snapshot } as never });
    const result = await registered.get("DISK_SPACE_REPORT")?.(
      JSON.stringify({
        agentId: "agent-1",
        requestedAt: "2026-07-25T12:00:30.000Z",
        previousReportedAt: "2026-07-25T12:00:00.000Z",
      }),
    );

    expect(result).toMatchObject({
      pending: false,
      result: { sessionPatch: diskSnapshot },
    });
  });

  test("accepts the first report without relying on agent clock alignment", async () => {
    const snapshot = vi.fn().mockResolvedValue({
      ...diskSnapshot,
      disk: {
        ...diskSnapshot.disk,
        lastReportedAt: "2026-07-25T11:59:00.000Z",
      },
    });
    const registered = pollers({ diskSpace: { snapshot } as never });

    await expect(
      registered.get("DISK_SPACE_REPORT")?.(
        JSON.stringify({
          agentId: "agent-1",
          requestedAt: "2026-07-25T12:00:30.000Z",
          previousReportedAt: null,
        }),
      ),
    ).resolves.toMatchObject({ pending: false });
  });

  test("keeps polling stale reports and fails if monitoring is disabled", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({
        ...diskSnapshot,
        disk: {
          ...diskSnapshot.disk,
          lastReportedAt: "2026-07-25T12:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        ...diskSnapshot,
        disk: { ...diskSnapshot.disk, enabled: false },
      });
    const registered = pollers({ diskSpace: { snapshot } as never });
    const key = JSON.stringify({
      agentId: "agent-1",
      requestedAt: "2026-07-25T12:00:30.000Z",
      previousReportedAt: "2026-07-25T12:00:00.000Z",
    });

    await expect(registered.get("DISK_SPACE_REPORT")?.(key)).resolves.toEqual({
      pending: true,
      pollAfterSeconds: 2,
    });
    await expect(registered.get("DISK_SPACE_REPORT")?.(key)).resolves.toEqual({
      pending: false,
      error: "Disk-space monitoring was disabled while awaiting a report",
    });
  });
});

describe("disk-space workflow adapters", () => {
  function diskExecutor() {
    const executor = new WorkflowStepExecutor();
    const diskSpace = {
      snapshot: vi.fn().mockResolvedValue(diskSnapshot),
      requestRefresh: vi.fn().mockResolvedValue({
        agentId: "agent-fixed",
        requestedAt: "2026-07-25T12:01:30.000Z",
        previousReportedAt: "2026-07-25T12:01:00.000Z",
      }),
      updateSettings: vi.fn().mockResolvedValue({
        normalThresholdGiB: 50,
        pressureThresholdGiB: 12,
        pollIntervalSeconds: 60,
        staleAfterSeconds: 120,
      }),
      setMonitoring: vi.fn().mockResolvedValue({}),
      setManualPressureMode: vi.fn().mockResolvedValue({}),
    };
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      { diskSpace } as unknown as WorkflowAdapterServices,
    );
    return { executor, diskSpace };
  }

  function diskContext(kind: string, config: Record<string, unknown> = {}) {
    const input = context("actual-worktree");
    input.node = { ...input.node, id: "disk", kind, config } as never;
    input.sessionData = {
      ...input.sessionData,
      agent: { id: "agent-session" },
      codebase: { agentId: "agent-codebase" },
    };
    return input;
  }

  test("loads and patches the canonical snapshot for a session agent", async () => {
    const { executor, diskSpace } = diskExecutor();
    const result = await executor.execute(diskContext("DISK_SPACE_LOAD"));

    expect(diskSpace.snapshot).toHaveBeenCalledWith("agent-session");
    expect(result).toMatchObject({
      output: diskSnapshot,
      sessionPatch: diskSnapshot,
      links: [{ kind: "AGENT", resourceId: "agent-session" }],
    });
  });

  test("falls back to the codebase's owning agent", async () => {
    const { executor, diskSpace } = diskExecutor();
    const input = diskContext("DISK_SPACE_LOAD");
    delete input.sessionData.agent;

    await executor.execute(input);

    expect(diskSpace.snapshot).toHaveBeenCalledWith("agent-codebase");
  });

  test("requests an immediate fixed-agent refresh with default timing", async () => {
    const { executor, diskSpace } = diskExecutor();
    const result = await executor.execute(
      diskContext("DISK_SPACE_REFRESH", { agentId: "agent-fixed" }),
    );
    const seconds = (value: Date | null | undefined) =>
      Math.round(((value?.getTime() ?? 0) - Date.now()) / 1_000);

    expect(diskSpace.requestRefresh).toHaveBeenCalledWith("agent-fixed");
    expect(result.wait).toMatchObject({ kind: "DISK_SPACE_REPORT" });
    expect(seconds(result.wait?.resumeAfter)).toBe(2);
    expect(seconds(result.wait?.timeoutAt)).toBe(180);
  });

  test("applies normal workflow timing overrides to refresh", async () => {
    const { executor } = diskExecutor();
    const result = await executor.execute(
      diskContext("DISK_SPACE_REFRESH", {
        agentId: "agent-fixed",
        cadenceSeconds: 7,
        timeoutSeconds: 90,
      }),
    );
    const seconds = (value: Date | null | undefined) =>
      Math.round(((value?.getTime() ?? 0) - Date.now()) / 1_000);

    expect(seconds(result.wait?.resumeAfter)).toBe(7);
    expect(seconds(result.wait?.timeoutAt)).toBe(90);
  });

  test("updates global thresholds and patches global disk settings", async () => {
    const { executor, diskSpace } = diskExecutor();
    const result = await executor.execute(
      diskContext("DISK_SPACE_UPDATE_THRESHOLDS", {
        normalThresholdGiB: 50,
        pressureThresholdGiB: 12,
      }),
    );

    expect(diskSpace.updateSettings).toHaveBeenCalledWith({
      normalThresholdGiB: 50,
      pressureThresholdGiB: 12,
    });
    expect(result.sessionPatch).toMatchObject({
      disk: { normalThresholdGiB: 50, pressureThresholdGiB: 12 },
    });
  });

  test.each([
    ["DISK_SPACE_SET_MONITORING", "setMonitoring", false],
    ["DISK_SPACE_SET_PRESSURE_MODE", "setManualPressureMode", true],
  ] as const)(
    "%s toggles the agent and reloads fresh session data",
    async (kind, operation, enabled) => {
      const { executor, diskSpace } = diskExecutor();
      const result = await executor.execute(
        diskContext(kind, { enabled, agentId: "agent-fixed" }),
      );

      expect(diskSpace[operation]).toHaveBeenCalledWith("agent-fixed", enabled);
      expect(diskSpace.snapshot).toHaveBeenCalledWith("agent-fixed");
      expect(result.sessionPatch).toEqual(diskSnapshot);
    },
  );
});

describe("worktree pull request refresh workflow adapter", () => {
  test.each([
    [
      "returns and seeds a discovered pull request",
      {
        id: "pull-request-1",
        number: 42,
        title: "Refresh persisted PR",
        url: "https://github.com/acme/widgets/pull/42",
        repositoryNameWithOwner: "acme/widgets",
        headRefName: "feature/AIDE-79",
        headRefOid: "abc123",
        state: "OPEN",
      },
      true,
    ],
    ["clears PR context when none is open", null, false],
  ] as const)("%s", async (_label, pullRequest, found) => {
    const executor = new WorkflowStepExecutor();
    const refreshPullRequest = vi.fn().mockResolvedValue({
      id: "actual-worktree",
      pullRequest,
    });
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        worktrees: { refreshPullRequest },
      } as unknown as WorkflowAdapterServices,
    );
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "refresh-pr",
      kind: "WORKTREE_REFRESH_PULL_REQUEST",
      config: {},
    };

    const result = await executor.execute(input);

    expect(refreshPullRequest).toHaveBeenCalledWith("actual-worktree");
    expect(result.output).toEqual({ found, pullRequest });
    expect(result.sessionPatch).toEqual({
      pr: pullRequest
        ? expect.objectContaining({
            id: "pull-request-1",
            headBranch: "feature/AIDE-79",
            headSha: "abc123",
            merged: false,
          })
        : null,
    });
    expect(result.links).toEqual(
      pullRequest
        ? expect.arrayContaining([
            expect.objectContaining({ kind: "WORKTREE" }),
            expect.objectContaining({
              kind: "PULL_REQUEST",
              resourceId: "acme/widgets#42",
            }),
          ])
        : [expect.objectContaining({ kind: "WORKTREE" })],
    );
  });

  test("attaches pull requests created by workflow actions", async () => {
    const executor = new WorkflowStepExecutor();
    const pullRequest = {
      id: "pull-request-created",
      number: 43,
      title: "Workflow-created pull request",
      url: "https://github.com/acme/widgets/pull/43",
      headRefName: "feature/AIDE-80",
      headRefOid: "def456",
      state: "OPEN",
    };
    const createPullRequest = vi.fn().mockResolvedValue(pullRequest);
    const attachPullRequestForBranch = vi.fn().mockResolvedValue(1);
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        github: { createPullRequest },
        worktrees: { attachPullRequestForBranch },
      } as unknown as WorkflowAdapterServices,
    );
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "create-pr",
      kind: "GITHUB_CREATE_PR",
      config: {
        owner: "acme",
        name: "widgets",
        baseRefName: "main",
        headRefName: "feature/AIDE-80",
        title: "Workflow-created pull request",
      },
    };

    await executor.execute(input);

    expect(attachPullRequestForBranch).toHaveBeenCalledWith(
      "github.com/acme/widgets",
      "feature/AIDE-80",
      pullRequest,
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

describe("coverage import workflow adapter", () => {
  function coverageExecutor(
    importCoverageReport = vi
      .fn()
      .mockResolvedValue({ id: "build-1", jobId: "job-1" }),
  ) {
    const executor = new WorkflowStepExecutor();
    registerWorkflowAdapters(
      { registerWaitPoller: vi.fn() } as unknown as WorkflowsService,
      executor,
      {
        builds: { importCoverageReport },
      } as unknown as WorkflowAdapterServices,
    );
    return { executor, importCoverageReport };
  }

  function coverageContext(config: Record<string, unknown> = {}) {
    const input = context("actual-worktree");
    input.node = {
      ...input.node,
      id: "coverage",
      kind: "BUILD_IMPORT_COVERAGE",
      config,
    } as never;
    return input;
  }

  test("imports the configured file and waits on the agent job", async () => {
    const { executor, importCoverageReport } = coverageExecutor();

    const result = await executor.execute(
      coverageContext({
        buildName: "Frontend coverage",
        reportPath: "coverage/coverage-final.json",
        format: "ISTANBUL",
      }),
    );

    expect(importCoverageReport).toHaveBeenCalledWith({
      worktreeId: "actual-worktree",
      buildName: "Frontend coverage",
      reportPath: "coverage/coverage-final.json",
      format: "ISTANBUL",
      requestId: "workflow-run:attempt:coverage-import",
    });
    expect(result.sessionPatch).toEqual({ build: { id: "build-1" } });
    expect(result.wait).toEqual(
      expect.objectContaining({ kind: "AGENT_JOB", externalKey: "job-1" }),
    );
    expect(result.links).toEqual([
      expect.objectContaining({ kind: "WORKTREE" }),
      expect.objectContaining({
        kind: "BUILD",
        resourceId: "build-1",
        url: "/builds/build-1",
      }),
      expect.objectContaining({ kind: "AGENT_JOB", resourceId: "job-1" }),
    ]);
  });

  test("defaults the path and format, and skips the wait without a job", async () => {
    const { executor, importCoverageReport } = coverageExecutor(
      vi.fn().mockResolvedValue({ id: "build-2" }),
    );

    const result = await executor.execute(coverageContext());

    expect(importCoverageReport).toHaveBeenCalledWith(
      expect.objectContaining({
        buildName: "Test with coverage",
        reportPath: "coverage/lcov.info",
        format: "AUTO",
      }),
    );
    expect(result.wait).toBeUndefined();
    expect(result.sessionPatch).toEqual({ build: { id: "build-2" } });
  });
});
