"use client";

import { useCallback, useSyncExternalStore } from "react";

export type PostMergeSwitchStatus = {
  branch: string;
  state: string;
  lastError: string | null;
};

export type MergeAction = "merge" | "auto" | "cancel" | "retry";
type MergeOperationState<T = unknown> = {
  pending: boolean;
  action: MergeAction | null;
  result: T | null;
  error: string | null;
  label?: string;
  mutationPending?: boolean;
  managedPending?: boolean;
  refreshError?: string | null;
  progressDismissed?: boolean;
  postMergeSwitch?: PostMergeSwitchStatus | null;
  followUpOperation?: { state: string; lastError: string | null };
};

export type MergeOperationErrorEntry = {
  key: string;
  error: string;
  label: string;
};

const EMPTY: MergeOperationState = {
  pending: false,
  action: null,
  result: null,
  error: null,
};
// Owned by the browser session, rather than a sheet or route. Dismissing a sheet
// or navigating must not cancel its mutation or forget an error from that work.
const operations = new Map<string, MergeOperationState>();
const listeners = new Map<string, Set<() => void>>();
const errorListeners = new Set<() => void>();
const EMPTY_ERRORS: MergeOperationErrorEntry[] = [];
let errors = EMPTY_ERRORS;
const EMPTY_PROGRESS: Array<{
  key: string;
  label: string;
  status: PostMergeSwitchStatus;
}> = [];
let progress = EMPTY_PROGRESS;

function publishErrors() {
  errors = [...operations].flatMap(([key, state]) =>
    state.error ? [{ key, error: state.error, label: state.label ?? key }] : [],
  );
  progress = [...operations].flatMap(([key, state]) =>
    state.postMergeSwitch &&
    !state.progressDismissed &&
    state.postMergeSwitch.state !== "ACTION_REQUIRED"
      ? [{ key, label: state.label ?? key, status: state.postMergeSwitch }]
      : [],
  );
  errorListeners.forEach((listener) => listener());
}

export function useMergeOperationErrors() {
  return useSyncExternalStore(
    (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    () => errors,
    () => EMPTY_ERRORS,
  );
}

export function useMergeOperationProgress() {
  return useSyncExternalStore(
    (listener) => {
      errorListeners.add(listener);
      return () => {
        errorListeners.delete(listener);
      };
    },
    () => progress,
    () => EMPTY_PROGRESS,
  );
}

export const githubMergeOperationKey = (request: {
  repositoryNameWithOwner: string;
  number: number;
}) =>
  JSON.stringify(["github", request.repositoryNameWithOwner, request.number]);

export const gitlabMergeOperationKey = (request: {
  projectId: string;
  iid: number;
}) => JSON.stringify(["gitlab", request.projectId, request.iid]);

function publish(key: string, state: MergeOperationState) {
  operations.set(key, state);
  listeners.get(key)?.forEach((listener) => listener());
  publishErrors();
}

export function dismissMergeOperationError(key: string) {
  const state = operations.get(key);
  if (state && !state.pending)
    publish(key, { ...state, error: null, refreshError: null });
}

export function reportMergeOperationError(
  key: string,
  result: unknown,
  error: string,
) {
  const state = operations.get(key);
  if (state && !state.mutationPending && state.result === result)
    publish(key, { ...state, error, refreshError: error });
}

export function getMergeOperationSnapshot(key: string): MergeOperationState {
  return operations.get(key) ?? EMPTY;
}

export function clearMergeOperation(
  key: string,
  preserveError = false,
  expectedSnapshot = getMergeOperationSnapshot(key),
) {
  const current = getMergeOperationSnapshot(key);
  if (
    current !== expectedSnapshot ||
    current.pending ||
    (preserveError && current.error)
  )
    return;
  operations.delete(key);
  listeners.get(key)?.forEach((listener) => listener());
  publishErrors();
}

export function useMergeOperation<T>(key: string): MergeOperationState<T> {
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, group);
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(key);
      };
    },
    [key],
  );
  const snapshot = useCallback(() => getMergeOperationSnapshot(key), [key]);
  return useSyncExternalStore(
    subscribe,
    snapshot,
    () => EMPTY,
  ) as MergeOperationState<T>;
}

