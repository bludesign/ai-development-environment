"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import type { CommandDefinition } from "./types";

export type CommandActionDefinition = Pick<
  CommandDefinition,
  | "id"
  | "name"
  | "description"
  | "targetKind"
  | "quickActionEnabled"
  | "quickActionIconKey"
  | "quickActionButtonVariant"
>;
export type CommandTarget = {
  resourceKind: "AGENT" | "WORKTREE";
  resourceId: string;
};
type Options = { includeAllCommands?: boolean; includeRecentRuns?: boolean };
export type CommandTargetSummary = CommandTarget & {
  commands: CommandActionDefinition[];
  activeRuns: Array<{
    id: string;
    commandId: string;
    displayNumber: number;
    status: string;
  }>;
  recentRuns: Array<{
    id: string;
    displayNumber: number;
    status: string;
    snapshotName: string;
    createdAt: string;
  }>;
};
type Snapshot = Pick<
  CommandTargetSummary,
  "commands" | "activeRuns" | "recentRuns"
> & { error: string | null; loaded: boolean };
const EMPTY: Snapshot = {
  commands: [],
  activeRuns: [],
  recentRuns: [],
  error: null,
  loaded: false,
};
const keyFor = (target: CommandTarget) =>
  JSON.stringify([target.resourceKind, target.resourceId]);
const QUERY = `query CommandTargetSummaries($targets: [CommandTargetSummaryInput!]!) {
  commandTargetSummaries(targets: $targets) {
    resourceKind resourceId
    commands { id name description targetKind quickActionEnabled quickActionIconKey quickActionButtonVariant }
    activeRuns { id commandId displayNumber status }
    recentRuns { id displayNumber status snapshotName createdAt }
  }
}`;
type Entry = {
  target: CommandTarget;
  consumers: Map<() => void, Options>;
  snapshot: Snapshot;
  dirty: boolean;
  inFlight: boolean;
  disposeRuns?: () => void;
};
type Batch = { entries: Entry[]; controller: AbortController };

/** Shared only while mounted. New cards join one query; events refresh affected targets. */
export function createCommandTargetSummaryStore() {
  const entries = new Map<string, Entry>();
  const batches = new Set<Batch>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposeDefinitions: (() => void) | undefined;
  let disposeRecovery: (() => void) | undefined;
  const optionsFor = (entry: Entry): Options => ({
    includeAllCommands: [...entry.consumers.values()].some(
      (options) => options.includeAllCommands,
    ),
    includeRecentRuns: [...entry.consumers.values()].some(
      (options) => options.includeRecentRuns,
    ),
  });
  const current = (entry: Entry) =>
    entries.get(keyFor(entry.target)) === entry && entry.consumers.size > 0;
  const notify = (entry: Entry) => {
    for (const listener of entry.consumers.keys()) listener();
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
    if (current(entry)) {
      entry.dirty = true;
      schedule();
    }
  };
  const watchRuns = (entry: Entry) => {
    // Subscribe before the first snapshot to avoid an HTTP/subscription gap.
    // Remove empty quick-action targets once eligibility is known; panels still
    // watch their recent history even when no quick action is displayed.
    const needed =
      !entry.snapshot.loaded ||
      optionsFor(entry).includeRecentRuns ||
      entry.snapshot.commands.some((command) => command.quickActionEnabled);
    if (!needed) {
      entry.disposeRuns?.();
      entry.disposeRuns = undefined;
    } else if (!entry.disposeRuns)
      entry.disposeRuns = controlPlaneSubscriptions().subscribe(
        {
          query: `subscription CommandTargetRuns($id: ID!) { commandRunsChanged(${entry.target.resourceKind === "AGENT" ? "agentId" : "worktreeId"}: $id) { id } }`,
          variables: { id: entry.target.resourceId },
        },
        {
          next: () => invalidate(entry),
          error: () => undefined,
          complete: () => undefined,
        },
      );
  };
  const fetchBatch = async (selected: Entry[]) => {
    const batch = { entries: selected, controller: new AbortController() };
    batches.add(batch);
    const targets = selected.map((entry) => ({
      ...entry.target,
      ...optionsFor(entry),
    }));
    for (const entry of selected) {
      entry.dirty = false;
      entry.inFlight = true;
    }
    try {
      const data = await controlPlaneRequest<{
        commandTargetSummaries: CommandTargetSummary[];
      }>(QUERY, { targets }, { signal: batch.controller.signal });
      const results = new Map(
        data.commandTargetSummaries.map((summary) => [
          keyFor(summary),
          summary,
        ]),
      );
      for (const entry of selected) {
        if (!current(entry)) continue;
        const summary = results.get(keyFor(entry.target));
        if (!summary)
          throw new Error("Command target summary missing from response");
        entry.snapshot = { ...summary, error: null, loaded: true };
        watchRuns(entry);
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
      for (const entry of selected) entry.inFlight = false;
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
    if (!disposeDefinitions)
      disposeDefinitions = controlPlaneSubscriptions().subscribe(
        {
          query:
            "subscription CommandTargetDefinitions { commandsChanged { id } }",
        },
        {
          next: () => {
            for (const entry of entries.values()) {
              entry.snapshot = { ...entry.snapshot, loaded: false };
              watchRuns(entry);
              invalidate(entry);
            }
          },
          error: () => undefined,
          complete: () => undefined,
        },
      );
    disposeRecovery ??= onControlPlaneRecovery(() => {
      for (const entry of entries.values()) invalidate(entry);
    });
  };
  return {
    snapshot: (target: CommandTarget) =>
      entries.get(keyFor(target))?.snapshot ?? EMPTY,
    refresh: (target: CommandTarget) => {
      const entry = entries.get(keyFor(target));
      if (entry) invalidate(entry);
    },
    subscribe(target: CommandTarget, options: Options, listener: () => void) {
      const key = keyFor(target);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          target,
          consumers: new Map(),
          snapshot: EMPTY,
          dirty: true,
          inFlight: false,
        };
        entries.set(key, entry);
      }
      const before = optionsFor(entry);
      entry.consumers.set(listener, options);
      const after = optionsFor(entry);
      if (
        (!before.includeAllCommands && after.includeAllCommands) ||
        (!before.includeRecentRuns && after.includeRecentRuns)
      )
        entry.dirty = true;
      connect();
      watchRuns(entry);
      schedule();
      const subscribed = entry;
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        subscribed.consumers.delete(listener);
        if (subscribed.consumers.size) watchRuns(subscribed);
        else {
          subscribed.disposeRuns?.();
          entries.delete(key);
          for (const batch of batches)
            if (!batch.entries.some(current)) batch.controller.abort();
        }
        if (!entries.size) {
          disposeDefinitions?.();
          disposeDefinitions = undefined;
          disposeRecovery?.();
          disposeRecovery = undefined;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
        }
      };
    },
  };
}

const store = createCommandTargetSummaryStore();
export function useCommandTargetSummary(
  target: CommandTarget,
  options: Options = {},
) {
  const { resourceKind, resourceId } = target;
  const { includeAllCommands = false, includeRecentRuns = false } = options;
  const subscribe = useCallback(
    (listener: () => void) =>
      store.subscribe(
        { resourceKind, resourceId },
        { includeAllCommands, includeRecentRuns },
        listener,
      ),
    [resourceKind, resourceId, includeAllCommands, includeRecentRuns],
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
