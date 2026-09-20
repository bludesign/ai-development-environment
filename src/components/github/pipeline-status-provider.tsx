"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import type {
  GitHubPipelineRecordKeyInput,
  GitHubPipelineRecordView,
  GitHubPipelineStatusChangeView,
  GitHubPipelineStatusKeyInput,
  GitHubPipelineStatusSnapshotView,
} from "@/services/github/types";

const PIPELINE_FIELDS =
  "id name status url checkSuiteId canRetry retryUnavailableReason jobs { id name status url canRetry retryUnavailableReason steps { number name status } runAttempt } workflowRunId workflowId runNumber runAttempt";
const SNAPSHOT_FIELDS = `repositoryGithubId repositoryNameWithOwner repositoryUrl headSha pipelineStatus revision updatedAt pipelines { ${PIPELINE_FIELDS} }`;
const RECORD_FIELDS = `${PIPELINE_FIELDS} repositoryGithubId headSha revision isCurrent`;

function snapshotKey(key: GitHubPipelineStatusKeyInput): string {
  return `${key.repositoryGithubId}\u0000${key.headSha}`;
}

function recordKey(key: GitHubPipelineRecordKeyInput): string {
  return `${key.repositoryGithubId}\u0000${key.workflowRunId}`;
}

type PipelineProjection = GitHubPipelineStatusSnapshotView["pipelines"][number];
type JobProjection = PipelineProjection["jobs"][number];

function mergeJobProjection(
  existing: JobProjection | undefined,
  incoming: JobProjection,
): JobProjection {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    steps: incoming.steps ?? existing.steps,
    runAttempt:
      incoming.runAttempt === undefined
        ? existing.runAttempt
        : incoming.runAttempt,
  };
}

function mergePipelineProjection(
  existing: PipelineProjection | undefined,
  incoming: PipelineProjection,
): PipelineProjection {
  if (!existing) return incoming;
  const existingJobs = existing.jobs ?? [];
  const incomingJobs = incoming.jobs;
  const existingJobsById = new Map(existingJobs.map((job) => [job.id, job]));
  return {
    ...existing,
    ...incoming,
    jobs:
      incomingJobs === undefined
        ? existingJobs
        : incomingJobs.map((job) =>
            mergeJobProjection(existingJobsById.get(job.id), job),
          ),
    workflowRunId:
      incoming.workflowRunId === undefined
        ? existing.workflowRunId
        : incoming.workflowRunId,
    workflowId:
      incoming.workflowId === undefined
        ? existing.workflowId
        : incoming.workflowId,
    runNumber:
      incoming.runNumber === undefined
        ? existing.runNumber
        : incoming.runNumber,
    runAttempt:
      incoming.runAttempt === undefined
        ? existing.runAttempt
        : incoming.runAttempt,
  };
}

function mergeEqualRevisionSnapshot(
  existing: GitHubPipelineStatusSnapshotView,
  incoming: GitHubPipelineStatusSnapshotView,
): GitHubPipelineStatusSnapshotView {
  const existingById = new Map(
    existing.pipelines.map((pipeline) => [pipeline.id, pipeline]),
  );
  const incomingIds = new Set(
    incoming.pipelines.map((pipeline) => pipeline.id),
  );
  return {
    ...existing,
    ...incoming,
    pipelines: [
      ...incoming.pipelines.map((pipeline) =>
        mergePipelineProjection(existingById.get(pipeline.id), pipeline),
      ),
      ...existing.pipelines.filter((pipeline) => !incomingIds.has(pipeline.id)),
    ],
  };
}

function sameProjection(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => sameProjection(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => key in right && sameProjection(left[key], right[key]),
  );
}

function latestSnapshotProjection(
  existing: GitHubPipelineStatusSnapshotView | undefined,
  incoming: GitHubPipelineStatusSnapshotView | null | undefined,
): GitHubPipelineStatusSnapshotView | null {
  if (!existing) return incoming ?? null;
  if (!incoming || existing.revision > incoming.revision) return existing;
  if (incoming.revision > existing.revision) return incoming;
  return mergeEqualRevisionSnapshot(existing, incoming);
}

