"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";
import type { Worktree, WorktreeOverview } from "./types";
import type { GitLabMergeRequestSummaryField } from "@/services/gitlab/types";
import {
  PULL_REQUEST_FIELDS,
  SOURCE_CONTROL_REQUEST_FIELDS,
  GITLAB_PIPELINE_STATUS_FIELDS,
} from "./worktree-graphql";

export const ENRICHMENT_KINDS = [
  "GITHUB",
  "GITLAB_MERGE_REQUESTS",
  "GITLAB_PIPELINES",
  "JIRA",
] as const;
export type EnrichmentKind = (typeof ENRICHMENT_KINDS)[number];
export type LoadingStage = "SAVED" | EnrichmentKind;
export type LoadTiming = {
  status: "pending" | "running" | "complete" | "warning" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  warnings: string[];
};
export type LoadTimings = Record<LoadingStage, LoadTiming>;
const initialTiming = (): LoadTiming => ({
  status: "pending",
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  warnings: [],
});
const initialTimings = (): LoadTimings => ({
  SAVED: initialTiming(),
  GITHUB: initialTiming(),
  GITLAB_MERGE_REQUESTS: initialTiming(),
  GITLAB_PIPELINES: initialTiming(),
  JIRA: initialTiming(),
});

type Identity = Pick<
  Worktree,
  "id" | "codebaseId" | "branch" | "headSha" | "ticketKey"
> & {
  canonicalOrigin: string;
};
type Update = { canonicalOrigin: string; worktree: Worktree };
type EnrichmentWarning = {
  worktreeId: string;
  message: string;
  preserveFields?: GitLabMergeRequestSummaryField[];
};
type Enrichment = {
  updates: Update[];
  durationMs: number;
  warnings: EnrichmentWarning[];
};

function indexed(overview: WorktreeOverview | null) {
  return new Map(
    overview?.agents.flatMap(({ codebases }) =>
      codebases.flatMap(({ repository, worktrees }) =>
        worktrees.map(
          (worktree) =>
            [
              worktree.id,
              { ...worktree, canonicalOrigin: repository.canonicalOrigin },
            ] as const,
        ),
      ),
    ) ?? [],
  );
}
function sameIdentity(a: Identity | undefined, b: Identity) {
  return (
    a?.id === b.id &&
    a.codebaseId === b.codebaseId &&
    a.branch === b.branch &&
    a.headSha === b.headSha &&
    a.canonicalOrigin === b.canonicalOrigin
  );
}
function metadata(
  worktree: Worktree,
  kind?: EnrichmentKind,
): Partial<Worktree> {
  switch (kind) {
    case "GITHUB":
      return {
        pullRequest: worktree.pullRequest,
        sourceControlRequest: worktree.sourceControlRequest,
        canAssignReviewers: worktree.canAssignReviewers,
      };
    case "GITLAB_MERGE_REQUESTS":
      return {
        sourceControlRequest: worktree.sourceControlRequest,
        canAssignReviewers: worktree.canAssignReviewers,
      };
    case "GITLAB_PIPELINES":
      return { gitLabPipelines: worktree.gitLabPipelines };
    case "JIRA":
      return {
        ticketTitle: worktree.ticketTitle,
        ticketStatus: worktree.ticketStatus,
      };
    default:
      return {
        ...metadata(worktree, "GITHUB"),
        ...metadata(worktree, "GITLAB_PIPELINES"),
        ...metadata(worktree, "JIRA"),
      };
  }
}

/** Preserve good metadata across saved reads without carrying it to a new checkout identity. */
export function preserveWorktreeMetadata(
  previous: WorktreeOverview | null,
  next: WorktreeOverview,
): WorktreeOverview {
  const existing = indexed(previous);
  return {
    ...next,
    agents: next.agents.map((agent) => ({
      ...agent,
      codebases: agent.codebases.map((group) => ({
        ...group,
        worktrees: group.worktrees.map((worktree) => {
          const old = existing.get(worktree.id);
          return sameIdentity(old, {
            ...worktree,
            canonicalOrigin: group.repository.canonicalOrigin,
          })
            ? {
                ...worktree,
                ...metadata(old!),
                ...(old!.ticketKey !== worktree.ticketKey
                  ? {
                      ticketTitle: worktree.ticketTitle,
                      ticketStatus: worktree.ticketStatus,
                    }
                  : {}),
              }
            : worktree;
        }),
      })),
    })),
  };
}

