"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentJob } from "@/components/agents/types";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

export type WorktreeFetchTarget = {
  codebaseId: string;
  repositoryName: string;
  agentName: string;
  folder: string;
};

export type WorktreeFetchRow = WorktreeFetchTarget & {
  status:
    | AgentJob["status"]
    | "STARTING"
    | "SKIPPED"
    | "UNREPORTED"
    | "SUBMISSION_FAILED";
  jobId: string | null;
  error: string | null;
  skipReason: string | null;
  worktreesRefreshedAt: string | null;
  worktreeRefreshError: string | null;
};

export type WorktreeFetchBatch = {
  id: string;
  phase: "starting" | "fetching" | "refreshing" | "finished" | "refreshFailed";
  rows: WorktreeFetchRow[];
  monitoringError: string | null;
  monitoringMissingJobs: number;
  pageUpdateError: string | null;
  legacyRefreshRequested: boolean;
  legacyRefreshError: string | null;
};

type FetchJob = Pick<
  AgentJob,
  "id" | "agentId" | "payload" | "status" | "error" | "result" | "updatedAt"
>;

const JOB_FIELDS = "id agentId payload status error result updatedAt";
const TERMINAL_STATUSES = new Set<AgentJob["status"]>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);
const ACTIVE_PHASES = new Set<WorktreeFetchBatch["phase"]>([
  "starting",
  "fetching",
  "refreshing",
]);
const JOB_STATUS_ORDER: Record<AgentJob["status"], number> = {
  QUEUED: 0,
  RUNNING: 1,
  CANCELLING: 2,
  SUCCEEDED: 3,
  FAILED: 3,
  CANCELLED: 3,
  TIMED_OUT: 3,
};

type FetchRun = {
  scopeKey: string | undefined;
  batch: WorktreeFetchBatch;
  jobs: Map<string, FetchJob>;
  controller: AbortController;
  monitor: RefreshCoalescer | null;
  interval: number | null;
  unsubscribeRecovery: (() => void) | null;
  subscriptions: Map<string, () => void>;
  refreshPage: () => Promise<void>;
};

function stopMonitoring(run: FetchRun) {
  run.monitor?.dispose();
  run.monitor = null;
  if (run.interval !== null) window.clearInterval(run.interval);
  run.interval = null;
  run.unsubscribeRecovery?.();
  run.unsubscribeRecovery = null;
  run.subscriptions.forEach((unsubscribe) => unsubscribe());
  run.subscriptions.clear();
}

function disposeRun(run: FetchRun) {
  run.controller.abort();
  stopMonitoring(run);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map(errorMessage).join("; ");
  return text(record(value).message) ?? String(value);
}

function jobRow(target: WorktreeFetchTarget, job: FetchJob): WorktreeFetchRow {
  const result = record(job.result);
  return {
    ...target,
    status: job.status,
    jobId: job.id,
    error: text(record(result.snapshot).error) ?? job.error,
    skipReason: null,
    worktreesRefreshedAt: text(result.worktreesRefreshedAt),
    worktreeRefreshError: text(result.worktreeRefreshError),
  };
}

