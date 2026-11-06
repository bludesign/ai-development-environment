import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  clearMergeOperation,
  githubMergeOperationKey,
  recordMergeOperationProgress,
  recordPostMergeSwitch,
  reportMergeOperationError,
  runMergeOperation,
  useMergeOperation,
} from "./merge-operation-state";
import { trackPostMergeSwitch } from "./post-merge-switch-client";

vi.mock("@/lib/control-plane-client", () => ({ controlPlaneRequest: vi.fn() }));
const request = vi.mocked(controlPlaneRequest);
const target = {
  provider: "github" as const,
  owner: "org",
  name: "repo",
  number: 9,
};
const key = githubMergeOperationKey({
  repositoryNameWithOwner: "org/repo",
  number: 9,
});
const pending = { branch: "main", state: "PENDING", lastError: null };
const completed = { ...pending, state: "COMPLETED" };

afterEach(() => {
  cleanup();
  recordMergeOperationProgress(key, false, null);
  recordPostMergeSwitch(key, completed);
  clearMergeOperation(key);
  request.mockReset();
  vi.useRealTimers();
});

test("restores a merge already in progress before its checkout follow-up starts", async () => {
  vi.useFakeTimers();
  request
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "MERGING",
        postMergeSwitch: pending,
      },
    } as never)
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "COMPLETED",
        postMergeSwitch: completed,
      },
    } as never);
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
  });
  expect(view.result.current.pending).toBe(true);
  expect(view.result.current.postMergeSwitch).toBeUndefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await watch;
  });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.postMergeSwitch).toEqual(completed);
});

test.each(["SYNCING", "WAITING_CI", "WAITING_REQUIREMENTS"])(
  "continues observing %s after a transient polling failure",
  async (state) => {
    vi.useFakeTimers();
    request
      .mockResolvedValueOnce({
        githubPullRequestMergeOperation: { state, postMergeSwitch: pending },
      } as never)
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({
        githubPullRequestMergeOperation: {
          state: "COMPLETED",
          postMergeSwitch: completed,
        },
      } as never);
    const view = renderHook(() => useMergeOperation(key));
    let watch!: Promise<void>;
    await act(async () => {
      watch = trackPostMergeSwitch(key, target);
    });
    expect(view.result.current.pending).toBe(false);
    expect(view.result.current.postMergeSwitch).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
      await watch;
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(view.result.current.postMergeSwitch).toEqual(completed);
    expect(view.result.current.error).toBeNull();
  },
);

test("reports repeated polling failures while auto-merge waits for CI", async () => {
  vi.useFakeTimers();
  request
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "WAITING_CI",
        postMergeSwitch: pending,
      },
    } as never)
    .mockRejectedValue(new Error("Connection lost"));
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
    await watch;
  });
  expect(request).toHaveBeenCalledTimes(4);
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.error).toBe("Connection lost");
});

test("retries an initial recovery failure before the coordinator is known", async () => {
  vi.useFakeTimers();
  request
    .mockRejectedValueOnce(new Error("Connection lost"))
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "WAITING_CI",
        postMergeSwitch: pending,
      },
    } as never)
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "COMPLETED",
        postMergeSwitch: completed,
      },
    } as never);
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
    await watch;
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(view.result.current.postMergeSwitch).toEqual(completed);
  expect(view.result.current.error).toBeNull();
});

test("bounds failed recovery probes without reporting an unknown operation", async () => {
  vi.useFakeTimers();
  request.mockRejectedValue(new Error("Connection lost"));
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
    await watch;
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(view.result.current.error).toBeNull();
});

test("clears canceled coordinator progress after its saved operation disappears", async () => {
  vi.useFakeTimers();
  request
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "WAITING_CI",
        postMergeSwitch: pending,
      },
    } as never)
    .mockResolvedValueOnce({ githubPullRequestMergeOperation: null } as never);
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
    await runMergeOperation(key, "cancel", async () => null);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await watch;
  });
  expect(view.result.current.followUpOperation).toBeUndefined();
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.error).toBeNull();
});

test("keeps a confirmed result and completed checkout after coordinator cleanup", async () => {
  const result = { state: "MERGED" };
  await runMergeOperation(key, "merge", async () => result);
  recordMergeOperationProgress(key, false, null, undefined, "COMPLETED");
  recordPostMergeSwitch(key, completed);
  request.mockResolvedValue({ githubPullRequestMergeOperation: null } as never);
  const view = renderHook(() => useMergeOperation(key));
  await act(async () => {
    await trackPostMergeSwitch(key, target);
  });
  expect(view.result.current.followUpOperation).toBeUndefined();
  expect(view.result.current.result).toBe(result);
  expect(view.result.current.postMergeSwitch).toEqual(completed);
});