export function mergeWorktreeEnrichment(
  current: WorktreeOverview,
  updates: Update[],
  kind: EnrichmentKind,
  requested: Map<string, Identity>,
  warnings: EnrichmentWarning[] = [],
): WorktreeOverview {
  const byId = new Map(updates.map((update) => [update.worktree.id, update]));
  return {
    ...current,
    agents: current.agents.map((agent) => ({
      ...agent,
      codebases: agent.codebases.map((group) => ({
        ...group,
        worktrees: group.worktrees.map((worktree) => {
          const update = byId.get(worktree.id);
          if (!update) return worktree;
          const identity = {
            ...update.worktree,
            canonicalOrigin: update.canonicalOrigin,
          };
          if (
            !sameIdentity(requested.get(worktree.id), identity) ||
            !sameIdentity(
              {
                ...worktree,
                canonicalOrigin: group.repository.canonicalOrigin,
              },
              identity,
            ) ||
            (kind === "JIRA" &&
              (requested.get(worktree.id)?.ticketKey !== identity.ticketKey ||
                worktree.ticketKey !== identity.ticketKey))
          )
            return worktree;
          const refreshed = metadata(update.worktree, kind);
          const previousRequest = worktree.sourceControlRequest;
          const nextRequest = refreshed.sourceControlRequest;
          if (
            kind === "GITLAB_MERGE_REQUESTS" &&
            previousRequest?.provider === "GITLAB" &&
            nextRequest?.provider === "GITLAB" &&
            previousRequest.id === nextRequest.id &&
            previousRequest.projectId === nextRequest.projectId &&
            previousRequest.headRefOid === nextRequest.headRefOid
          ) {
            const preserveFields = new Set(
              warnings
                .filter((warning) => warning.worktreeId === worktree.id)
                .flatMap((warning) => warning.preserveFields ?? []),
            );
            refreshed.sourceControlRequest = {
              ...nextRequest,
              ...(preserveFields.has("APPROVAL_STATE") &&
              nextRequest.approvalState == null
                ? { approvalState: previousRequest.approvalState ?? null }
                : {}),
              ...(preserveFields.has("UNRESOLVED_DISCUSSIONS_COUNT") &&
              nextRequest.unresolvedDiscussionsCount == null
                ? {
                    unresolvedDiscussionsCount:
                      previousRequest.unresolvedDiscussionsCount ?? null,
                  }
                : {}),
            };
          }
          return { ...worktree, ...refreshed };
        }),
      })),
    })),
  };
}

const fields: Record<EnrichmentKind, string> = {
  GITHUB: `canAssignReviewers pullRequest { ${PULL_REQUEST_FIELDS} } sourceControlRequest { ${SOURCE_CONTROL_REQUEST_FIELDS} }`,
  GITLAB_MERGE_REQUESTS: `canAssignReviewers sourceControlRequest { ${SOURCE_CONTROL_REQUEST_FIELDS} }`,
  GITLAB_PIPELINES: `gitLabPipelines { ${GITLAB_PIPELINE_STATUS_FIELDS} }`,
  JIRA: "ticketTitle ticketStatus",
};