/** Track only this page's explicit fetch batch; leaving the page never cancels jobs. */
export function useWorktreeFetch({
  scopeKey,
  refreshPage,
}: {
  scopeKey?: string;
  refreshPage: () => Promise<void>;
}) {
  const [state, setState] = useState<{
    scopeKey: string | undefined;
    batch: WorktreeFetchBatch;
  } | null>(null);
  const current = useRef<FetchRun | null>(null);
  const mountedScope = useRef<{ scopeKey: string | undefined } | null>(null);

  // Discard the old display as well as its monitor. Returning to the same app
  // later must not resurrect a batch whose monitoring has already stopped.
  if (state && state.scopeKey !== scopeKey) setState(null);

  useEffect(() => {
    const scope = { scopeKey };
    mountedScope.current = scope;
    return () => {
      if (mountedScope.current !== scope) return;
      mountedScope.current = null;
      if (current.current) disposeRun(current.current);
      current.current = null;
    };
  }, [scopeKey]);

  const isCurrent = useCallback(
    (run: FetchRun) =>
      current.current === run &&
      !run.controller.signal.aborted &&
      mountedScope.current?.scopeKey === run.scopeKey &&
      mountedScope.current !== null,
    [],
  );
  const publish = useCallback(
    (run: FetchRun, change: Partial<WorktreeFetchBatch>) => {
      if (!isCurrent(run)) return;
      run.batch = { ...run.batch, ...change };
      setState({ scopeKey: run.scopeKey, batch: run.batch });
    },
    [isCurrent],
  );

  const updatePage = useCallback(
    async (run: FetchRun) => {
      if (!isCurrent(run)) return;
      stopMonitoring(run);
      publish(run, {
        phase: "refreshing",
        monitoringError: null,
        monitoringMissingJobs: 0,
        pageUpdateError: null,
      });
      const legacy = run.batch.rows.some(
        (row) =>
          row.status === "SUCCEEDED" &&
          !row.worktreesRefreshedAt &&
          !row.worktreeRefreshError,
      );
      if (legacy && !run.batch.legacyRefreshRequested) {
        publish(run, { legacyRefreshRequested: true });
        try {
          await controlPlaneRequest(
            "mutation RefreshWorktreesAfterFetch { refreshWorktrees }",
            undefined,
            { signal: run.controller.signal },
          );
        } catch (value) {
          if (!isCurrent(run)) return;
          publish(run, { legacyRefreshError: errorMessage(value) });
        }
      }
      if (!isCurrent(run)) return;
      try {
        await run.refreshPage();
        publish(run, { phase: "finished" });
      } catch (value) {
        publish(run, {
          phase: "refreshFailed",
          pageUpdateError: errorMessage(value),
        });
      }
    },
    [isCurrent, publish],
  );

  const start = useCallback(
    async (targets: WorktreeFetchTarget[]) => {
      if (
        !mountedScope.current ||
        mountedScope.current.scopeKey !== scopeKey ||
        (current.current && ACTIVE_PHASES.has(current.current.batch.phase))
      )
        return;
      const unique = [
        ...new Map(
          targets.map((target) => [target.codebaseId, target]),
        ).values(),
      ];
      if (!unique.length) return;
      if (current.current) disposeRun(current.current);
      const run: FetchRun = {
        scopeKey,
        controller: new AbortController(),
        jobs: new Map(),
        monitor: null,
        interval: null,
        unsubscribeRecovery: null,
        subscriptions: new Map(),
        refreshPage,
        batch: {
          id: createClientId(),
          phase: "starting",
          rows: unique.map((target) => ({
            ...target,
            status: "STARTING",
            jobId: null,
            error: null,
            skipReason: null,
            worktreesRefreshedAt: null,
            worktreeRefreshError: null,
          })),
          monitoringError: null,
          monitoringMissingJobs: 0,
          pageUpdateError: null,
          legacyRefreshRequested: false,
          legacyRefreshError: null,
        },
      };
      current.current = run;
      publish(run, {});

      // The mutation caps each request at 500 codebases. Keep every target in the
      // batch even when submission fails or the server omits an outcome.
      for (let offset = 0; offset < unique.length; offset += 500) {
        const ids = unique
          .slice(offset, offset + 500)
          .map((target) => target.codebaseId);
        const requested = new Set(ids);
        try {
          const data = await controlPlaneRequest<{
            fetchCodebases: {
              jobs: FetchJob[];
              skipped: Array<{ codebaseId: string; reason: string }>;
            };
          }>(
            `mutation FetchWorktreeCodebases($input: RunCodebaseOperationInput!) {
              fetchCodebases(input: $input) {
                jobs { ${JOB_FIELDS} }
                skipped { codebaseId reason }
              }
            }`,
            { input: { codebaseIds: ids, requestId: run.batch.id } },
            { signal: run.controller.signal },
          );
          if (!isCurrent(run)) return;
          const byCodebase = new Map<string, FetchJob>();
          for (const job of data.fetchCodebases.jobs) {
            const codebaseId = text(record(job.payload).codebaseId);
            if (!codebaseId || !requested.has(codebaseId)) continue;
            byCodebase.set(codebaseId, job);
            run.jobs.set(job.id, job);
          }
          const skipped = new Map(
            data.fetchCodebases.skipped.map((skip) => [
              skip.codebaseId,
              skip.reason,
            ]),
          );
          publish(run, {
            rows: run.batch.rows.map((row) => {
              if (!requested.has(row.codebaseId)) return row;
              const job = byCodebase.get(row.codebaseId);
              if (job) return jobRow(row, job);
              const reason = skipped.get(row.codebaseId);
              return {
                ...row,
                status: reason === undefined ? "UNREPORTED" : "SKIPPED",
                skipReason: reason ?? null,
              };
            }),
          });
        } catch (value) {
          if (!isCurrent(run)) return;
          publish(run, {
            rows: run.batch.rows.map((row) =>
              requested.has(row.codebaseId)
                ? {
                    ...row,
                    status: "SUBMISSION_FAILED",
                    error: errorMessage(value),
                  }
                : row,
            ),
          });
        }
      }
      if (!isCurrent(run)) return;
      publish(run, { phase: "fetching" });

      const pendingIds = () =>
        [...run.jobs.values()]
          .filter((job) => !TERMINAL_STATUSES.has(job.status))
          .map((job) => job.id);
      const finishIfSettled = () => {
        if (
          isCurrent(run) &&
          run.batch.phase === "fetching" &&
          !pendingIds().length
        )
          void updatePage(run);
      };
      const applyJobs = (jobs: FetchJob[]) => {
        if (!isCurrent(run) || run.batch.phase !== "fetching") return;
        for (const job of jobs) {
          const previous = run.jobs.get(job.id);
          if (
            !previous ||
            (TERMINAL_STATUSES.has(previous.status) &&
              previous.status !== job.status) ||
            JOB_STATUS_ORDER[job.status] < JOB_STATUS_ORDER[previous.status] ||
            Date.parse(job.updatedAt) < Date.parse(previous.updatedAt)
          )
            continue;
          run.jobs.set(job.id, job);
          if (TERMINAL_STATUSES.has(job.status)) {
            run.subscriptions.get(job.id)?.();
            run.subscriptions.delete(job.id);
          }
        }
        publish(run, {
          rows: run.batch.rows.map((row) => {
            const job = row.jobId ? run.jobs.get(row.jobId) : null;
            return job ? jobRow(row, job) : row;
          }),
        });
      };
      if (!pendingIds().length) {
        finishIfSettled();
        return;
      }
      const owner = createRefreshCoalescer(async (signal) => {
        let missing = 0;
        try {
          const ids = pendingIds();
          for (let offset = 0; offset < ids.length; offset += 200) {
            const requested = ids.slice(offset, offset + 200);
            const data = await controlPlaneRequest<{
              agentJobsByIds: FetchJob[];
            }>(
              `query WorktreeFetchJobs($ids: [ID!]!) {
                agentJobsByIds(ids: $ids) { ${JOB_FIELDS} }
              }`,
              { ids: requested },
              { signal },
            );
            if (signal.aborted || !isCurrent(run)) return;
            const returned = new Set(data.agentJobsByIds.map((job) => job.id));
            missing += requested.filter(
              (id) =>
                !returned.has(id) &&
                !TERMINAL_STATUSES.has(run.jobs.get(id)!.status),
            ).length;
            applyJobs(data.agentJobsByIds);
          }
          publish(run, {
            monitoringError: null,
            monitoringMissingJobs: missing,
          });
        } catch (value) {
          if (signal.aborted || !isCurrent(run)) return;
          publish(run, { monitoringError: errorMessage(value) });
        }
        finishIfSettled();
      });
      run.monitor = owner;
      const client = controlPlaneSubscriptions();
      for (const jobId of pendingIds()) {
        const unsubscribe = client.subscribe<{ agentJobChanged: FetchJob }>(
          {
            query: `subscription WorktreeFetchJobChanged($jobId: ID!) {
              agentJobChanged(jobId: $jobId) { ${JOB_FIELDS} }
            }`,
            variables: { jobId },
          },
          {
            next: (value) => {
              if (!isCurrent(run)) return;
              if (value.data?.agentJobChanged) {
                applyJobs([value.data.agentJobChanged]);
                finishIfSettled();
              }
            },
            error: (value) => {
              if (!isCurrent(run) || run.batch.phase !== "fetching") return;
              publish(run, { monitoringError: errorMessage(value) });
              void owner.refresh();
            },
            complete: () => {
              if (isCurrent(run) && run.batch.phase === "fetching")
                void owner.refresh();
            },
          },
        );
        if (
          !isCurrent(run) ||
          run.batch.phase !== "fetching" ||
          TERMINAL_STATUSES.has(run.jobs.get(jobId)!.status)
        )
          unsubscribe();
        else run.subscriptions.set(jobId, unsubscribe);
      }
      if (!isCurrent(run) || run.batch.phase !== "fetching") return;
      run.interval = window.setInterval(() => void owner.refresh(), 2_000);
      run.unsubscribeRecovery = onControlPlaneRecovery(
        () => void owner.refresh(),
      );
      void owner.refresh();
    },
    [isCurrent, publish, refreshPage, scopeKey, updatePage],
  );

  const retryPageUpdate = useCallback(async () => {
    const run = current.current;
    if (run && isCurrent(run) && run.batch.phase === "refreshFailed")
      await updatePage(run);
  }, [isCurrent, updatePage]);

  const dismiss = useCallback(() => {
    const run = current.current;
    if (!run || ACTIVE_PHASES.has(run.batch.phase)) return;
    disposeRun(run);
    current.current = null;
    setState(null);
  }, []);

  const batch = state && state.scopeKey === scopeKey ? state.batch : null;
  return {
    batch,
    active: batch !== null && ACTIVE_PHASES.has(batch.phase),
    start,
    retryPageUpdate,
    dismiss,
  };
}
