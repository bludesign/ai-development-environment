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
  onControlPlaneConnected,
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
      if (existing && existing.revision >= incoming.revision) return current;
      const next = new Map(current);
      next.set(key, incoming);
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
        for (const record of data.githubPipelineRecords) seedRecord(record);
      } catch {
        // Existing page data remains usable when local reconciliation fails.
      }
    },
    [seedRecord],
  );

  const reconcile = useCallback(() => {
    void loadSnapshots(
      [...snapshotWatches.current.values()].map(({ key }) => key),
    );
    void loadRecords([...recordWatches.current.values()].map(({ key }) => key));
  }, [loadRecords, loadSnapshots]);

  useEffect(() => {
    const unsubscribeConnection = onControlPlaneConnected(reconcile);
    const unsubscribeSubscription = controlPlaneSubscriptions().subscribe<{
      githubPipelineStatusChanged: GitHubPipelineStatusChangeView;
    }>(
      {
        query: `subscription GitHubPipelineStatusChanged {
          githubPipelineStatusChanged {
            snapshot { ${SNAPSHOT_FIELDS} }
            changedPipeline { ${RECORD_FIELDS} }
          }
        }`,
      },
      {
        next: ({ data }) => {
          const change = data?.githubPipelineStatusChanged;
          if (!change) return;
          seedSnapshot(change.snapshot);
          if (change.changedPipeline) seedRecord(change.changedPipeline);
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    reconcile();
    return () => {
      unsubscribeConnection();
      unsubscribeSubscription();
    };
  }, [reconcile, seedRecord, seedSnapshot]);

  const watchSnapshot = useCallback(
    (key: GitHubPipelineStatusKeyInput) => {
      const id = snapshotKey(key);
      const existing = snapshotWatches.current.get(id);
      snapshotWatches.current.set(id, {
        key,
        count: (existing?.count ?? 0) + 1,
      });
      if (!existing) void loadSnapshots([key]);
      return () => {
        const current = snapshotWatches.current.get(id);
        if (!current || current.count <= 1) snapshotWatches.current.delete(id);
        else
          snapshotWatches.current.set(id, {
            ...current,
            count: current.count - 1,
          });
      };
    },
    [loadSnapshots],
  );

  const watchRecord = useCallback(
    (key: GitHubPipelineRecordKeyInput) => {
      const id = recordKey(key);
      const existing = recordWatches.current.get(id);
      recordWatches.current.set(id, {
        key,
        count: (existing?.count ?? 0) + 1,
      });
      if (!existing) void loadRecords([key]);
      return () => {
        const current = recordWatches.current.get(id);
        if (!current || current.count <= 1) recordWatches.current.delete(id);
        else
          recordWatches.current.set(id, {
            ...current,
            count: current.count - 1,
          });
      };
    },
    [loadRecords],
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
  const ids = keys.map(recordKey).join("\u0001");
  const seedRecord = context?.seedRecord;
  const watchRecord = context?.watchRecord;
  useEffect(() => {
    if (!seedRecord || !watchRecord) return;
    for (const seed of seeds) seedRecord(seed);
    const unwatch = keys.map((key) => watchRecord(key));
    return () => {
      for (const dispose of unwatch) dispose();
    };
  }, [ids, keys, seedRecord, seeds, watchRecord]);
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
