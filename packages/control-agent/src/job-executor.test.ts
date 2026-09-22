import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("./handlers/index.js", () => ({
  handlers: { "codebase.fetch": vi.fn() },
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

const job: AgentJob = {
  id: "job-1",
  agentId: "agent-1",
  kind: "ccusage.report",
  payload: {},
  status: "QUEUED",
  timeoutSeconds: 60,
};

describe("JobExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