type PipelineStatusContextValue = {
  snapshots: Map<string, GitHubPipelineStatusSnapshotView>;
  records: Map<string, GitHubPipelineRecordView>;
  seedSnapshot: (snapshot: GitHubPipelineStatusSnapshotView) => void;
  seedRecord: (record: GitHubPipelineRecordView) => void;
  watchSnapshot: (key: GitHubPipelineStatusKeyInput) => () => void;
  watchRecord: (key: GitHubPipelineRecordKeyInput) => () => void;
};

const PipelineStatusContext = createContext<PipelineStatusContextValue | null>(
  null,
);

export function GitHubPipelineStatusProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [snapshots, setSnapshots] = useState(
    () => new Map<string, GitHubPipelineStatusSnapshotView>(),
  );
  const [records, setRecords] = useState(
    () => new Map<string, GitHubPipelineRecordView>(),
  );
  const snapshotWatches = useRef(
    new Map<string, { key: GitHubPipelineStatusKeyInput; count: number }>(),
  );
  const recordWatches = useRef(
    new Map<string, { key: GitHubPipelineRecordKeyInput; count: number }>(),
  );

  const seedSnapshot = useCallback(
    (incoming: GitHubPipelineStatusSnapshotView) => {
      setSnapshots((current) => {
        const key = snapshotKey(incoming);
        const existing = current.get(key);
        if (existing && existing.revision > incoming.revision) return current;
        const merged =
          existing && existing.revision === incoming.revision
            ? mergeEqualRevisionSnapshot(existing, incoming)
            : incoming;
        // Callers re-seed with a fresh object on every render; keeping the same
        // map when nothing changed stops that from re-rendering consumers.
        if (existing && sameProjection(existing, merged)) return current;
        const next = new Map(current);
        next.set(key, merged);
        return next;
      });
    },
    [],
  );

  const seedRecord = useCallback((incoming: GitHubPipelineRecordView) => {
    if (!incoming.workflowRunId) return;
    setRecords((current) => {
      const key = recordKey({
        repositoryGithubId: incoming.repositoryGithubId,
        workflowRunId: incoming.workflowRunId!,
      });
      const existing = current.get(key);
      if (existing && existing.revision > incoming.revision) return current;
      const merged =
        existing && existing.revision === incoming.revision
          ? { ...incoming, ...mergePipelineProjection(existing, incoming) }
          : incoming;
      if (existing && sameProjection(existing, merged)) return current;
      const next = new Map(current);
      next.set(key, merged);
      return next;
    });
  }, []);

  const loadSnapshots = useCallback(
    async (keys: GitHubPipelineStatusKeyInput[]) => {
      if (keys.length === 0) return;
      try {
        const data = await controlPlaneRequest<{
          githubPipelineStatuses: GitHubPipelineStatusSnapshotView[];
        }>(
          `query GitHubPipelineStatuses($keys: [GitHubPipelineStatusKeyInput!]!) {
            githubPipelineStatuses(keys: $keys) { ${SNAPSHOT_FIELDS} }
          }`,
          { keys },
        );
        for (const snapshot of data.githubPipelineStatuses) {
          if (snapshotWatches.current.has(snapshotKey(snapshot)))
            seedSnapshot(snapshot);
        }
      } catch {
        // Existing page data remains usable when local reconciliation fails.
      }
    },
    [seedSnapshot],
  );

  const loadRecords = useCallback(
    async (keys: GitHubPipelineRecordKeyInput[]) => {
      if (keys.length === 0) return;
      try {
        const data = await controlPlaneRequest<{
          githubPipelineRecords: GitHubPipelineRecordView[];
        }>(
          `query GitHubPipelineRecords($keys: [GitHubPipelineRecordKeyInput!]!) {
            githubPipelineRecords(keys: $keys) { ${RECORD_FIELDS} }
          }`,
          { keys },
        );
        for (const record of data.githubPipelineRecords) {
          if (
            record.workflowRunId &&
            recordWatches.current.has(
              recordKey({ ...record, workflowRunId: record.workflowRunId }),
            )
          )
            seedRecord(record);
        }
      } catch {
        // Existing page data remains usable when local reconciliation fails.
      }
    },
    [seedRecord],
  );

  const pendingSnapshots = useRef(new Set<string>());
  const pendingRecords = useRef(new Set<string>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscription = useRef<{ scope: string; dispose: () => void } | null>(
    null,
  );

  const flush = useCallback(() => {
    flushTimer.current = null;
    const snapshotKeys = [...snapshotWatches.current.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { key }]) => key);
    const recordKeys = [...recordWatches.current.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { key }]) => key);
    const scope = JSON.stringify([snapshotKeys, recordKeys]);
    if (!snapshotKeys.length && !recordKeys.length) {
      subscription.current?.dispose();
      subscription.current = null;
    } else if (subscription.current?.scope !== scope) {
      const previous = subscription.current;
      const dispose = controlPlaneSubscriptions().subscribe<{
        githubPipelineStatusChanged: GitHubPipelineStatusChangeView;
      }>(
        {
          query: `subscription GitHubPipelineStatusChanged(
          $snapshotKeys: [GitHubPipelineStatusKeyInput!],
          $recordKeys: [GitHubPipelineRecordKeyInput!],
          $includeSnapshots: Boolean!
        ) {
          githubPipelineStatusChanged(snapshotKeys: $snapshotKeys, recordKeys: $recordKeys, replayCurrent: true) {
            snapshot @include(if: $includeSnapshots) { ${SNAPSHOT_FIELDS} }
            changedPipeline { ${RECORD_FIELDS} }
          }
        }`,
          variables: {
            snapshotKeys,
            recordKeys,
            includeSnapshots: snapshotKeys.length > 0,
          },
        },
        {
          next: ({ data }) => {
            const change = data?.githubPipelineStatusChanged;
            if (!change) return;
            if (
              change.snapshot &&
              snapshotWatches.current.has(snapshotKey(change.snapshot))
            )
              seedSnapshot(change.snapshot);
            const record = change.changedPipeline;
            if (
              record?.workflowRunId &&
              recordWatches.current.has(
                recordKey({ ...record, workflowRunId: record.workflowRunId }),
              )
            )
              seedRecord(record);
          },
          error: () => undefined,
          complete: () => undefined,
        },
      );
      subscription.current = { scope, dispose };
      // The server attaches its listener before replaying current revisions,
      // so replacing a scope cannot lose changes during registration.
      previous?.dispose();
    }
    const snapshotsToLoad = snapshotKeys.filter((key) =>
      pendingSnapshots.current.has(snapshotKey(key)),
    );
    const recordsToLoad = recordKeys.filter((key) =>
      pendingRecords.current.has(recordKey(key)),
    );
    pendingSnapshots.current.clear();
    pendingRecords.current.clear();
    void loadSnapshots(snapshotsToLoad);
    void loadRecords(recordsToLoad);
    setSnapshots((current) => {
      const next = new Map(
        [...current].filter(([id]) => snapshotWatches.current.has(id)),
      );
      return next.size === current.size ? current : next;
    });
    setRecords((current) => {
      const next = new Map(
        [...current].filter(([id]) => recordWatches.current.has(id)),
      );
      return next.size === current.size ? current : next;
    });
  }, [loadRecords, loadSnapshots, seedRecord, seedSnapshot]);

  const scheduleFlush = useCallback(() => {
    // Coalesce all row effects (including cleanup/re-registration) in a commit.
    if (flushTimer.current === null) flushTimer.current = setTimeout(flush, 0);
  }, [flush]);

  const reconcile = useCallback(() => {
    for (const id of snapshotWatches.current.keys())
      pendingSnapshots.current.add(id);
    for (const id of recordWatches.current.keys())
      pendingRecords.current.add(id);
    scheduleFlush();
  }, [scheduleFlush]);

  useEffect(() => {
    const unsubscribeConnection = onControlPlaneRecovery(reconcile, {
      includeInitial: true,
    });
    scheduleFlush();
    return () => {
      unsubscribeConnection();
      subscription.current?.dispose();
      subscription.current = null;
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      flushTimer.current = null;
    };
  }, [reconcile, scheduleFlush]);

  const watchSnapshot = useCallback(
    (key: GitHubPipelineStatusKeyInput) => {
      const id = snapshotKey(key);
      const existing = snapshotWatches.current.get(id);
      snapshotWatches.current.set(id, {
        key,
        count: (existing?.count ?? 0) + 1,
      });
      if (!existing) pendingSnapshots.current.add(id);
      scheduleFlush();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = snapshotWatches.current.get(id);
        if (!current || current.count <= 1) snapshotWatches.current.delete(id);
        else
          snapshotWatches.current.set(id, {
            ...current,
            count: current.count - 1,
          });
        scheduleFlush();
      };
    },
    [scheduleFlush],
  );

  const watchRecord = useCallback(
    (key: GitHubPipelineRecordKeyInput) => {
      const id = recordKey(key);
      const existing = recordWatches.current.get(id);
      recordWatches.current.set(id, {
        key,
        count: (existing?.count ?? 0) + 1,
      });
      if (!existing) pendingRecords.current.add(id);
      scheduleFlush();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = recordWatches.current.get(id);
        if (!current || current.count <= 1) recordWatches.current.delete(id);
        else
          recordWatches.current.set(id, {
            ...current,
            count: current.count - 1,
          });
        scheduleFlush();
      };
    },
    [scheduleFlush],
  );

  const value = useMemo(
    () => ({
      snapshots,
      records,
      seedSnapshot,
      seedRecord,
      watchSnapshot,
      watchRecord,
    }),
    [records, seedRecord, seedSnapshot, snapshots, watchRecord, watchSnapshot],
  );
  return (
    <PipelineStatusContext.Provider value={value}>
      {children}
    </PipelineStatusContext.Provider>
  );
}

