"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";

import type { Worktree, WorktreeOverview, WorktreeSyncBatch } from "./types";
import { WORKTREE_SYNC_BATCH_FIELDS } from "./worktree-graphql";
import { worktreeDetailHref } from "./worktree-navigation";

type BlockReason =
  | "unavailable"
  | "offline"
  | "unsupported"
  | "activeSync"
  | "busy"
  | "conflicts"
  | "dirty"
  | "missingBranch"
  | "missingUpstream"
  | "missingBase";

export type WorktreeSyncCandidate = {
  worktree: Worktree;
  repositoryName: string;
  agentName: string;
  blockedReason: BlockReason | null;
};

function pending(status: string) {
  return status === "PENDING" || status === "RUNNING";
}

/** Bulk selection uses the page's scope, independent of its local filters. */
export function worktreeSyncCandidates(
  overview: WorktreeOverview | null,
  agentId: string | null,
  batches: WorktreeSyncBatch[] = overview?.activeSyncBatches ?? [],
): WorktreeSyncCandidate[] {
  const syncing = new Set(
    batches.flatMap((batch) =>
      batch.items
        .filter((item) => pending(item.status))
        .map((item) => item.worktreeId),
    ),
  );
  return (overview?.agents ?? [])
    .filter(({ agent }) => !agentId || agent.id === agentId)
    .flatMap(({ agent, codebases }) =>
      codebases.flatMap((group) =>
        group.worktrees
          .filter(
            (worktree) =>
              !worktree.isDefaultBranch && (worktree.baseBehind ?? 0) > 0,
          )
          .map((worktree): WorktreeSyncCandidate => ({
            worktree,
            repositoryName: group.repository.name,
            agentName: agent.name,
            blockedReason:
              worktree.availability !== "AVAILABLE" ||
              worktree.missingAt ||
              group.codebase.availability !== "AVAILABLE"
                ? "unavailable"
                : agent.connectionStatus !== "ONLINE"
                  ? "offline"
                  : !agent.capabilities.includes("worktree.auto-sync")
                    ? "unsupported"
                    : syncing.has(worktree.id)
                      ? "activeSync"
                      : group.blockingJob ||
                          worktree.blockingJob ||
                          worktree.activeJob
                        ? "busy"
                        : worktree.rebaseInProgress || worktree.hasConflicts
                          ? "conflicts"
                          : worktree.hasStagedChanges ||
                              worktree.hasUnstagedChanges
                            ? "dirty"
                            : !worktree.branch
                              ? "missingBranch"
                              : !worktree.upstream
                                ? "missingUpstream"
                                : !worktree.baseBranch
                                  ? "missingBase"
                                  : null,
          })),
      ),
    )
    .sort((left, right) =>
      `${left.repositoryName}\0${left.agentName}\0${left.worktree.branch}`.localeCompare(
        `${right.repositoryName}\0${right.agentName}\0${right.worktree.branch}`,
      ),
    );
}

