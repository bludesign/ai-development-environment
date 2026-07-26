import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { WORKTREE_AUTO_SYNC_JOB_KIND } from "@ai-development-environment/agent-contract/worktrees";
import type { AgentControlService } from "@/services/agent-control";
import type { GitHubService } from "@/services/github";
import type { JiraService } from "@/services/jira";
import type { PollingService } from "@/services/polling";
import type { WorkflowsService } from "@/services/workflows";

import { WorktreeAutomationService } from "./worktree-automation.service";
import type { WorktreesService } from "./worktrees.service";

type CompletionObserver = Parameters<
  AgentControlService["registerCompletionObserver"]
>[0];

function dependencies() {
  let completionObserver: CompletionObserver | undefined;
  const agentControl = {
    registerCompletionObserver: vi.fn((observer: CompletionObserver) => {
      completionObserver = observer;
    }),
  } as unknown as AgentControlService;
  const polling = {
    register: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn(),
  } as unknown as PollingService;

  new WorktreeAutomationService(
    {} as WorktreesService,
    {} as GitHubService,
    {} as JiraService,
    {} as WorkflowsService,
    agentControl,
    polling,
  );

  return { completionObserver: () => completionObserver, polling };
}

function completedJob(kind: string) {
  return {
    id: "job-1",
    agentId: "agent-1",
    codebaseId: "codebase-1",
    worktreeId: "worktree-1",
    buildDataCollectionId: null,
    kind,
    payloadJson: "{}",
    status: "SUCCEEDED",
    resultJson: "{}",
    error: null,
  };
}

describe("WorktreeAutomationService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  test("reconciles immediately when an Auto Sync job completes", async () => {
    const { completionObserver, polling } = dependencies();

    await completionObserver()?.(completedJob(WORKTREE_AUTO_SYNC_JOB_KIND));
    await vi.advanceTimersByTimeAsync(0);

    expect(polling.run).toHaveBeenCalledWith(
      "server:worktree-automations",
      expect.any(Function),
    );
  });

  test("does not reconcile for unrelated completed jobs", async () => {
    const { completionObserver, polling } = dependencies();

    await completionObserver()?.(completedJob("worktree.inspect"));
    await vi.advanceTimersByTimeAsync(0);

    expect(polling.run).not.toHaveBeenCalled();
  });
});
