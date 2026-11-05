import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./handlers/index.js", () => ({
  handlers: {
    "codebase.fetch": vi.fn(),
    "codebase.branches.delete": vi.fn(),
    "worktree.inspect": vi.fn(),
    "worktree.diff.inspect": vi.fn(),
    "worktree.git.inspect": vi.fn(),
    "codebase.git.inspect": vi.fn(),
    "worktree.diff.asset": vi.fn(),
    "ios.build.run": vi.fn(),
    "worktree.auto-sync": vi.fn(),
  },
}));
vi.mock("./handlers/worktrees.js", () => ({
  closeAllWorktreeWatches: vi.fn(),
  discoverWorktrees: vi.fn(),
}));

import type { AgentGraphQLClient, AgentJob } from "./graphql-client.js";
import { handlers } from "./handlers/index.js";
import { discoverWorktrees } from "./handlers/worktrees.js";
import { JobExecutor } from "./job-executor.js";
import type { FetchedCodebaseRefresh } from "./refresh-fetched-codebase.js";
import { RepositoryCoordinator } from "./repository-coordinator.js";
import { AgentRequestError } from "./request-errors.js";
import * as executionRecovery from "./execution-recovery.js";

const job: AgentJob = {
  id: "job-1",
  agentId: "agent-1",
  kind: "ccusage.report",
  payload: {},
  status: "QUEUED",
  timeoutSeconds: 60,
};