function mergeBatches(
  overviewBatches: WorktreeSyncBatch[],
  tracked: Record<string, WorktreeSyncBatch>,
) {
  const byId = new Map(
    Object.values(tracked).map((batch) => [batch.id, batch]),
  );
  for (const batch of overviewBatches) {
    const previous = byId.get(batch.id);
    if (!previous || batch.updatedAt > previous.updatedAt)
      byId.set(batch.id, batch);
  }
  return [...byId.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export function WorktreeBulkSync({
  overview,
  appId,
  agentId,
  disabled,
  onReload,
  scopeRepositoryIds,
}: {
  overview: WorktreeOverview | null;
  appId?: string;
  agentId: string | null;
  disabled: boolean;
  onReload: () => Promise<void>;
  scopeRepositoryIds?: string[];
}) {
  const t = useTranslations("worktrees.bulkSync");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tracked, setTracked] = useState<Record<string, WorktreeSyncBatch>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [monitoringError, setMonitoringError] = useState<string | null>(null);
  const submission = useRef<{ fingerprint: string; requestId: string } | null>(
    null,
  );
  const batches = useMemo(
    () => mergeBatches(overview?.activeSyncBatches ?? [], tracked),
    [overview?.activeSyncBatches, tracked],
  );
  const repositoryIds = new Set(
    scopeRepositoryIds ??
      overview?.agents.flatMap(({ codebases }) =>
        codebases.map(({ repository }) => repository.id),
      ) ??
      [],
  );
  const visibleBatches = batches
    .map((batch) => ({
      ...batch,
      items: batch.items.filter(
        (item) =>
          (!appId || repositoryIds.has(item.repositoryId)) &&
          (!agentId || item.agentId === agentId),
      ),
    }))
    .filter((batch) => batch.items.length > 0);
  const activeIds = JSON.stringify(
    visibleBatches
      .filter((batch) => batch.status === "ACTIVE")
      .map((batch) => batch.id)
      .sort(),
  );
  const candidates = worktreeSyncCandidates(overview, agentId, batches);
  const selectedIds = candidates
    .filter(
      (candidate) =>
        !candidate.blockedReason && selected.has(candidate.worktree.id),
    )
    .map((candidate) => candidate.worktree.id);
  const eligible = candidates.filter((candidate) => !candidate.blockedReason);
  const activeCount = visibleBatches.filter(
    (batch) => batch.status === "ACTIVE",
  ).length;
  const missingBatchMessage = t("missingBatch");

  useEffect(() => {
    const ids = JSON.parse(activeIds) as string[];
    if (!ids.length) return;
    const controller = new AbortController();
    let reading = false;
    const read = async () => {
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        const results = await Promise.allSettled(
          ids.map((id) =>
            controlPlaneRequest<{
              worktreeSyncBatch: WorktreeSyncBatch | null;
            }>(
              `query WorktreeSyncBatch($id: ID!) {
                worktreeSyncBatch(id: $id) { ${WORKTREE_SYNC_BATCH_FIELDS} }
              }`,
              { id },
              { signal: controller.signal },
            ),
          ),
        );
        if (controller.signal.aborted) return;
        const received: WorktreeSyncBatch[] = [];
        const failures: string[] = [];
        for (const result of results) {
          if (result.status === "fulfilled" && result.value.worktreeSyncBatch) {
            received.push(result.value.worktreeSyncBatch);
          } else {
            failures.push(
              result.status === "rejected"
                ? String(
                    result.reason instanceof Error
                      ? result.reason.message
                      : result.reason,
                  )
                : missingBatchMessage,
            );
          }
        }
        setMonitoringError(failures.length ? failures.join("; ") : null);
        setTracked((current) => ({
          ...current,
          ...Object.fromEntries(received.map((batch) => [batch.id, batch])),
        }));
        if (received.some((batch) => batch.status === "COMPLETED")) {
          void onReload().catch(() => undefined);
        }
      } finally {
        reading = false;
      }
    };
    const initial = window.setTimeout(() => void read(), 0);
    const timer = window.setInterval(() => void read(), 3_000);
    const recovery = onControlPlaneRecovery(() => void read());
    return () => {
      controller.abort();
      window.clearTimeout(initial);
      window.clearInterval(timer);
      recovery();
    };
  }, [activeIds, missingBatchMessage, onReload]);

  const changeOpen = (next: boolean) => {
    if (next) {
      setSelected(new Set(eligible.map(({ worktree }) => worktree.id)));
      setError(null);
    }
    setOpen(next);
  };

  const start = async () => {
    if (!selectedIds.length || submitting) return;
    const fingerprint = JSON.stringify([
      appId,
      agentId,
      [...selectedIds].sort(),
    ]);
    if (submission.current?.fingerprint !== fingerprint) {
      submission.current = { fingerprint, requestId: createClientId() };
    }
    setSubmitting(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<{
        startWorktreeSyncBatch: WorktreeSyncBatch;
      }>(
        `mutation StartWorktreeSyncBatch($input: StartWorktreeSyncBatchInput!) {
          startWorktreeSyncBatch(input: $input) { ${WORKTREE_SYNC_BATCH_FIELDS} }
        }`,
        {
          input: {
            worktreeIds: selectedIds,
            requestId: submission.current.requestId,
            appId: appId ?? null,
            agentId,
          },
        },
      );
      setTracked((current) => ({
        ...current,
        [data.startWorktreeSyncBatch.id]: data.startWorktreeSyncBatch,
      }));
      setSelected(new Set());
      submission.current = null;
      void onReload().catch(() => undefined);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      // The server may have accepted the batch before the connection failed.
      void onReload().catch(() => undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        aria-label={t("button")}
        disabled={disabled && activeCount === 0}
        onClick={() => changeOpen(true)}
        variant="outline"
      >
        {activeCount ? <Spinner aria-hidden="true" /> : <RefreshCw />}
        {t("button")}
        {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
      </Button>
      <Dialog onOpenChange={changeOpen} open={open}>
        <DialogContent className="flex max-h-[85dvh] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="shrink-0 border-b p-4 pr-12">
            <DialogTitle>{t("button")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {monitoringError && (
              <Alert>
                <AlertDescription>
                  {t("monitoring")} {monitoringError}
                </AlertDescription>
              </Alert>
            )}
            {visibleBatches.map((batch) => (
              <SyncBatchProgress key={batch.id} batch={batch} />
            ))}
            <section className="space-y-3" aria-label={t("selection")}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">{t("selection")}</h3>
                {eligible.length > 0 && (
                  <Button
                    disabled={submitting}
                    onClick={() =>
                      setSelected(
                        new Set(
                          selectedIds.length === eligible.length
                            ? []
                            : eligible.map(({ worktree }) => worktree.id),
                        ),
                      )
                    }
                    size="sm"
                    variant="ghost"
                  >
                    {t(
                      selectedIds.length === eligible.length
                        ? "deselectAll"
                        : "selectAll",
                    )}
                  </Button>
                )}
              </div>
              {candidates.length === 0 ? (
                <p className="text-muted-foreground">{t("empty")}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {candidates.map(
                    ({
                      worktree,
                      agentName,
                      repositoryName,
                      blockedReason,
                    }) => (
                      <li className="flex gap-3 p-3" key={worktree.id}>
                        <Checkbox
                          aria-label={t("selectWorktree", {
                            branch: worktree.branch ?? worktree.relativePath,
                          })}
                          checked={!blockedReason && selected.has(worktree.id)}
                          disabled={submitting || Boolean(blockedReason)}
                          id={`bulk-sync-${worktree.id}`}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked) next.add(worktree.id);
                              else next.delete(worktree.id);
                              return next;
                            })
                          }
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <Label
                            className="break-all leading-snug"
                            htmlFor={`bulk-sync-${worktree.id}`}
                          >
                            {worktree.branch ?? worktree.relativePath}
                          </Label>
                          <p className="break-words text-sm text-muted-foreground">
                            {repositoryName} · {agentName}
                          </p>
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {worktree.folder}
                          </p>
                          {worktree.ticketKey && (
                            <p className="break-words text-xs">
                              {worktree.ticketKey}
                              {worktree.ticketTitle
                                ? ` · ${worktree.ticketTitle}`
                                : ""}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {t("behindBase", {
                              count: worktree.baseBehind ?? 0,
                              branch: worktree.baseBranch ?? "—",
                            })}
                          </p>
                          {blockedReason && (
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                              {t(`blocked.${blockedReason}`)}
                            </p>
                          )}
                        </div>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </section>
          </div>
          <DialogFooter className="m-0 shrink-0 flex-col sm:flex-col">
            <p className="text-xs text-muted-foreground">{t("background")}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => changeOpen(false)} variant="outline">
                {t("close")}
              </Button>
              <Button
                disabled={disabled || submitting || selectedIds.length === 0}
                onClick={() => void start()}
              >
                {submitting && <Spinner />}
                {t("start", { count: selectedIds.length })}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SyncBatchProgress({ batch }: { batch: WorktreeSyncBatch }) {
  const t = useTranslations("worktrees.bulkSync");
  const completed = batch.items.filter((item) => !pending(item.status)).length;
  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div
        className="space-y-1"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <h3 className="flex items-center gap-2 font-medium">
          {batch.status === "ACTIVE" && <Spinner aria-hidden="true" />}
          {t(batch.status === "ACTIVE" ? "running" : "completed")}
        </h3>
        <p className="text-sm">
          {t("progress", { completed, total: batch.items.length })}
        </p>
        <p className="text-xs text-muted-foreground">
          <DateTime value={batch.createdAt} />
        </p>
      </div>
      <progress
        aria-label={t("progress", { completed, total: batch.items.length })}
        className="h-1.5 w-full accent-primary"
        max={Math.max(1, batch.items.length)}
        value={completed}
      />
      <ul className="divide-y">
        {batch.items.map((item) => (
          <li className="space-y-1 py-3 first:pt-0 last:pb-0" key={item.id}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <Link
                className="min-w-0 break-all font-medium hover:underline"
                href={worktreeDetailHref(item.worktreeId)}
              >
                {item.branch}
              </Link>
              <Badge
                variant={item.status === "FAILED" ? "destructive" : "outline"}
                className={
                  item.status === "SUCCEEDED"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : item.status === "ATTENTION_REQUIRED"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      : undefined
                }
              >
                {t(`status.${item.status}`)}
              </Badge>
            </div>
            <p className="break-words text-xs text-muted-foreground">
              {item.repositoryName} · {item.agentName}
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">
              {item.folder}
            </p>
            {item.error && (
              <p className="break-words text-sm text-amber-700 dark:text-amber-300">
                {item.error}
              </p>
            )}
            {item.jobId && (
              <Link
                className="inline-flex items-center gap-1 text-xs underline underline-offset-4"
                href={`/dashboard/jobs/${encodeURIComponent(item.jobId)}`}
              >
                {t("job")}
                <ExternalLink className="size-3" />
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