export async function runMergeOperation<T>(
  key: string,
  action: MergeAction,
  perform: () => Promise<T>,
  resultError: (result: T) => string | null = () => null,
  label?: string,
): Promise<{ result: T } | null> {
  // Synchronous and shared across every surface for the same request.
  const previous = operations.get(key);
  if (previous?.pending) return null;
  const previousResult =
    action === "retry" || action === "cancel"
      ? (previous?.result ?? null)
      : null;
  publish(key, {
    pending: true,
    mutationPending: true,
    postMergeSwitch:
      action === "merge" || action === "auto"
        ? null
        : previous?.postMergeSwitch,
    managedPending: false,
    refreshError: null,
    progressDismissed: false,
    followUpOperation:
      action === "merge" || action === "auto"
        ? undefined
        : previous?.followUpOperation,
    action,
    result: previousResult,
    error: null,
    label,
  });
  try {
    const result = await perform();
    publish(key, {
      pending:
        Boolean(operations.get(key)?.managedPending) ||
        postMergeSwitchPending(operations.get(key)?.postMergeSwitch),
      mutationPending: false,
      postMergeSwitch: operations.get(key)?.postMergeSwitch,
      managedPending: operations.get(key)?.managedPending,
      refreshError: operations.get(key)?.refreshError,
      progressDismissed: operations.get(key)?.progressDismissed,
      followUpOperation: operations.get(key)?.followUpOperation,
      action,
      result,
      error:
        resultError(result) ??
        operations.get(key)?.postMergeSwitch?.lastError ??
        operations.get(key)?.error ??
        null,
      label,
    });
    return { result };
  } catch (value) {
    publish(key, {
      pending:
        Boolean(operations.get(key)?.managedPending) ||
        postMergeSwitchPending(operations.get(key)?.postMergeSwitch),
      mutationPending: false,
      postMergeSwitch: operations.get(key)?.postMergeSwitch,
      managedPending: operations.get(key)?.managedPending,
      refreshError: operations.get(key)?.refreshError,
      progressDismissed: operations.get(key)?.progressDismissed,
      followUpOperation: operations.get(key)?.followUpOperation,
      action,
      result: previousResult,
      error: value instanceof Error ? value.message : String(value),
      label,
    });
    return null;
  }
}

export function postMergeSwitchPending(status?: PostMergeSwitchStatus | null) {
  return status?.state === "PENDING" || status?.state === "UPDATING";
}

export function recordPostMergeSwitch(
  key: string,
  status: PostMergeSwitchStatus,
  label?: string,
) {
  const previous = getMergeOperationSnapshot(key);
  publish(key, {
    ...previous,
    postMergeSwitch: status,
    pending:
      Boolean(previous.mutationPending) || postMergeSwitchPending(status),
    error:
      status.state === "ACTION_REQUIRED"
        ? status.lastError
        : (previous.refreshError ??
          (previous.mutationPending ? previous.error : null)),
    label: label ?? previous.label,
  });
}

export function recordMergeOperationProgress(
  key: string,
  pending: boolean,
  error: string | null,
  label?: string,
  operationState?: string,
) {
  const previous = getMergeOperationSnapshot(key);
  publish(key, {
    ...previous,
    followUpOperation: operationState
      ? { state: operationState, lastError: error }
      : previous.followUpOperation,
    managedPending: pending,
    pending:
      Boolean(previous.mutationPending) ||
      pending ||
      postMergeSwitchPending(previous.postMergeSwitch),
    error: error ?? previous.refreshError ?? null,
    label: label ?? previous.label,
  });
}

export function dismissMergeOperationProgress(key: string) {
  const state = operations.get(key);
  if (state && !state.pending && state.postMergeSwitch?.state === "COMPLETED")
    publish(key, { ...state, progressDismissed: true });
}