describe("JobExecutor", () => {
  test("preserves completed artifacts on inspection timeout and holds learned output paths until verified cleanup", async () => {
    const cleanup = Promise.withResolvers<void>();
    const checkpoint = vi.fn();
    const settle = vi
      .fn()
      .mockRejectedValueOnce(
        new executionRecovery.ProcessInspectionTimeoutError(),
      )
      .mockImplementation(() => cleanup.promise);
    vi.spyOn(executionRecovery, "withExecutionJournal").mockImplementation(
      async (_identity, task) =>
        task({
          cleanupProcesses: settle,
          settle,
          checkpointCompletion: checkpoint,
        }),
    );
    vi.spyOn(executionRecovery, "recoverExecution").mockResolvedValue();
    const coordinator = new RepositoryCoordinator();
    const api = {
      claimJob: vi.fn(async () => claimed),
      completeJob: vi.fn().mockResolvedValue({}),
    };
    const claimed: AgentJob = {
      ...job,
      kind: "ios.build.run",
      executionToken: "owner",
      operationResources: { version: 1, resources: [] },
    };
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      artifacts: [{ kind: "RUNNABLE_APP", relativePath: "products/App.app" }],
    };
    let buildSignal: AbortSignal | undefined;
    vi.mocked(handlers["ios.build.run"]!).mockImplementation(
      async (_payload, _timeout, signal, _onLog, context) => {
        buildSignal = signal;
        return context!.withOperationResources!(
          [{ kind: "WORKTREE", key: "learned-output", mode: "WRITE" }],
          async () => {
            await context!.finalizeBuildResult!(result);
            return result;
          },
        );
      },
    );
    const executor = new JobExecutor(
      api as unknown as AgentGraphQLClient,
      coordinator,
    );
    executor.execute(claimed);
    await vi.waitFor(() =>
      expect(api.completeJob).toHaveBeenCalledWith(
        job.id,
        "SUCCEEDED",
        expect.objectContaining({
          artifacts: result.artifacts,
          warnings: [expect.stringContaining("30 seconds")],
        }),
        undefined,
        "owner",
        false,
      ),
    );
    const writer = vi.fn(async () => undefined);
    const waiting = coordinator.withResources(
      [{ kind: "WORKTREE", key: "learned-output", mode: "WRITE" }],
      writer,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writer).not.toHaveBeenCalled();
    expect(executor.cancel(job.id)).toBe(true);
    expect(buildSignal?.aborted).toBe(false);
    cleanup.resolve();
    await waiting;
    await vi.waitFor(() =>
      expect(api.completeJob).toHaveBeenLastCalledWith(
        job.id,
        "SUCCEEDED",
        result,
        undefined,
        "owner",
      ),
    );
    expect(checkpoint).toHaveBeenCalled();
    expect(handlers["ios.build.run"]).toHaveBeenCalledOnce();
    await executor.cancelAll();
  });

  test("recovers a durable completed build checkpoint instead of replacing it with an interrupted failure", async () => {
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      artifacts: [{ kind: "RUNNABLE_APP", relativePath: "App.app" }],
    };
    vi.spyOn(executionRecovery, "executionCompletion").mockReturnValue({
      status: "SUCCEEDED",
      result,
    });
    vi.spyOn(executionRecovery, "recoverExecution").mockResolvedValue();
    const api = { completeJob: vi.fn().mockResolvedValue({}) };
    const executor = new JobExecutor(api as unknown as AgentGraphQLClient);
    await executor.recover(
      {
        ...job,
        kind: "ios.build.run",
        status: "RUNNING",
        executionToken: "owner",
        operationResources: { version: 1, resources: [] },
      },
      "FAILED",
      true,
    );
    expect(api.completeJob).toHaveBeenCalledWith(
      job.id,
      "SUCCEEDED",
      result,
      undefined,
      "owner",
    );
    await executor.cancelAll();
  });
  test("keeps legacy builds on their original completion path without cleanup checkpoints", async () => {
    const legacy = {
      ...job,
      kind: "ios.build.run",
      payload: { codebaseId: "legacy-codebase" },
    };
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
    const journal = vi.spyOn(executionRecovery, "withExecutionJournal");
    const handler = vi.mocked(handlers["ios.build.run"]!).mockReset();
    handler.mockImplementation(
      async (_payload, _timeout, _signal, _log, context) => {
        expect(context?.finalizeBuildResult).toBeUndefined();
        return result;
      },
    );
    const api = {
      claimJob: vi.fn().mockResolvedValue(legacy),
      completeJob: vi.fn().mockResolvedValue({}),
    };
    const executor = new JobExecutor(api as unknown as AgentGraphQLClient);
    executor.execute(legacy);
    await vi.waitFor(() =>
      expect(api.completeJob).toHaveBeenCalledWith(
        job.id,
        "SUCCEEDED",
        result,
        undefined,
      ),
    );
    expect(journal).not.toHaveBeenCalled();
    await executor.cancelAll();
  });
  test("keeps recovery resources until subprocess cleanup and acknowledgement finish", async () => {
    const cleanup = Promise.withResolvers<void>();
    vi.spyOn(executionRecovery, "recoverExecution").mockImplementation(
      () => cleanup.promise,
    );
    const api = { completeJob: vi.fn().mockResolvedValue({}) };
    const coordinator = new RepositoryCoordinator();
    const executor = new JobExecutor(
      api as unknown as AgentGraphQLClient,
      coordinator,
    );
    const resource = {
      kind: "WORKTREE" as const,
      key: "a",
      mode: "BUILD" as const,
      agentId: "agent-1",
      codebaseId: "repo",
    };
    const interrupted: AgentJob = {
      ...job,
      status: "TIMED_OUT",
      executionToken: "recovery-token",
      operationResources: { version: 1, resources: [resource] },
    };
    await executor.recover(interrupted, "TIMED_OUT");
    const sameSource = vi.fn(async () => "safe after cleanup");
    const waiting = coordinator.withResources(
      [{ ...resource, mode: "WRITE" }],
      sameSource,
    );
    await expect(
      coordinator.withResources(
        [{ ...resource, key: "b", mode: "WRITE" }],
        async () => "sibling",
      ),
    ).resolves.toBe("sibling");
    expect(sameSource).not.toHaveBeenCalled();
    expect(api.completeJob).not.toHaveBeenCalled();
    cleanup.resolve();
    await waiting;
    expect(api.completeJob).toHaveBeenCalledWith(
      job.id,
      "TIMED_OUT",
      undefined,
      expect.stringContaining("verified"),
      "recovery-token",
    );
    await executor.cancelAll();
  });

  test("refuses to run when granted resources differ from its local reservation", async () => {
    const queued: AgentJob = {
      ...job,
      kind: "worktree.auto-sync",
      operationResources: {
        version: 1,
        resources: [{ kind: "WORKTREE", key: "a", mode: "WRITE" }],
      },
    };
    const claimed = {
      ...queued,
      executionToken: "changed-resource-token",
      operationResources: {
        version: 1,
        resources: [{ kind: "WORKTREE", key: "b", mode: "WRITE" }],
      },
    };
    const api = {
      claimJob: vi.fn().mockResolvedValue(claimed),
      completeJob: vi.fn().mockResolvedValue({}),
    };
    const handler = vi.mocked(handlers["worktree.auto-sync"]!);
    handler.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const executor = new JobExecutor(api as unknown as AgentGraphQLClient);
    executor.execute(queued);
    await vi.waitFor(() =>
      expect(api.completeJob).toHaveBeenCalledWith(
        job.id,
        "FAILED",
        undefined,
        expect.stringContaining("resources changed"),
        "changed-resource-token",
      ),
    );
    expect(handler).not.toHaveBeenCalled();
    await executor.cancelAll();
  });
  test("reserves resources before claiming and runs sibling build/sync jobs concurrently", async () => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
    const resourceJob = (
      id: string,
      kind: string,
      target: string,
      mode: "BUILD" | "WRITE",
    ): AgentJob => ({
      ...job,
      id,
      kind,
      payload: { codebaseId: "repo", folder: `/${target}` },
      operationResources: {
        version: 1,
        resources: [
          {
            kind: "WORKTREE",
            key: target,
            mode,
            agentId: "agent-1",
            codebaseId: "repo",
          },
        ],
      },
    });
    const first = resourceJob("first", "ios.build.run", "a", "BUILD");
    const sibling = resourceJob("sibling", "ios.build.run", "b", "BUILD");
    const blocked = resourceJob("blocked", "worktree.auto-sync", "a", "WRITE");
    const sync = resourceJob("sync", "worktree.auto-sync", "c", "WRITE");
    const jobs = new Map(
      [first, sibling, blocked, sync].map((entry) => [entry.id, entry]),
    );
    vi.mocked(handlers["ios.build.run"]!).mockImplementation(
      async (payload) => {
        if ((payload as { folder: string }).folder === "/a") {
          started.resolve();
          await finish.promise;
        }
        return result;
      },
    );
    vi.mocked(handlers["worktree.auto-sync"]!).mockResolvedValue(result);
    const api = {
      claimJob: vi.fn(async (id: string, executionToken: string) => ({
        ...jobs.get(id),
        executionToken,
      })),
      completeJob: vi.fn().mockResolvedValue({}),
    };
    const executor = new JobExecutor(api as unknown as AgentGraphQLClient);
    try {
      executor.execute(first);
      await started.promise;
      executor.execute(blocked);
      executor.execute(sibling);
      executor.execute(sync);
      await vi.waitFor(() => expect(api.completeJob).toHaveBeenCalledTimes(2));
      expect(api.claimJob.mock.calls.map(([id]) => id)).toEqual([
        "first",
        "sibling",
        "sync",
      ]);
      expect(api.completeJob).toHaveBeenCalledWith(
        "sibling",
        "SUCCEEDED",
        result,
        undefined,
        expect.any(String),
      );
      finish.resolve();
      await vi.waitFor(() => expect(api.completeJob).toHaveBeenCalledTimes(4));
      expect(api.claimJob.mock.calls.map(([id]) => id)).toEqual([
        "first",
        "sibling",
        "sync",
        "blocked",
      ]);
    } finally {
      finish.resolve();
      await executor.cancelAll();
    }
  });

  test("leaves a resource-busy claim queued without running or completing it", async () => {
    const api = {
      claimJob: vi
        .fn()
        .mockRejectedValue(
          new AgentRequestError("Another operation owns these resources", 200, [
            "RESOURCE_BUSY",
          ]),
        ),
      completeJob: vi.fn(),
    };
    const handler = vi.mocked(handlers["worktree.auto-sync"]!);
    handler.mockClear();
    const reportError = vi.spyOn(console, "error").mockImplementation(() => {});
    const executor = new JobExecutor(api as unknown as AgentGraphQLClient);
    executor.execute({
      ...job,
      kind: "worktree.auto-sync",
      operationResources: { version: 1, resources: [] },
    });
    await vi.waitFor(() => expect(api.claimJob).toHaveBeenCalledOnce());
    await executor.cancelAll();
    expect(handler).not.toHaveBeenCalled();
    expect(api.completeJob).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  test.each([
    "worktree.inspect",
    "worktree.diff.inspect",
    "worktree.git.inspect",
    "codebase.git.inspect",
    "worktree.diff.asset",
  ])(
    "runs %s during a build with a mutation waiting behind it",
    async (kind) => {
      const buildStarted = Promise.withResolvers<void>();
      const finishBuild = Promise.withResolvers<void>();
      const result = {
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      };
      const build: AgentJob = {
        ...job,
        id: "build-1",
        kind: "ios.build.run",
        payload: { codebaseId: "checkout", folder: "/repo" },
      };
      const mutation: AgentJob = {
        ...build,
        id: "mutation-1",
        kind: "codebase.branches.delete",
      };
      const inspection: AgentJob = { ...build, id: "inspection-1", kind };
      const jobs = new Map(
        [build, mutation, inspection].map((entry) => [entry.id, entry]),
      );
      vi.mocked(handlers[build.kind]!).mockImplementation(async () => {
        buildStarted.resolve();
        await finishBuild.promise;
        return result;
      });
      const mutate = vi.mocked(handlers[mutation.kind]!);
      mutate.mockClear().mockResolvedValue(result);
      vi.mocked(handlers[kind]!).mockResolvedValue(result);
      const api = {
        claimJob: vi.fn(async (id: string) => jobs.get(id)),
        completeJob: vi.fn().mockResolvedValue({}),
      };
      const coordinator = new RepositoryCoordinator();
      const queuedMutation = vi.spyOn(coordinator, "run");
      const executor = new JobExecutor(
        api as unknown as AgentGraphQLClient,
        coordinator,
      );
      try {
        executor.execute(build);
        await buildStarted.promise;
        executor.execute(mutation);
        await vi.waitFor(() => expect(queuedMutation).toHaveBeenCalledOnce());
        executor.execute(inspection);
        await vi.waitFor(() => {
          expect(api.completeJob).toHaveBeenCalledWith(
            inspection.id,
            "SUCCEEDED",
            result,
            undefined,
          );
        });
        expect(mutate).not.toHaveBeenCalled();
        expect(api.completeJob).toHaveBeenCalledOnce();

        finishBuild.resolve();
        await vi.waitFor(() => {
          expect(api.completeJob).toHaveBeenCalledWith(
            mutation.id,
            "SUCCEEDED",
            result,
            undefined,
          );
        });
      } finally {
        finishBuild.resolve();
        await executor.cancelAll();
      }
    },
  );

  test.each([
    "worktree.inspect",
    "worktree.diff.inspect",
    "worktree.git.inspect",
    "codebase.git.inspect",
    "worktree.diff.asset",
  ])("runs %s without waiting for background reconciliation", async (kind) => {
    const coordinator = new RepositoryCoordinator();
    const reconciliationStarted = Promise.withResolvers<void>();
    const finishReconciliation = Promise.withResolvers<void>();
    const reconciliation = coordinator.runReconciliation(
      "checkout",
      async () => {
        reconciliationStarted.resolve();
        await finishReconciliation.promise;
      },
    );
    await reconciliationStarted.promise;
    const inspection = {
      ...job,
      kind,
      payload: { codebaseId: "checkout", folder: "/repo" },
    };
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
    vi.mocked(handlers[kind]!).mockResolvedValue(result);
    const api = {
      claimJob: vi.fn().mockResolvedValue(inspection),
      completeJob: vi.fn().mockResolvedValue({}),
    };
    const executor = new JobExecutor(
      api as unknown as AgentGraphQLClient,
      coordinator,
    );
    try {
      executor.execute(inspection);
      await vi.waitFor(() => {
        expect(api.completeJob).toHaveBeenCalledWith(
          inspection.id,
          "SUCCEEDED",
          result,
          undefined,
        );
      });
    } finally {
      finishReconciliation.resolve();
      await reconciliation;
      await executor.cancelAll();
    }
  });

  test("shutdown cancels a queued job without waiting for background reconciliation", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const coordinator = new RepositoryCoordinator();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const reconciliation = coordinator.runReconciliation(
      "checkout",
      async () => {
        started.resolve();
        await finish.promise;
      },
    );
    await started.promise;
    const queued = vi.spyOn(coordinator, "run");
    const cleanupJob = {
      ...job,
      kind: "codebase.branches.delete",
      payload: { codebaseId: "checkout", folder: "/repo" },
    };
    const handler = vi.mocked(handlers[cleanupJob.kind]!);
    handler.mockClear();
    const api = {
      claimJob: vi.fn().mockResolvedValue(cleanupJob),
      completeJob: vi.fn().mockResolvedValue({}),
    };
    const executor = new JobExecutor(
      api as unknown as AgentGraphQLClient,
      coordinator,
    );
    let shutdown: Promise<void> | undefined;
    try {
      executor.execute(cleanupJob);
      await vi.waitFor(() => expect(queued).toHaveBeenCalledOnce());
      shutdown = executor.cancelAll();
      await vi.waitFor(() => {
        expect(api.completeJob).toHaveBeenCalledWith(
          cleanupJob.id,
          "CANCELLED",
          undefined,
          expect.any(String),
        );
      });
      await shutdown;
      expect(handler).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await reconciliation;
      await (shutdown ?? executor.cancelAll());
    }
  });

  test("serializes cleanup with other operations on the same codebase while retaining per-branch results", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const cleanupJob = {
      ...job,
      kind: "codebase.branches.delete",
      payload: { codebaseId: "checkout", folder: "/repo" },
    };
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      branchDeletionResults: [
        {
          codebaseId: "checkout",
          branch: "old",
          outcome: "DELETED",
          reason: null,
        },
      ],
    };
    vi.mocked(handlers[cleanupJob.kind]!).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return result;
    });
    const api = {
      claimJob: vi.fn().mockResolvedValue(cleanupJob),
      completeJob: vi.fn(async () => complete.resolve()),
    };
    const coordinator = new RepositoryCoordinator();
    const executor = new JobExecutor(
      api as unknown as AgentGraphQLClient,
      coordinator,
    );
    executor.execute(cleanupJob);
    await entered.promise;
    const nextOperation = vi.fn(async () => {});
    const next = coordinator.run("checkout", nextOperation);
    await Promise.resolve();
    expect(nextOperation).not.toHaveBeenCalled();
    release.resolve();
    await complete.promise;
    await next;
    expect(api.completeJob).toHaveBeenCalledWith(
      cleanupJob.id,
      "SUCCEEDED",
      result,
      undefined,
    );
    await executor.cancelAll();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("retains completion beyond five failures without rerunning a reconciled job", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
    const fetchJob = { ...job, kind: "codebase.fetch" };
    const handler = vi.mocked(handlers[fetchJob.kind]!);
    handler.mockClear().mockResolvedValue(result);
    const client = {
      claimJob: vi.fn().mockResolvedValue(fetchJob),
      completeJob: vi.fn().mockRejectedValue(new Error("offline")),
    };
    const executor = new JobExecutor(client as unknown as AgentGraphQLClient);
    executor.execute(fetchJob);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.completeJob).toHaveBeenCalledTimes(5);
    executor.execute({ ...fetchJob, status: "RUNNING" });
    expect(client.claimJob).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledOnce();

    client.completeJob.mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(16_000);
    expect(client.completeJob).toHaveBeenCalledTimes(6);
    expect(client.completeJob).toHaveBeenLastCalledWith(
      job.id,
      "SUCCEEDED",
      result,
      undefined,
    );
    expect(executor.cancel(job.id)).toBe(false);
    await executor.cancelAll();
  });

  test("stops immediately when the server permanently rejects completion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const complete = Promise.withResolvers<void>();
    const client = {
      claimJob: vi.fn().mockResolvedValue(job),
      completeJob: vi.fn(async () => {
        complete.resolve();
        throw new AgentRequestError("Job not found for this agent", 200);
      }),
    };
    const executor = new JobExecutor(client as unknown as AgentGraphQLClient);
    executor.execute(job);
    await complete.promise;
    await executor.cancelAll();
    expect(client.completeJob).toHaveBeenCalledOnce();
  });

  test("shutdown interrupts completion backoff without another request", async () => {
    vi.useFakeTimers();
    const waiting = Promise.withResolvers<void>();
    vi.spyOn(console, "error").mockImplementation((message) => {
      if (String(message).includes("retrying:")) waiting.resolve();
    });
    const client = {
      claimJob: vi.fn().mockResolvedValue(job),
      completeJob: vi.fn().mockRejectedValue(new Error("offline")),
    };
    const executor = new JobExecutor(client as unknown as AgentGraphQLClient);
    executor.execute(job);
    await waiting.promise;
    await executor.cancelAll();
    expect(client.completeJob).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("retries transient completion errors without rerunning the handler", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
    const fetchJob = { ...job, kind: "codebase.fetch" };
    vi.mocked(handlers[fetchJob.kind]!).mockResolvedValue(result);
    const client = {
      claimJob: vi.fn().mockResolvedValue(fetchJob),
      completeJob: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({}),
    };
    const executor = new JobExecutor(client as unknown as AgentGraphQLClient);
    executor.execute(fetchJob);
    await vi.runAllTimersAsync();
    expect(client.claimJob).toHaveBeenCalledOnce();
    expect(client.completeJob).toHaveBeenCalledTimes(2);
    expect(client.completeJob).toHaveBeenLastCalledWith(
      job.id,
      "SUCCEEDED",
      result,
      undefined,
    );
    await executor.cancelAll();
  });

  test("does not fail a job when claiming it has a transient error", async () => {
    // The transient path reports itself on stderr; capture it rather than
    // letting it interleave with the reporter output.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = {
      claimJob: vi.fn().mockRejectedValue(new Error("temporary HTTP failure")),
      completeJob: vi.fn(),
    } as unknown as AgentGraphQLClient;
    const executor = new JobExecutor(client);

    executor.execute(job);
    await executor.cancelAll();

    expect(client.claimJob).toHaveBeenCalledWith(job.id);
    expect(client.completeJob).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      `Could not claim job ${job.id}; durable reconciliation will retry:`,
      "temporary HTTP failure",
    );
  });

  test("holds the repository lock and delays completion until fetch inventory is persisted", async () => {
    const fetchJob: AgentJob = {
      ...job,
      kind: "codebase.fetch",
      payload: { codebaseId: "codebase-1", folder: "/repo" },
    };
    const refresh: FetchedCodebaseRefresh = {
      codebaseId: "codebase-1",
      fetchAttemptedAt: new Date().toISOString(),
      fetchError: null,
      snapshot: {
        folder: "/repo",
        observedOrigin: "git@example.com:team/repo.git",
        canonicalOrigin: "example.com/team/repo",
        displayOrigin: "example.com/team/repo",
        branch: "main",
        headSha: "abc",
        upstream: "origin/main",
        ahead: 0,
        behind: 1,
        syncState: "BEHIND",
        availability: "AVAILABLE",
        error: null,
        checkedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        linkedWorktree: false,
      },
    };
    vi.mocked(handlers["codebase.fetch"]!).mockImplementation(
      async (_payload, _timeout, _signal, _onLog, context) => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        worktreesRefreshedAt: await context!.refreshFetchedCodebase!(refresh),
      }),
    );
    vi.mocked(discoverWorktrees).mockResolvedValue({
      complete: true,
      defaultBranch: "main",
      localBranches: ["main"],
      remoteBranches: ["main"],
      worktrees: [],
    });
    const reportStarted = Promise.withResolvers<void>();
    const reportCompleted = Promise.withResolvers<unknown>();
    const completed = Promise.withResolvers<void>();
    const api = {
      claimJob: vi.fn().mockResolvedValue(fetchJob),
      agentCodebases: vi
        .fn()
        .mockResolvedValue([
          { id: "codebase-1", defaultBranch: "main", worktrees: [] },
        ]),
      reportCodebaseStatuses: vi.fn().mockResolvedValue({}),
      reportWorktrees: vi.fn(() => {
        reportStarted.resolve();
        return reportCompleted.promise;
      }),
      completeJob: vi.fn(async () => completed.resolve()),
    };
    const coordinator = new RepositoryCoordinator();
    const executor = new JobExecutor(
      api as unknown as AgentGraphQLClient,
      coordinator,
    );
    executor.execute(fetchJob);
    await reportStarted.promise;
    expect(api.reportCodebaseStatuses).toHaveBeenCalled();
    expect(api.completeJob).not.toHaveBeenCalled();
    const nextRepositoryOperation = vi.fn(async () => undefined);
    const next = coordinator.run("codebase-1", nextRepositoryOperation);
    await Promise.resolve();
    expect(nextRepositoryOperation).not.toHaveBeenCalled();
    reportCompleted.resolve({});
    await completed.promise;
    await next;
    expect(api.completeJob).toHaveBeenCalledWith(
      fetchJob.id,
      "SUCCEEDED",
      expect.objectContaining({ worktreesRefreshedAt: expect.any(String) }),
      undefined,
    );
    await executor.cancelAll();
  });
});
