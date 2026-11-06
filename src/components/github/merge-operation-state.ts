"use client";

import { useCallback, useSyncExternalStore } from "react";

export type MergeAction = "merge" | "auto" | "cancel" | "retry";
type MergeOperationState<T = unknown> = {
  pending: boolean;
  action: MergeAction | null;
  result: T | null;
  error: string | null;
  label?: string;
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

function publishErrors() {
  errors = [...operations].flatMap(([key, state]) =>
    state.error ? [{ key, error: state.error, label: state.label ?? key }] : [],
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
  if (state && !state.pending) publish(key, { ...state, error: null });
}

export function reportMergeOperationError(
  key: string,
  result: unknown,
  error: string,
) {
  const state = operations.get(key);
  if (state && !state.pending && state.result === result)
    publish(key, { ...state, error });
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
    action,
    result: previousResult,
    error: null,
    label,
  });
  try {
    const result = await perform();
    publish(key, {
      pending: false,
      action,
      result,
      error: resultError(result),
      label,
    });
    return { result };
  } catch (value) {
    publish(key, {
      pending: false,
      action,
      result: previousResult,
      error: value instanceof Error ? value.message : String(value),
      label,
    });
    return null;
  }
}
