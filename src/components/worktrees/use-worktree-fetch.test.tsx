import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import {
  useWorktreeFetch,
  type WorktreeFetchTarget,
} from "./use-worktree-fetch";

vi.mock("@/lib/control-plane-client", () => ({
  controlPlaneRequest: vi.fn(),
  controlPlaneSubscriptions: vi.fn(),
  onControlPlaneRecovery: vi.fn(() => vi.fn()),
}));

const request = vi.mocked(controlPlaneRequest);
type Job = ReturnType<typeof job>;
type JobSink = {
  next: (value: { data: { agentJobChanged: Job } }) => void;
  error: (value: unknown) => void;
  complete: () => void;
};
let sinks: Map<string, JobSink>;
let unsubscribers: Map<string, ReturnType<typeof vi.fn>>;
let currentJobs: Job[];
let skips: Array<{ codebaseId: string; reason: string }>;

function target(codebaseId = "codebase-1"): WorktreeFetchTarget {
  return {
    codebaseId,
    repositoryName: `Repository ${codebaseId}`,
    agentName: "Studio",
    folder: `/workspaces/${codebaseId}`,
  };
}

function job(
  codebaseId = "codebase-1",
  status = "QUEUED",
  second = 0,
  result: Record<string, unknown> | null = null,
  error: string | null = null,
) {
  return {
    id: `job-${codebaseId}`,
    agentId: "agent-1",
    payload: { codebaseId },
    status,
    error,
    result,
    updatedAt: new Date(second * 1_000).toISOString(),
  };
}