function usePipelineStatusContext(): PipelineStatusContextValue | null {
  return useContext(PipelineStatusContext);
}

export function useGitHubPipelineSnapshot(
  key: GitHubPipelineStatusKeyInput | null,
  seed?: GitHubPipelineStatusSnapshotView | null,
): GitHubPipelineStatusSnapshotView | null {
  const context = usePipelineStatusContext();
  const id = key ? snapshotKey(key) : null;
  const seedSnapshot = context?.seedSnapshot;
  const watchSnapshot = context?.watchSnapshot;
  useEffect(() => {
    if (seed) seedSnapshot?.(seed);
  }, [seed, seedSnapshot]);
  useEffect(() => {
    if (!id || !watchSnapshot) return;
    const [repositoryGithubId, headSha] = id.split("\u0000");
    return watchSnapshot({ repositoryGithubId, headSha });
  }, [id, watchSnapshot]);
  return id ? latestSnapshotProjection(context?.snapshots.get(id), seed) : null;
}

export function useGitHubPipelineRecord(
  key: GitHubPipelineRecordKeyInput | null,
  seed?: GitHubPipelineRecordView | null,
): GitHubPipelineRecordView | null {
  const context = usePipelineStatusContext();
  const id = key ? recordKey(key) : null;
  const seedRecord = context?.seedRecord;
  const watchRecord = context?.watchRecord;
  useEffect(() => {
    if (seed) seedRecord?.(seed);
  }, [seed, seedRecord]);
  useEffect(() => {
    if (!id || !watchRecord) return;
    const [repositoryGithubId, workflowRunId] = id.split("\u0000");
    return watchRecord({ repositoryGithubId, workflowRunId });
  }, [id, watchRecord]);
  return id ? (context?.records.get(id) ?? seed ?? null) : null;
}

export function useGitHubPipelineRecords(
  keys: GitHubPipelineRecordKeyInput[],
  seeds: GitHubPipelineRecordView[] = [],
): Map<string, GitHubPipelineRecordView> {
  const context = usePipelineStatusContext();
  const ids = [...new Set(keys.map(recordKey))].sort().join("\u0001");
  const seedRecord = context?.seedRecord;
  const watchRecord = context?.watchRecord;
  useEffect(() => {
    for (const seed of seeds) seedRecord?.(seed);
  }, [seedRecord, seeds]);
  useEffect(() => {
    if (!watchRecord || !ids) return;
    const unwatch = ids.split("\u0001").map((id) => {
      const [repositoryGithubId, workflowRunId] = id.split("\u0000");
      return watchRecord({ repositoryGithubId, workflowRunId });
    });
    return () => {
      for (const dispose of unwatch) dispose();
    };
  }, [ids, watchRecord]);
  const result = new Map<string, GitHubPipelineRecordView>();
  for (const key of keys) {
    const id = recordKey(key);
    const value = context?.records.get(id);
    if (value) result.set(id, value);
  }
  return result;
}

export function gitHubPipelineRecordKey(
  key: GitHubPipelineRecordKeyInput,
): string {
  return recordKey(key);
}
