"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

import { INSPECT_WORKTREE_MUTATION } from "./worktree-graphql";
import type { Worktree, WorktreeDetail } from "./types";

const LIVE_INSPECTION_RETRY_MS = 1_000;

export async function inspectWorktree(
  worktreeId: string,
): Promise<WorktreeDetail> {
  const data = await controlPlaneRequest<{
    inspectWorktree: WorktreeDetail;
  }>(INSPECT_WORKTREE_MUTATION, {
    id: worktreeId,
    requestId: createClientId(),
  });
  return data.inspectWorktree;
}

export function useQueuedWorktreeInspection(
  inspect: () => Promise<void>,
): () => Promise<void> {
  const running = useRef(false);
  const pending = useRef(false);

  return useCallback(async () => {
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        pending.current = false;
        await inspect();
      } while (pending.current);
    } finally {
      running.current = false;
    }
  }, [inspect]);
}

export type WorktreeActivity = {
  worktreeId: string;
  branch: string | null;
  headSha: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  syncState: Worktree["syncState"] | null;
  baseAhead: number | null;
  baseBehind: number | null;
  hasStagedChanges: boolean | null;
  hasUnstagedChanges: boolean | null;
  pushStatus: Worktree["pushStatus"] | null;
  observedAt: string;
};

type LiveWorktreeFields = Pick<
  Worktree,
  | "branch"
  | "headSha"
  | "upstream"
  | "ahead"
  | "behind"
  | "syncState"
  | "baseAhead"
  | "baseBehind"
  | "hasStagedChanges"
  | "hasUnstagedChanges"
  | "pushStatus"
>;

export function useLiveWorktree(source: Worktree) {
  const [override, setOverride] = useState<{
    sourceUpdatedAt: string;
    value: Partial<LiveWorktreeFields>;
  } | null>(null);
  const applyOverride = useCallback(
    (value: Partial<LiveWorktreeFields>) => {
      setOverride((current) => ({
        sourceUpdatedAt: source.updatedAt,
        value:
          current?.sourceUpdatedAt === source.updatedAt
            ? { ...current.value, ...value }
            : value,
      }));
    },
    [source.updatedAt],
  );
  const applyActivity = useCallback(
    (activity: WorktreeActivity) => {
      const value: Partial<LiveWorktreeFields> = {};
      if (activity.hasStagedChanges !== null) {
        value.hasStagedChanges = activity.hasStagedChanges;
      }
      if (activity.hasUnstagedChanges !== null) {
        value.hasUnstagedChanges = activity.hasUnstagedChanges;
      }
      if (activity.pushStatus !== null) value.pushStatus = activity.pushStatus;
      if (typeof activity.headSha === "string") {
        Object.assign(value, {
          branch: activity.branch,
          headSha: activity.headSha,
          upstream: activity.upstream,
          ahead: activity.ahead,
          behind: activity.behind,
          syncState: activity.syncState ?? "UNKNOWN",
          baseAhead: activity.baseAhead,
          baseBehind: activity.baseBehind,
        } satisfies Partial<LiveWorktreeFields>);
      }
      if (Object.keys(value).length) applyOverride(value);
    },
    [applyOverride],
  );
  return {
    worktree:
      override?.sourceUpdatedAt === source.updatedAt
        ? { ...source, ...override.value }
        : source,
    applyActivity,
    setUnstagedChanges: useCallback(
      (value: boolean) => applyOverride({ hasUnstagedChanges: value }),
      [applyOverride],
    ),
  };
}

export function useWorktreeActivitySubscription(
  worktreeId: string,
  enabled: boolean,
  onActivity: (activity: WorktreeActivity) => void,
) {
  const onActivityRef = useRef(onActivity);
  useEffect(() => {
    onActivityRef.current = onActivity;
  }, [onActivity]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let generation = 0;
    let retryTimer: number | null = null;
    let unsubscribe: () => void = () => undefined;
    const scheduleRetry = (currentGeneration: number) => {
      if (stopped || currentGeneration !== generation || retryTimer !== null)
        return;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        subscribe();
      }, LIVE_INSPECTION_RETRY_MS);
    };
    const subscribe = () => {
      const currentGeneration = ++generation;
      unsubscribe = controlPlaneSubscriptions().subscribe(
        {
          query: `subscription WorktreeInspectionChanged($worktreeId: ID!) {
            worktreeInspectionChanged(worktreeId: $worktreeId) {
              worktreeId branch headSha upstream ahead behind syncState baseAhead baseBehind
              hasStagedChanges hasUnstagedChanges pushStatus observedAt
            }
          }`,
          variables: { worktreeId },
        },
        {
          next: (result) => {
            const activity = (
              result as {
                data?: { worktreeInspectionChanged?: WorktreeActivity };
              }
            ).data?.worktreeInspectionChanged;
            if (activity) onActivityRef.current(activity);
          },
          error: () => scheduleRetry(currentGeneration),
          complete: () => scheduleRetry(currentGeneration),
        },
      );
    };
    subscribe();
    return () => {
      stopped = true;
      generation += 1;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [enabled, worktreeId]);
}