const freshResult = { worktreesRefreshedAt: new Date(3_000).toISOString() };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function queries() {
  return request.mock.calls.filter(([query]) =>
    query.includes("query WorktreeFetchJobs"),
  );
}
function submissions() {
  return request.mock.calls.filter(([query]) =>
    query.includes("mutation FetchWorktreeCodebases"),
  );
}
function legacyRefreshes() {
  return request.mock.calls.filter(([query]) =>
    query.includes("mutation RefreshWorktreesAfterFetch"),
  );
}
async function tick(milliseconds = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

describe("useWorktreeFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sinks = new Map();
    unsubscribers = new Map();
    currentJobs = [job()];
    skips = [];
    vi.mocked(controlPlaneSubscriptions)
      .mockReset()
      .mockReturnValue({
        subscribe: vi.fn((operation, sink) => {
          const id = operation.variables?.jobId as string;
          sinks.set(id, sink as JobSink);
          const unsubscribe = vi.fn();
          unsubscribers.set(id, unsubscribe);
          return unsubscribe;
        }),
      } as never);
    vi.mocked(onControlPlaneRecovery)
      .mockReset()
      .mockImplementation(() => vi.fn());
    request.mockReset().mockImplementation(async (query, variables) => {
      if (query.includes("mutation FetchWorktreeCodebases")) {
        const input = variables?.input as { codebaseIds: string[] };
        return {
          fetchCodebases: {
            jobs: currentJobs
              .filter((value) =>
                input.codebaseIds.includes(value.payload.codebaseId),
              )
              .toReversed(),
            skipped: skips.filter((value) =>
              input.codebaseIds.includes(value.codebaseId),
            ),
          },
        } as never;
      }
      if (query.includes("query WorktreeFetchJobs")) {
        return {
          agentJobsByIds: currentJobs.filter((value) =>
            (variables?.ids as string[]).includes(value.id),
          ),
        } as never;
      }
      if (query.includes("mutation RefreshWorktreesAfterFetch"))
        return { refreshWorktrees: 1 } as never;
      throw new Error(`Unexpected operation: ${query}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test("maps jobs to captured targets, keeps the button active until the page update, and ignores duplicate starts", async () => {
    currentJobs = [job("codebase-1"), job("codebase-2")];
    const pageUpdate = deferred<void>();
    const refreshPage = vi.fn(() => pageUpdate.promise);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => {
      await Promise.all([
        result.current.start([target(), target("codebase-2"), target()]),
        result.current.start([target()]),
      ]);
    });
    expect(submissions()).toHaveLength(1);
    expect(
      result.current.batch?.rows.map((row) => [row.codebaseId, row.jobId]),
    ).toEqual([
      ["codebase-1", "job-codebase-1"],
      ["codebase-2", "job-codebase-2"],
    ]);
    expect(result.current.active).toBe(true);
    expect(refreshPage).not.toHaveBeenCalled();
    act(() => {
      sinks
        .get("job-codebase-1")!
        .next({ data: { agentJobChanged: job("codebase-1", "RUNNING", 1) } });
      sinks.get("job-codebase-2")!.next({
        data: {
          agentJobChanged: job("codebase-2", "SUCCEEDED", 2, freshResult),
        },
      });
    });
    expect(result.current.batch?.rows.map((row) => row.status)).toEqual([
      "RUNNING",
      "SUCCEEDED",
    ]);
    expect(refreshPage).not.toHaveBeenCalled();
    act(() =>
      sinks.get("job-codebase-1")!.next({
        data: {
          agentJobChanged: job("codebase-1", "SUCCEEDED", 3, freshResult),
        },
      }),
    );
    expect(result.current.batch?.phase).toBe("refreshing");
    expect(result.current.active).toBe(true);
    expect(refreshPage).toHaveBeenCalledTimes(1);
    expect(legacyRefreshes()).toHaveLength(0);
    await act(async () => pageUpdate.resolve());
    expect(result.current.batch?.phase).toBe("finished");
    expect(result.current.active).toBe(false);
    act(() => result.current.dismiss());
    expect(result.current.batch).toBeNull();
  });

  test("keeps cancelling jobs pending and retains failures, cancellation, timeouts, skips and missing outcomes", async () => {
    currentJobs = [job(), job("codebase-2"), job("codebase-3")];
    skips = [{ codebaseId: "codebase-4", reason: "OFFLINE" }];
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () =>
      result.current.start(
        Array.from({ length: 5 }, (_, index) =>
          target(`codebase-${index + 1}`),
        ),
      ),
    );
    act(() => {
      sinks.get("job-codebase-1")!.next({
        data: { agentJobChanged: job("codebase-1", "CANCELLING", 1) },
      });
      sinks.get("job-codebase-2")!.next({
        data: {
          agentJobChanged: job(
            "codebase-2",
            "FAILED",
            1,
            { snapshot: { error: "Authentication failed" } },
            "Process exited with code 128",
          ),
        },
      });
      sinks
        .get("job-codebase-3")!
        .next({ data: { agentJobChanged: job("codebase-3", "TIMED_OUT", 1) } });
    });
    expect(refreshPage).not.toHaveBeenCalled();
    expect(result.current.batch?.rows.map((row) => row.status)).toEqual([
      "CANCELLING",
      "FAILED",
      "TIMED_OUT",
      "SKIPPED",
      "UNREPORTED",
    ]);
    expect(result.current.batch?.rows[1]?.error).toBe("Authentication failed");
    expect(result.current.batch?.rows[3]?.skipReason).toBe("OFFLINE");
    await act(async () =>
      sinks
        .get("job-codebase-1")!
        .next({ data: { agentJobChanged: job("codebase-1", "CANCELLED", 2) } }),
    );
    expect(refreshPage).toHaveBeenCalledTimes(1);
    expect(result.current.batch?.phase).toBe("finished");
    expect(legacyRefreshes()).toHaveLength(0);
  });

  test("reconciles missed events immediately, every two seconds and on recovery", async () => {
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start([target()]));
    expect(queries()).toHaveLength(1);
    currentJobs = [job("codebase-1", "RUNNING", 1)];
    await tick(2_000);
    expect(result.current.batch?.rows[0]?.status).toBe("RUNNING");
    currentJobs = [job("codebase-1", "SUCCEEDED", 2, freshResult)];
    await act(async () =>
      vi.mocked(onControlPlaneRecovery).mock.calls[0]![0](),
    );
    expect(refreshPage).toHaveBeenCalledTimes(1);
    expect(result.current.batch?.phase).toBe("finished");
    expect(unsubscribers.get("job-codebase-1")).toHaveBeenCalledTimes(1);
    const count = queries().length;
    await tick(10_000);
    expect(queries()).toHaveLength(count);
  });

  test("ignores stale status snapshots and duplicate terminal events", async () => {
    currentJobs = [job(), job("codebase-2")];
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () =>
      result.current.start([target(), target("codebase-2")]),
    );
    const latePoll = deferred<{ agentJobsByIds: Job[] }>();
    request.mockImplementationOnce(() => latePoll.promise as never);
    await tick(2_000);
    act(() =>
      sinks.get("job-codebase-1")!.next({
        data: {
          agentJobChanged: job("codebase-1", "SUCCEEDED", 3, freshResult),
        },
      }),
    );
    act(() =>
      sinks.get("job-codebase-2")!.next({
        data: { agentJobChanged: job("codebase-2", "CANCELLING", 3) },
      }),
    );
    await act(async () =>
      latePoll.resolve({
        agentJobsByIds: [
          job("codebase-1", "RUNNING", 2),
          job("codebase-2", "RUNNING", 4),
        ],
      }),
    );
    expect(result.current.batch?.rows.map((row) => row.status)).toEqual([
      "SUCCEEDED",
      "CANCELLING",
    ]);
    await act(async () => {
      sinks
        .get("job-codebase-2")!
        .next({ data: { agentJobChanged: job("codebase-2", "CANCELLED", 5) } });
      sinks
        .get("job-codebase-2")!
        .next({ data: { agentJobChanged: job("codebase-2", "CANCELLED", 5) } });
    });
    expect(refreshPage).toHaveBeenCalledTimes(1);
    expect(result.current.batch?.phase).toBe("finished");
  });

  test("surfaces monitoring failures and missing job records without inventing job failures", async () => {
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start([target()]));
    request.mockRejectedValueOnce(new Error("Connection lost"));
    await tick(2_000);
    expect(result.current.batch?.monitoringError).toBe("Connection lost");
    expect(result.current.batch?.rows[0]?.status).toBe("QUEUED");
    currentJobs = [];
    await tick(2_000);
    expect(result.current.batch?.monitoringError).toBeNull();
    expect(result.current.batch?.monitoringMissingJobs).toBe(1);
    expect(result.current.active).toBe(true);
    expect(refreshPage).not.toHaveBeenCalled();
    currentJobs = [job("codebase-1", "SUCCEEDED", 3, freshResult)];
    await tick(2_000);
    expect(result.current.batch?.monitoringMissingJobs).toBe(0);
    expect(result.current.batch?.phase).toBe("finished");
  });

  test("chunks submission at 500 and polling at 200 while preserving every target", async () => {
    const targets = Array.from({ length: 502 }, (_, index) =>
      target(`codebase-${index + 1}`),
    );
    currentJobs = targets.map((value) => job(value.codebaseId));
    const { result } = renderHook(() =>
      useWorktreeFetch({ refreshPage: async () => undefined }),
    );
    await act(async () => result.current.start(targets));
    await tick();
    expect(
      submissions().map(
        ([, variables]) =>
          (variables?.input as { codebaseIds: string[] }).codebaseIds.length,
      ),
    ).toEqual([500, 2]);
    expect(
      queries().map(([, variables]) => (variables?.ids as string[]).length),
    ).toEqual([200, 200, 102]);
    expect(result.current.batch?.rows).toHaveLength(502);
    expect(
      result.current.batch?.rows.every(
        (row) => row.jobId === `job-${row.codebaseId}`,
      ),
    ).toBe(true);
  });

  test("reports submission failures and all-skipped batches without waiting for nonexistent jobs", async () => {
    const refreshPage = vi.fn(async () => undefined);
    request.mockRejectedValueOnce(new Error("Submission unavailable"));
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start([target()]));
    expect(result.current.batch?.rows[0]).toMatchObject({
      status: "SUBMISSION_FAILED",
      error: "Submission unavailable",
    });
    expect(result.current.batch?.phase).toBe("finished");
    currentJobs = [];
    skips = [{ codebaseId: "codebase-1", reason: "ACTIVE_OPERATION" }];
    await act(async () => result.current.start([target()]));
    expect(result.current.batch?.rows[0]?.status).toBe("SKIPPED");
    expect(result.current.batch?.phase).toBe("finished");
    expect(refreshPage).toHaveBeenCalledTimes(2);
    expect(queries()).toHaveLength(0);
  });

  test("requests one legacy inventory refresh and preserves its warning when page update is retried", async () => {
    currentJobs = [job("codebase-1", "SUCCEEDED", 1)];
    const refreshPage = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Overview unavailable"))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start([target()]));
    expect(result.current.batch?.phase).toBe("refreshFailed");
    expect(result.current.batch?.legacyRefreshRequested).toBe(true);
    expect(result.current.batch?.pageUpdateError).toBe("Overview unavailable");
    expect(result.current.active).toBe(false);
    await act(async () =>
      Promise.all([
        result.current.retryPageUpdate(),
        result.current.retryPageUpdate(),
      ]),
    );
    expect(result.current.batch?.phase).toBe("finished");
    expect(result.current.batch?.pageUpdateError).toBeNull();
    expect(legacyRefreshes()).toHaveLength(1);
    expect(submissions()).toHaveLength(1);
    expect(refreshPage).toHaveBeenCalledTimes(2);
  });

  test("retains agent inventory errors and does not treat them as legacy responses", async () => {
    currentJobs = [
      job("codebase-1", "SUCCEEDED", 1, {
        worktreeRefreshError: "Inventory could not be reported",
      }),
    ];
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start([target()]));
    expect(result.current.batch?.rows[0]?.worktreeRefreshError).toBe(
      "Inventory could not be reported",
    );
    expect(legacyRefreshes()).toHaveLength(0);
    expect(result.current.batch?.phase).toBe("finished");
  });

  test("retains a failed legacy refresh request while still updating the overview", async () => {
    currentJobs = [job("codebase-1", "SUCCEEDED", 1)];
    const implementation = request.getMockImplementation()!;
    request.mockImplementation((query, variables, options) => {
      if (query.includes("mutation RefreshWorktreesAfterFetch"))
        return Promise.reject(new Error("Agent refresh unavailable"));
      return implementation(query, variables, options);
    });
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start([target()]));
    expect(result.current.batch?.phase).toBe("finished");
    expect(result.current.batch?.legacyRefreshError).toBe(
      "Agent refresh unavailable",
    );
    expect(refreshPage).toHaveBeenCalledTimes(1);
  });

  test("continues tracking accepted chunks when another submission chunk fails", async () => {
    const targets = Array.from({ length: 501 }, (_, index) =>
      target(`codebase-${index + 1}`),
    );
    currentJobs = [job("codebase-501")];
    request.mockRejectedValueOnce(new Error("First batch unavailable"));
    const refreshPage = vi.fn(async () => undefined);
    const { result } = renderHook(() => useWorktreeFetch({ refreshPage }));
    await act(async () => result.current.start(targets));
    expect(
      result.current.batch?.rows.filter(
        (row) => row.status === "SUBMISSION_FAILED",
      ),
    ).toHaveLength(500);
    expect(result.current.batch?.rows[500]?.status).toBe("QUEUED");
    expect(refreshPage).not.toHaveBeenCalled();
    await act(async () =>
      sinks.get("job-codebase-501")!.next({
        data: {
          agentJobChanged: job("codebase-501", "SUCCEEDED", 2, freshResult),
        },
      }),
    );
    expect(result.current.batch?.phase).toBe("finished");
    expect(refreshPage).toHaveBeenCalledTimes(1);
  });

  test("aborts monitoring and ignores late events on scope changes and unmount without cancelling jobs", async () => {
    const refreshPage = vi.fn(async () => undefined);
    const view = renderHook(
      ({ scopeKey }) => useWorktreeFetch({ scopeKey, refreshPage }),
      { initialProps: { scopeKey: "app-a" } },
    );
    await act(async () => view.result.current.start([target()]));
    const latePoll = deferred<{ agentJobsByIds: Job[] }>();
    request.mockImplementationOnce(() => latePoll.promise as never);
    await tick(2_000);
    const signal = queries().at(-1)![2]!.signal!;
    const previousSink = sinks.get("job-codebase-1")!;
    view.rerender({ scopeKey: "app-b" });
    expect(signal.aborted).toBe(true);
    expect(unsubscribers.get("job-codebase-1")).toHaveBeenCalledTimes(1);
    expect(view.result.current.batch).toBeNull();
    await act(async () => {
      previousSink.next({
        data: {
          agentJobChanged: job("codebase-1", "SUCCEEDED", 2, freshResult),
        },
      });
      latePoll.resolve({
        agentJobsByIds: [job("codebase-1", "SUCCEEDED", 2, freshResult)],
      });
    });
    expect(refreshPage).not.toHaveBeenCalled();
    view.rerender({ scopeKey: "app-a" });
    expect(view.result.current.batch).toBeNull();
    expect(view.result.current.active).toBe(false);
    currentJobs = [job("codebase-2")];
    await act(async () => view.result.current.start([target("codebase-2")]));
    const latestRecoveryCleanup = vi
      .mocked(onControlPlaneRecovery)
      .mock.results.at(-1)!.value;
    view.unmount();
    expect(unsubscribers.get("job-codebase-2")).toHaveBeenCalledTimes(1);
    expect(latestRecoveryCleanup).toHaveBeenCalledTimes(1);
    const count = request.mock.calls.length;
    await tick(10_000);
    expect(request.mock.calls).toHaveLength(count);
    expect(
      request.mock.calls.some(([query]) => query.includes("cancelAgentJob")),
    ).toBe(false);
  });

  test("ignores submission and final-refresh continuations from a previous scope", async () => {
    const pendingSubmission = deferred<unknown>();
    request.mockImplementationOnce(() => pendingSubmission.promise as never);
    const refreshPage = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const view = renderHook(
      ({ scopeKey }) => useWorktreeFetch({ scopeKey, refreshPage }),
      { initialProps: { scopeKey: "app-a" } },
    );
    let submitting!: Promise<void>;
    act(() => {
      submitting = view.result.current.start([target()]);
    });
    view.rerender({ scopeKey: "app-b" });
    await act(async () => {
      pendingSubmission.resolve({
        fetchCodebases: {
          jobs: [job("codebase-1", "SUCCEEDED", 1, freshResult)],
          skipped: [],
        },
      });
      await submitting;
    });
    expect(refreshPage).not.toHaveBeenCalled();
    expect(view.result.current.batch).toBeNull();

    const pendingPage = deferred<void>();
    refreshPage.mockImplementationOnce(() => pendingPage.promise);
    currentJobs = [job("codebase-1", "SUCCEEDED", 1, freshResult)];
    await act(async () => view.result.current.start([target()]));
    expect(view.result.current.batch?.phase).toBe("refreshing");
    view.rerender({ scopeKey: "app-c" });
    await act(async () => pendingPage.resolve());
    expect(view.result.current.batch).toBeNull();
  });
});