export function useWorktreeLoading(
  appId: string | undefined,
  setOverview: Dispatch<SetStateAction<WorktreeOverview | null>>,
) {
  const [state, setState] = useState<{
    scope: string | undefined;
    timings: LoadTimings;
  }>(() => ({ scope: appId, timings: initialTimings() }));
  const scope = useRef<{
    appId?: string;
    active: boolean;
    force: boolean;
    snapshot: WorktreeOverview | null;
    timer: ReturnType<typeof setTimeout> | null;
    owners: Map<EnrichmentKind, { owner: RefreshCoalescer; force: boolean }>;
  } | null>(null);

  useEffect(() => {
    const lifetime = {
      appId,
      active: true,
      force: false,
      snapshot: null as WorktreeOverview | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      owners: new Map<
        EnrichmentKind,
        { owner: RefreshCoalescer; force: boolean }
      >(),
    };
    scope.current = lifetime;
    return () => {
      lifetime.active = false;
      if (lifetime.timer !== null) clearTimeout(lifetime.timer);
      lifetime.owners.forEach(({ owner }) => owner.dispose());
      if (scope.current === lifetime) scope.current = null;
    };
  }, [appId]);

  const mark = useCallback(
    (stage: LoadingStage, patch: Partial<LoadTiming>) => {
      const lifetime = scope.current;
      if (!lifetime?.active) return;
      setState((previous) => {
        const timings =
          previous.scope === lifetime.appId
            ? previous.timings
            : initialTimings();
        return {
          scope: lifetime.appId,
          timings: { ...timings, [stage]: { ...timings[stage], ...patch } },
        };
      });
    },
    [],
  );

  const refreshKind = useCallback(
    (kind: EnrichmentKind, force = false) => {
      const lifetime = scope.current;
      if (!lifetime?.active) return;
      let entry = lifetime.owners.get(kind);
      if (!entry) {
        entry = {
          force: false,
          owner: createRefreshCoalescer(async (signal) => {
            const forced = lifetime.owners.get(kind)!.force;
            lifetime.owners.get(kind)!.force = false;
            const requested = indexed(lifetime.snapshot);
            const startedAt = Date.now();
            mark(kind, {
              status: "running",
              startedAt,
              finishedAt: null,
              durationMs: null,
              warnings: [],
            });
            try {
              const { worktreeEnrichment } = await controlPlaneRequest<{
                worktreeEnrichment: Enrichment;
              }>(
                `query WorktreeEnrichment($appId: ID, $kind: WorktreeEnrichmentKind!, $force: Boolean!) {
              worktreeEnrichment(appId: $appId, kind: $kind, force: $force) {
                durationMs warnings { worktreeId message preserveFields }
                updates { canonicalOrigin worktree { id codebaseId branch headSha ticketKey ${fields[kind]} } }
              }
            }`,
                { appId: lifetime.appId ?? null, kind, force: forced },
                { signal },
              );
              if (!lifetime.active || signal.aborted) return;
              const { updates, warnings, durationMs } = worktreeEnrichment;
              setOverview((current) =>
                lifetime.active && current
                  ? mergeWorktreeEnrichment(
                      current,
                      updates,
                      kind,
                      requested,
                      warnings,
                    )
                  : current,
              );
              mark(kind, {
                status: warnings.length ? "warning" : "complete",
                finishedAt: Date.now(),
                durationMs,
                warnings: warnings.map(
                  (warning) =>
                    `${requested.get(warning.worktreeId)?.branch ?? warning.worktreeId}: ${warning.message}`,
                ),
              });
            } catch (value) {
              if (!lifetime.active || signal.aborted) return;
              mark(kind, {
                status: "failed",
                finishedAt: Date.now(),
                warnings: [
                  value instanceof Error ? value.message : String(value),
                ],
              });
            }
          }),
        };
        lifetime.owners.set(kind, entry);
      }
      entry.force ||= force;
      void entry.owner.refresh();
    },
    [mark, setOverview],
  );

  const saved = useCallback(
    (snapshot: WorktreeOverview) => {
      const lifetime = scope.current;
      if (!lifetime?.active) return;
      lifetime.snapshot = snapshot;
      mark("SAVED", {
        status: "complete",
        finishedAt: Date.now(),
        durationMs: snapshot.durationMs ?? null,
      });
      if (lifetime.timer !== null) clearTimeout(lifetime.timer);
      lifetime.timer = setTimeout(() => {
        lifetime.timer = null;
        if (!lifetime.active) return;
        const force = lifetime.force;
        lifetime.force = false;
        for (const kind of ENRICHMENT_KINDS) refreshKind(kind, force);
      }, 0);
    },
    [mark, refreshKind],
  );

  return {
    timings: state.scope === appId ? state.timings : initialTimings(),
    begin: useCallback(
      () =>
        mark("SAVED", {
          status: "running",
          startedAt: Date.now(),
          finishedAt: null,
          durationMs: null,
          warnings: [],
        }),
      [mark],
    ),
    failed: useCallback(
      (message: string) =>
        mark("SAVED", {
          status: "failed",
          finishedAt: Date.now(),
          warnings: [message],
        }),
      [mark],
    ),
    forceNext: useCallback(() => {
      if (scope.current) scope.current.force = true;
    }, []),
    saved,
    retry: useCallback(
      (kind: EnrichmentKind) => refreshKind(kind, true),
      [refreshKind],
    ),
  };
}