test("waits for cancellation to settle when the provider may already have merged", async () => {
  vi.useFakeTimers();
  request
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "WAITING_CI",
        postMergeSwitch: pending,
      },
    } as never)
    .mockResolvedValueOnce({ githubPullRequestMergeOperation: null } as never)
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "POST_MERGE",
        postMergeSwitch: pending,
      },
    } as never)
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "COMPLETED",
        postMergeSwitch: completed,
      },
    } as never);
  let finishCancel!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    finishCancel = resolve;
  });
  const result = { state: "MERGED" };
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  let cancel!: ReturnType<typeof runMergeOperation>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
    cancel = runMergeOperation(key, "cancel", async () => {
      await cancellation;
      return result;
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(view.result.current.pending).toBe(true);
  expect(view.result.current.followUpOperation?.state).toBe("WAITING_CI");
  await act(async () => {
    finishCancel();
    await cancel;
    await vi.advanceTimersByTimeAsync(4000);
    await watch;
  });
  expect(request).toHaveBeenCalledTimes(4);
  expect(view.result.current.result).toBe(result);
  expect(view.result.current.postMergeSwitch).toEqual(completed);
  expect(view.result.current.error).toBeNull();
});

test("stops pending progress when the coordinator requires attention", async () => {
  request.mockResolvedValue({
    githubPullRequestMergeOperation: {
      state: "ACTION_REQUIRED",
      lastError: "The destination changed",
      postMergeSwitch: pending,
    },
  } as never);
  const view = renderHook(() => useMergeOperation(key));
  await act(async () => {
    await trackPostMergeSwitch(key, target, pending);
  });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.error).toBe("The destination changed");
  expect(view.result.current.postMergeSwitch?.state).toBe("ACTION_REQUIRED");
});

test("keeps another follow-up error after the checkout switch succeeds", async () => {
  request.mockResolvedValue({
    githubPullRequestMergeOperation: {
      state: "ACTION_REQUIRED",
      lastError: "Jira unavailable",
      postMergeSwitch: completed,
    },
  } as never);
  const view = renderHook(() => useMergeOperation(key));
  await act(async () => {
    await trackPostMergeSwitch(key, target);
  });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.error).toBe("Jira unavailable");
  expect(view.result.current.postMergeSwitch).toEqual(completed);
});

test("reports polling failures and recovers by reading the existing operation", async () => {
  vi.useFakeTimers();
  request.mockRejectedValue(new Error("Connection lost"));
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target, pending);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
    await watch;
  });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.postMergeSwitch?.state).toBe("ACTION_REQUIRED");
  expect(view.result.current.error).toBe("Connection lost");
  request.mockResolvedValue({
    githubPullRequestMergeOperation: {
      state: "COMPLETED",
      postMergeSwitch: completed,
    },
  } as never);
  await act(async () => {
    await trackPostMergeSwitch(key, target);
  });
  expect(view.result.current.postMergeSwitch).toEqual(completed);
  expect(view.result.current.error).toBeNull();
  expect(
    request.mock.calls.every(([query]) => !query.includes("mutation")),
  ).toBe(true);
});

test("does not carry an old completion into a newly submitted operation", async () => {
  const view = renderHook(() => useMergeOperation(key));
  act(() => recordPostMergeSwitch(key, completed));
  await act(async () => {
    await runMergeOperation(key, "merge", async () => null);
  });
  expect(view.result.current.postMergeSwitch).toBeNull();
  expect(view.result.current.pending).toBe(false);
});

test("keeps view-refresh errors while successful checkout polling continues", async () => {
  const result = { state: "MERGED" };
  await runMergeOperation(key, "merge", async () => result);
  reportMergeOperationError(
    key,
    result,
    "The merge action completed, but refreshing this view failed: View unavailable",
  );
  request.mockResolvedValue({
    githubPullRequestMergeOperation: {
      state: "COMPLETED",
      postMergeSwitch: completed,
    },
  } as never);
  const view = renderHook(() => useMergeOperation(key));
  await act(async () => {
    await trackPostMergeSwitch(key, target, pending);
  });
  expect(view.result.current.postMergeSwitch).toEqual(completed);
  expect(view.result.current.error).toContain("refreshing this view failed");
});

test("continues observing later follow-ups after the checkout switch completes", async () => {
  vi.useFakeTimers();
  request
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "POST_MERGE",
        postMergeSwitch: completed,
      },
    } as never)
    .mockResolvedValueOnce({
      githubPullRequestMergeOperation: {
        state: "ACTION_REQUIRED",
        lastError: "Jira unavailable",
        postMergeSwitch: completed,
      },
    } as never);
  const view = renderHook(() => useMergeOperation(key));
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target);
  });
  expect(view.result.current.postMergeSwitch).toEqual(completed);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
    await watch;
  });
  expect(view.result.current.error).toBe("Jira unavailable");
  expect(view.result.current.followUpOperation?.state).toBe("ACTION_REQUIRED");
});

test("reports a missing operation only when checkout progress was already known", async () => {
  vi.useFakeTimers();
  request.mockResolvedValue({ githubPullRequestMergeOperation: null } as never);
  const view = renderHook(() => useMergeOperation(key));
  await act(async () => {
    await trackPostMergeSwitch(key, target);
  });
  expect(view.result.current.error).toBeNull();
  let watch!: Promise<void>;
  await act(async () => {
    watch = trackPostMergeSwitch(key, target, pending);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
    await watch;
  });
  expect(view.result.current.pending).toBe(false);
  expect(view.result.current.error).toContain("follow-up could not be found");
  expect(
    request.mock.calls.every(([query]) => !query.includes("mutation")),
  ).toBe(true);
});
