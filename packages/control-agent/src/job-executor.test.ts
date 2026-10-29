import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./handlers/index.js", () => ({
  handlers: { "codebase.fetch": vi.fn(), "codebase.branches.delete": vi.fn() },
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

const job: AgentJob = {
  id: "job-1",
  agentId: "agent-1",
  kind: "ccusage.report",
  payload: {},
  status: "QUEUED",
  timeoutSeconds: 60,
};

describe("JobExecutor", () => {
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
