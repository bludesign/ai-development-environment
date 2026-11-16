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
import type {
  Worktree,
  WorktreeOverview,
  WorktreeSourceControlRequest,
} from "./types";
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
  status: "pending" | "running" | "complete" | "warning" | "failed" | "skipped";
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

/** Which optional integrations are connected; an unconnected one is never asked. */
export type IntegrationAvailability = {
  github: boolean;
  gitlab: boolean;
  jira: boolean;
};
const INTEGRATION_FOR: Record<EnrichmentKind, keyof IntegrationAvailability> = {
  GITHUB: "github",
  GITLAB_MERGE_REQUESTS: "gitlab",
  GITLAB_PIPELINES: "gitlab",
  JIRA: "jira",
};
/**
 * Saved reads repeat every few seconds while agents report. Optional metadata
 * is read again only when what it describes changed, or after this long.
 */
export const ENRICHMENT_MAX_AGE_MS = 60_000;

type Identity = Pick<
  Worktree,
  "id" | "codebaseId" | "branch" | "headSha" | "ticketKey"
> & {
  canonicalOrigin: string;
};
type IndexedWorktree = Worktree & Pick<Identity, "canonicalOrigin">;
type WorktreeMetadata = Pick<
  Worktree,
  | "pullRequest"
  | "sourceControlRequest"
  | "canAssignReviewers"
  | "gitLabPipelines"
  | "ticketTitle"
  | "ticketStatus"
