import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import {
  clearMergeOperation,
  dismissMergeOperationProgress,
  recordPostMergeSwitch,
  useMergeOperationProgress,
  githubMergeOperationKey,
  gitlabMergeOperationKey,
  runMergeOperation,
  useMergeOperation,
} from "./merge-operation-state";

const first = githubMergeOperationKey({
  repositoryNameWithOwner: "org/repo",
  number: 1,
});
const second = gitlabMergeOperationKey({ projectId: "1", iid: 1 });

afterEach(() => {
  cleanup();
  clearMergeOperation(first);
  clearMergeOperation(second);
});

test("retains a pending merge and its failure across navigation without sharing another request's state", async () => {
  let reject!: (error: Error) => void;
  const mutation = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const perform = vi.fn(() => mutation);
  const original = renderHook(() => useMergeOperation(first));
  let pending!: ReturnType<typeof runMergeOperation>;
  act(() => {
    pending = runMergeOperation(first, "merge", perform);
  });
  expect(original.result.current.pending).toBe(true);
  original.unmount();

  const nextRoute = renderHook(() => ({
    first: useMergeOperation(first),
    second: useMergeOperation(second),
  }));
  expect(nextRoute.result.current.first.pending).toBe(true);
  expect(nextRoute.result.current.second.pending).toBe(false);
  await expect(runMergeOperation(first, "merge", perform)).resolves.toBeNull();
  expect(perform).toHaveBeenCalledTimes(1);
  nextRoute.unmount();

  reject(new Error("Merge denied"));
  await pending;
  const reopened = renderHook(() => useMergeOperation(first));
  expect(reopened.result.current).toMatchObject({
    pending: false,
    error: "Merge denied",
  });
  act(() => clearMergeOperation(first, true));
  expect(reopened.result.current.error).toBe("Merge denied");
});

test("retains a completed merge with its follow-up warning after every sheet unmounts", async () => {
  const result = { state: "MERGED", warning: "Jira unavailable" };
  await runMergeOperation(
    first,
    "merge",
    async () => result,
    (value) => value.warning,
  );
  const reopened = renderHook(() => useMergeOperation<typeof result>(first));
  expect(reopened.result.current.result).toBe(result);
  expect(reopened.result.current.error).toBe("Jira unavailable");
  act(() => clearMergeOperation(first));
  expect(reopened.result.current.result).toBeNull();
  expect(reopened.result.current.error).toBeNull();
});

test("keeps a confirmed result when retrying its follow-ups fails", async () => {
  const result = { state: "MERGED", warning: "Jira unavailable" };
  await runMergeOperation(
    first,
    "merge",
    async () => result,
    (value) => value.warning,
  );
  await runMergeOperation(first, "retry", async () => {
    throw new Error("Connection lost");
  });
  const reopened = renderHook(() => useMergeOperation<typeof result>(first));
  expect(reopened.result.current.result).toBe(result);
  expect(reopened.result.current.error).toBe("Connection lost");
});

test("dismissing a completed progress card preserves the result and trigger status across polling", async () => {
  const merged = { state: "MERGED" };
  await runMergeOperation(first, "merge", async () => merged);
  const status = { branch: "main", state: "COMPLETED", lastError: null };
  const view = renderHook(() => ({
    operation: useMergeOperation(first),
    progress: useMergeOperationProgress(),
  }));
  act(() => recordPostMergeSwitch(first, status));
  expect(view.result.current.progress).toHaveLength(1);
  act(() => dismissMergeOperationProgress(first));
  act(() => recordPostMergeSwitch(first, { ...status }));
  expect(view.result.current.progress).toHaveLength(0);
  expect(view.result.current.operation.result).toBe(merged);
  expect(view.result.current.operation.postMergeSwitch).toEqual(status);
  await act(async () => {
    await runMergeOperation(first, "retry", async () => merged);
  });
  expect(view.result.current.progress).toHaveLength(1);
});
