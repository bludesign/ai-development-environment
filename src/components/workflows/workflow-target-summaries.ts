"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

export type WorkflowTarget = {
  resourceKind: string;
  resourceId: string;
};

export type WorkflowActiveRunSummary = {
  id: string;
  workflowId: string;
  displayNumber: number;
  status: string;
};

type WorkflowTargetSummary = WorkflowTarget & {
  activeRuns: WorkflowActiveRunSummary[];
};

type Snapshot = Pick<WorkflowTargetSummary, "activeRuns"> & {
  error: string | null;
  loaded: boolean;
};

const EMPTY: Snapshot = {
  activeRuns: [],
  error: null,
  loaded: false,
};

const normalizeTarget = (target: WorkflowTarget): WorkflowTarget => ({
  resourceKind: target.resourceKind.trim().toUpperCase(),
  resourceId: target.resourceId.trim(),
});
const keyFor = (target: WorkflowTarget) => {
  const normalized = normalizeTarget(target);
  return JSON.stringify([normalized.resourceKind, normalized.resourceId]);
};

const QUERY = `query WorkflowTargetSummaries($targets: [WorkflowTargetSummaryInput!]!) {
  workflowTargetSummaries(targets: $targets) {
    resourceKind resourceId
    activeRuns { id workflowId displayNumber status }
  }
}`;

type Entry = {
  target: WorkflowTarget;
  consumers: Set<() => void>;
  snapshot: Snapshot;
  dirty: boolean;
  inFlight: boolean;
  waiters: Set<() => void>;
  disposeRuns?: () => void;
};

type Batch = { entries: Entry[]; controller: AbortController };

/** Shared while mounted so a worktree grid reads active workflow runs in batches. */
export function createWorkflowTargetSummaryStore() {
  const entries = new Map<string, Entry>();
  const batches = new Set<Batch>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposeRecovery: (() => void) | undefined;

  const current = (entry: Entry) =>
    entries.get(keyFor(entry.target)) === entry && entry.consumers.size > 0;
  const notify = (entry: Entry) => {
    for (const listener of entry.consumers) listener();
  };
  const finishWaiters = (entry: Entry) => {
    if (entry.dirty || entry.inFlight) return;
    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
  };
  const schedule = () => {
    if (
      timer === undefined &&
      [...entries.values()].some((entry) => entry.dirty && !entry.inFlight)
    )
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 0);
  };
  const invalidate = (entry: Entry) => {
    if (!current(entry)) return;
    entry.dirty = true;
    schedule();
  };
  const fetchBatch = async (selected: Entry[]) => {
    const batch = { entries: selected, controller: new AbortController() };
    batches.add(batch);
    for (const entry of selected) {
      entry.dirty = false;
      entry.inFlight = true;
    }
    try {
      const data = await controlPlaneRequest<{
        workflowTargetSummaries: WorkflowTargetSummary[];
      }>(
        QUERY,
        { targets: selected.map((entry) => entry.target) },
        { signal: batch.controller.signal },
      );
      const results = new Map(
        data.workflowTargetSummaries.map((summary) => [
          keyFor(summary),
          summary,
        ]),
      );
      for (const entry of selected) {
        if (!current(entry)) continue;
        const summary = results.get(keyFor(entry.target));
        if (!summary)
          throw new Error("Workflow target summary missing from response");
        entry.snapshot = {
          activeRuns: summary.activeRuns,
          error: null,
          loaded: true,
        };
        notify(entry);
      }
    } catch (error) {
      if (!batch.controller.signal.aborted)
        for (const entry of selected) {
          if (!current(entry)) continue;
          entry.snapshot = {
            ...entry.snapshot,
            error: error instanceof Error ? error.message : String(error),
          };
          notify(entry);
        }
    } finally {
      batches.delete(batch);
      for (const entry of selected) {
        entry.inFlight = false;
        finishWaiters(entry);
      }
      schedule();
    }
  };
  const flush = async () => {
    const pending = [...entries.values()].filter(
      (entry) => entry.dirty && !entry.inFlight,
    );
    await Promise.all(
      Array.from({ length: Math.ceil(pending.length / 200) }, (_, index) =>
        fetchBatch(pending.slice(index * 200, (index + 1) * 200)),
      ),
    );
  };
  const connect = () => {
    disposeRecovery ??= onControlPlaneRecovery(() => {
      for (const entry of entries.values()) invalidate(entry);
    });
  };

  return {
    snapshot: (target: WorkflowTarget) =>
      entries.get(keyFor(target))?.snapshot ?? EMPTY,
    refresh: (target: WorkflowTarget) => {
      const entry = entries.get(keyFor(target));
      if (!entry) return Promise.resolve();
      return new Promise<void>((resolve) => {
        entry.waiters.add(resolve);
        invalidate(entry);
      });
    },
    subscribe(target: WorkflowTarget, listener: () => void) {
      const normalized = normalizeTarget(target);
      const key = keyFor(normalized);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          target: normalized,
          consumers: new Set(),
          snapshot: EMPTY,
          dirty: true,
          inFlight: false,
          waiters: new Set(),
        };
        entries.set(key, entry);
      }
      entry.consumers.add(listener);
      if (!entry.disposeRuns)
        entry.disposeRuns = controlPlaneSubscriptions().subscribe<{
          workflowChanges: { definitionsChanged: boolean };
        }>(
          {
            query: `subscription WorkflowTargetRuns($kind: String!, $resourceId: ID!) {
              workflowChanges(resourceKind: $kind, resourceId: $resourceId) { definitionsChanged }
            }`,
            variables: {
              kind: entry.target.resourceKind,
              resourceId: entry.target.resourceId,
            },
          },
          {
            next: (result) => {
              if (!result.data?.workflowChanges.definitionsChanged)
                invalidate(entry!);
            },
            error: () => undefined,
            complete: () => undefined,
          },
        );
      connect();
      schedule();
      const subscribed = entry;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        subscribed.consumers.delete(listener);
        if (!subscribed.consumers.size) {
          subscribed.disposeRuns?.();
          entries.delete(key);
          for (const resolve of subscribed.waiters) resolve();
          subscribed.waiters.clear();
          for (const batch of batches)
            if (!batch.entries.some(current)) batch.controller.abort();
        }
        if (!entries.size) {
          disposeRecovery?.();
          disposeRecovery = undefined;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
        }
      };
    },
  };
}

const store = createWorkflowTargetSummaryStore();

export function useWorkflowTargetSummary(target: WorkflowTarget) {
  const { resourceKind, resourceId } = target;
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe({ resourceKind, resourceId }, listener),
    [resourceKind, resourceId],
  );
  const snapshot = useCallback(
    () => store.snapshot({ resourceKind, resourceId }),
    [resourceKind, resourceId],
  );
  const refresh = useCallback(
    () => store.refresh({ resourceKind, resourceId }),
    [resourceKind, resourceId],
  );
  return { ...useSyncExternalStore(subscribe, snapshot, () => EMPTY), refresh };
}