>;
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
/** What one kind of metadata describes; a change means it must be read again. */
function enrichmentSubject(
  overview: WorktreeOverview | null,
  kind: EnrichmentKind,
): string {
  return [...indexed(overview).values()]
    .map((worktree) =>
      kind === "JIRA"
        ? [worktree.id, worktree.ticketKey ?? ""]
        : [
            worktree.id,
            worktree.codebaseId,
            worktree.branch ?? "",
            worktree.headSha ?? "",
            worktree.canonicalOrigin,
          ],
    )
    .map((parts) => parts.join("\u0000"))
    .sort()
    .join("\u0001");
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
): Partial<WorktreeMetadata> {
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

/** Keep metadata from enrichment where the raw saved value has not changed. */
function unchangedSavedFields(
  enriched: Partial<WorktreeMetadata>,
  before: WorktreeMetadata,
  saved: WorktreeMetadata,
): Partial<WorktreeMetadata> {
  return Object.fromEntries(
    Object.entries(enriched).filter(([key]) => {
      const field = key as keyof WorktreeMetadata;
      return JSON.stringify(before[field]) === JSON.stringify(saved[field]);
    }),
  );
}

const GITLAB_SUMMARY_FIELDS: GitLabMergeRequestSummaryField[] = [
  "APPROVAL_STATE",
  "UNRESOLVED_DISCUSSIONS_COUNT",
];

function retainGitLabSummary(
  previous: WorktreeSourceControlRequest | null,
  next: WorktreeSourceControlRequest | null,
  fields: readonly GitLabMergeRequestSummaryField[],
) {
  if (
    previous?.provider !== "GITLAB" ||
    next?.provider !== "GITLAB" ||
    previous.id !== next.id ||
    previous.projectId !== next.projectId ||
    previous.headRefOid !== next.headRefOid
  )
    return next;
  return {
    ...next,
    ...(fields.includes("APPROVAL_STATE") && next.approvalState == null
      ? { approvalState: previous.approvalState ?? null }
      : {}),
    ...(fields.includes("UNRESOLVED_DISCUSSIONS_COUNT") &&
    next.unresolvedDiscussionsCount == null
      ? {
          unresolvedDiscussionsCount:
            previous.unresolvedDiscussionsCount ?? null,
        }
      : {}),
  };
}

/** A stored GitLab pipeline includes its state, with only a subset of its details. */
function mergeSavedPipelines(
  previous: Worktree["gitLabPipelines"],
  saved: Worktree["gitLabPipelines"],
): Worktree["gitLabPipelines"] {
  const byId = new Map(
    previous.map((item) => [`${item.projectId}:${item.id}`, item]),
  );
  return saved.map((pipeline) => {
    const detail = byId.get(`${pipeline.projectId}:${pipeline.id}`);
    if (!detail) return pipeline;
    return {
      ...detail,
      ...pipeline,
      iid: pipeline.iid ?? detail.iid,
      mergeRequests: detail.mergeRequests,
      startedAt: pipeline.startedAt ?? detail.startedAt,
      createdAt: pipeline.createdAt ?? detail.createdAt,
      finishedAt: pipeline.finishedAt ?? detail.finishedAt,
      duration: pipeline.duration ?? detail.duration,
      queuedDuration: pipeline.queuedDuration ?? detail.queuedDuration,
    };
  });
}

export function preserveWorktreeMetadata(
  previous: WorktreeOverview | null,
  next: WorktreeOverview,
  lastSaved: WorktreeOverview | null,
): WorktreeOverview {
  if (!previous || !lastSaved) return next;
  const existing = indexed(previous);
  const saved = indexed(lastSaved);
  return {
    ...next,
    agents: next.agents.map((agent) => ({
      ...agent,
      codebases: agent.codebases.map((group) => ({
        ...group,
        worktrees: group.worktrees.map((worktree) => {
          const old = existing.get(worktree.id);
          const before = saved.get(worktree.id);
          const identity = {
            ...worktree,
            canonicalOrigin: group.repository.canonicalOrigin,
          };
          if (
            !old ||
            !before ||
            !sameIdentity(old, identity) ||
            !sameIdentity(before, identity)
          )
            return worktree;
          const retained = unchangedSavedFields(
            metadata(old),
            before,
            worktree,
          );
          const result = { ...worktree, ...retained };
          if (old.ticketKey !== worktree.ticketKey) {
            result.ticketTitle = worktree.ticketTitle;
            result.ticketStatus = worktree.ticketStatus;
          }
          result.sourceControlRequest = retainGitLabSummary(
            old.sourceControlRequest,
            result.sourceControlRequest,
            GITLAB_SUMMARY_FIELDS,
          );
          if (
            retained.gitLabPipelines === undefined &&
            worktree.gitLabPipelines
          )
            result.gitLabPipelines = mergeSavedPipelines(
              old.gitLabPipelines ?? [],
              worktree.gitLabPipelines,
            );
          return result;
        }),
      })),
    })),
  };
}

export function mergeWorktreeEnrichment(
  current: WorktreeOverview,
  updates: Update[],
  kind: EnrichmentKind,
  requested: ReadonlyMap<string, IndexedWorktree>,
  warnings: EnrichmentWarning[] = [],
  latestSaved?: ReadonlyMap<string, IndexedWorktree>,
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
          const before = requested.get(worktree.id);
          if (
            !before ||
            !sameIdentity(before, identity) ||
            !sameIdentity(
              {
                ...worktree,
                canonicalOrigin: group.repository.canonicalOrigin,
              },
              identity,
            ) ||
            (kind === "JIRA" &&
              (before.ticketKey !== identity.ticketKey ||
                worktree.ticketKey !== identity.ticketKey))
          )
            return worktree;
          const refreshed = metadata(update.worktree, kind);
          const previousRequest = worktree.sourceControlRequest;
          const nextRequest = refreshed.sourceControlRequest;
          if (
            (kind === "GITHUB" &&
              (previousRequest?.provider === "GITLAB" ||
                nextRequest?.provider === "GITLAB")) ||
            (kind === "GITLAB_MERGE_REQUESTS" &&
              previousRequest?.provider === "GITHUB" &&
              nextRequest?.provider !== "GITLAB")
          ) {
            // The provider's lookup can return the stored request of the other provider.
            delete refreshed.sourceControlRequest;
            delete refreshed.canAssignReviewers;
          } else if (kind === "GITLAB_MERGE_REQUESTS" && nextRequest) {
            refreshed.sourceControlRequest = retainGitLabSummary(
              previousRequest,
              nextRequest,
              warnings
                .filter((warning) => warning.worktreeId === worktree.id)
                .flatMap((warning) => warning.preserveFields ?? []),
            );
          }
          const saved = latestSaved?.get(worktree.id);
          return {
            ...worktree,
            ...(saved
              ? unchangedSavedFields(refreshed, before, saved)
              : refreshed),
          };
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

type KindEntry = {
  owner: RefreshCoalescer;
  force: boolean;
  /** What the last read described, or null when it must be read again. */
  subject: string | null;
  startedAt: number;
};

export function useWorktreeLoading(
  appId: string | undefined,
  setOverview: Dispatch<SetStateAction<WorktreeOverview | null>>,
  {
    worktreeId,
    integrations,
  }: {
    /** Scope to the repository that contains this worktree. */
    worktreeId?: string;
    /** "pending" holds optional metadata until the answer is known. */
    integrations?: IntegrationAvailability | "pending";
  } = {},
) {
  const scopeKey = `${appId ?? ""}\u0000${worktreeId ?? ""}`;
  const [state, setState] = useState<{
    scope: string;
    timings: LoadTimings;
  }>(() => ({ scope: scopeKey, timings: initialTimings() }));
  const scope = useRef<{
    key: string;
    appId?: string;
    worktreeId?: string;
    active: boolean;
    force: boolean;
    snapshot: WorktreeOverview | null;
    timer: ReturnType<typeof setTimeout> | null;
    owners: Map<EnrichmentKind, KindEntry>;
    skipped: Set<EnrichmentKind>;
  } | null>(null);
  const availability = useRef(integrations);

  useEffect(() => {
    const lifetime = {
      key: scopeKey,
      appId,
      worktreeId,
      active: true,
      force: false,
      snapshot: null as WorktreeOverview | null,
      timer: null as ReturnType<typeof setTimeout> | null,
      owners: new Map<EnrichmentKind, KindEntry>(),
      skipped: new Set<EnrichmentKind>(),
    };
    scope.current = lifetime;
    return () => {
      lifetime.active = false;
      if (lifetime.timer !== null) clearTimeout(lifetime.timer);
      lifetime.owners.forEach(({ owner }) => owner.dispose());
      if (scope.current === lifetime) scope.current = null;
    };
  }, [appId, scopeKey, worktreeId]);

  const mark = useCallback(
    (stage: LoadingStage, patch: Partial<LoadTiming>) => {
      const lifetime = scope.current;
      if (!lifetime?.active) return;
      setState((previous) => {
        const timings =
          previous.scope === lifetime.key ? previous.timings : initialTimings();
        return {
          scope: lifetime.key,
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
          subject: null,
          startedAt: 0,
          owner: createRefreshCoalescer(async (signal) => {
            const forced = lifetime.owners.get(kind)!.force;
            lifetime.owners.get(kind)!.force = false;
            const snapshot = lifetime.snapshot;
            const requested = indexed(snapshot);
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
                `query WorktreeEnrichment($appId: ID, $worktreeId: ID, $kind: WorktreeEnrichmentKind!, $force: Boolean!) {
              worktreeEnrichment(appId: $appId, worktreeId: $worktreeId, kind: $kind, force: $force) {
                durationMs warnings { worktreeId message preserveFields }
                updates { canonicalOrigin worktree { id codebaseId branch headSha ticketKey ${fields[kind]} } }
              }
            }`,
                {
                  appId: lifetime.appId ?? null,
                  worktreeId: lifetime.worktreeId ?? null,
                  kind,
                  force: forced,
                },
                { signal },
              );
              if (!lifetime.active || signal.aborted) return;
              const { updates, warnings, durationMs } = worktreeEnrichment;
              const latestSaved =
                snapshot === lifetime.snapshot
                  ? undefined
                  : indexed(lifetime.snapshot);
              setOverview((current) =>
                lifetime.active && current
                  ? mergeWorktreeEnrichment(
                      current,
                      updates,
                      kind,
                      requested,
                      warnings,
                      latestSaved,
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
              // Try again with the next saved read rather than waiting it out.
              lifetime.owners.get(kind)!.subject = null;
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
      entry.subject = enrichmentSubject(lifetime.snapshot, kind);
      entry.startedAt = Date.now();
      lifetime.skipped.delete(kind);
      void entry.owner.refresh();
    },
    [mark, setOverview],
  );

  /** Decide, for the latest saved read, which optional metadata is worth reading. */
  const enrich = useCallback(() => {
    const lifetime = scope.current;
    if (!lifetime?.active || !lifetime.snapshot) return;
    const connected = availability.current;
    if (connected === "pending") return;
    const force = lifetime.force;
    lifetime.force = false;
    for (const kind of ENRICHMENT_KINDS) {
      if (connected && !connected[INTEGRATION_FOR[kind]]) {
        if (!lifetime.skipped.has(kind)) {
          lifetime.skipped.add(kind);
          mark(kind, { ...initialTiming(), status: "skipped" });
        }
        continue;
      }
      const entry = lifetime.owners.get(kind);
      if (
        force ||
        !entry ||
        lifetime.skipped.has(kind) ||
        entry.subject !== enrichmentSubject(lifetime.snapshot, kind) ||
        Date.now() - entry.startedAt >= ENRICHMENT_MAX_AGE_MS
      )
        refreshKind(kind, force);
    }
  }, [mark, refreshKind]);

  useEffect(() => {
    availability.current = integrations;
    // A saved read that arrived first has been waiting for this answer.
    enrich();
  }, [enrich, integrations]);

  const saved = useCallback(
    (snapshot: WorktreeOverview) => {
      const lifetime = scope.current;
      if (!lifetime?.active) return;
      const previous = lifetime.snapshot;
      lifetime.snapshot = snapshot;
      setOverview((current) =>
        lifetime.active
          ? preserveWorktreeMetadata(current, snapshot, previous)
          : current,
      );
      mark("SAVED", {
        status: "complete",
        finishedAt: Date.now(),
        durationMs: snapshot.durationMs ?? null,
      });
      if (lifetime.timer !== null) clearTimeout(lifetime.timer);
      lifetime.timer = setTimeout(() => {
        lifetime.timer = null;
        enrich();
      }, 0);
    },
    [enrich, mark, setOverview],
  );

  return {
    timings: state.scope === scopeKey ? state.timings : initialTimings(),
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
