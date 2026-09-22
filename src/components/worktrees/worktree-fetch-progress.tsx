"use client";

import { Check, ChevronRight, ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";

import type {
  WorktreeFetchBatch,
  WorktreeFetchRow,
} from "./use-worktree-fetch";

const STATUS_KEYS = {
  STARTING: "submitting",
  QUEUED: "queued",
  RUNNING: "running",
  CANCELLING: "cancelling",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timedOut",
  SKIPPED: "skipped",
  UNREPORTED: "failed",
  SUBMISSION_FAILED: "failed",
} as const;

const SKIP_KEYS: Record<string, string> = {
  ACTIVE_OPERATION: "skipActive",
  OFFLINE: "skipOffline",
  UNSUPPORTED: "skipUnsupported",
  MISSING: "skipMissing",
  NOT_REPOSITORY: "skipNotRepository",
  ORIGIN_MISMATCH: "skipOriginMismatch",
  ERROR: "skipError",
};

function pending(row: WorktreeFetchRow) {
  return ["STARTING", "QUEUED", "RUNNING", "CANCELLING"].includes(row.status);
}

function failed(row: WorktreeFetchRow) {
  return [
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
    "UNREPORTED",
    "SUBMISSION_FAILED",
  ].includes(row.status);
}

export function WorktreeFetchProgress({
  batch,
  onDismiss,
  onRetry,
}: {
  batch: WorktreeFetchBatch;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations("worktrees.fetchProgress");
  const titleId = useId();
  const active = ["starting", "fetching", "refreshing"].includes(batch.phase);
  const completed = batch.rows.filter((row) => !pending(row)).length;
  const succeeded = batch.rows.filter(
    (row) => row.status === "SUCCEEDED",
  ).length;
  const failures = batch.rows.filter(failed).length;
  const skipped = batch.rows.filter((row) => row.status === "SKIPPED").length;
  const hasRefreshWarning = batch.rows.some((row) => row.worktreeRefreshError);
  const hasLegacyResults = batch.rows.some(
    (row) =>
      row.status === "SUCCEEDED" &&
      !row.worktreesRefreshedAt &&
      !row.worktreeRefreshError,
  );
  const progressLabel = t("progress", { completed, total: batch.rows.length });

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border bg-card p-4 text-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div
          className="min-w-0 space-y-1"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <h2 id={titleId} className="flex items-center gap-2 font-medium">
            {active ? (
              <Spinner aria-hidden="true" />
            ) : batch.phase === "finished" &&
              !failures &&
              !hasRefreshWarning &&
              !hasLegacyResults ? (
              <Check className="size-4 text-emerald-600" />
            ) : null}
            {t(batch.phase)}
          </h2>
          <p>{progressLabel}</p>
          <p className="text-muted-foreground">
            {t("summary", { succeeded, failed: failures, skipped })}
          </p>
        </div>
        {!active && (
          <Button
            aria-label={t("dismiss")}
            onClick={onDismiss}
            size="icon-sm"
            variant="ghost"
          >
            <X />
          </Button>
        )}
      </div>

      <progress
        aria-label={progressLabel}
        className="mt-3 h-1.5 w-full accent-primary"
        max={Math.max(1, batch.rows.length)}
        value={completed}
      />

      {batch.monitoringError && (
        <p className="mt-3 text-amber-700 dark:text-amber-300">
          {t("monitoring")}{" "}
          <span className="break-words">{batch.monitoringError}</span>
        </p>
      )}
      {batch.monitoringMissingJobs > 0 && (
        <p className="mt-3 text-amber-700 dark:text-amber-300">
          {t("statusUnavailable")}
        </p>
      )}
      {hasRefreshWarning && (
        <p className="mt-3 text-amber-700 dark:text-amber-300">
          {t("refreshWarning")}
        </p>
      )}
      {batch.legacyRefreshRequested && hasLegacyResults && (
        <p className="mt-3 text-amber-700 dark:text-amber-300">
          {t("legacyWarning")}
        </p>
      )}
      {batch.legacyRefreshError && (
        <p className="mt-3 break-words text-amber-700 dark:text-amber-300">
          {t("reconciledError")} {batch.legacyRefreshError}
        </p>
      )}
      {batch.phase === "refreshFailed" && (
        <div className="mt-3 space-y-2" role="alert">
          <p className="break-words text-destructive">
            {t("pageUpdateError")} {batch.pageUpdateError}
          </p>
          <Button onClick={onRetry} size="sm" variant="outline">
            {t("retry")}
          </Button>
        </div>
      )}
      {batch.phase === "finished" &&
        !hasRefreshWarning &&
        !hasLegacyResults && (
          <p className="mt-2 text-muted-foreground">{t("pageUpdated")}</p>
        )}

      <details className="group mt-3">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
          {t("details")}
        </summary>
        <ul className="mt-3 max-h-80 divide-y overflow-y-auto">
          {batch.rows.map((row) => (
            <li
              className="space-y-2 py-3 first:pt-0 last:pb-0"
              key={row.codebaseId}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {row.repositoryName}{" "}
                    <span className="font-normal text-muted-foreground">
                      · {row.agentName}
                    </span>
                  </p>
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {row.folder}
                  </p>
                </div>
                <Badge
                  variant={
                    failed(row)
                      ? "destructive"
                      : row.status === "SUCCEEDED" &&
                          !row.worktreeRefreshError &&
                          row.worktreesRefreshedAt
                        ? "success"
                        : "secondary"
                  }
                >
                  {pending(row) && <Spinner aria-hidden="true" />}
                  {t(STATUS_KEYS[row.status])}
                </Badge>
              </div>
              {row.skipReason && (
                <p className="text-muted-foreground">
                  {SKIP_KEYS[row.skipReason]
                    ? t(SKIP_KEYS[row.skipReason]!)
                    : t("skipUnknown", { reason: row.skipReason })}
                </p>
              )}
              {row.error && (
                <p className="break-words text-destructive">{row.error}</p>
              )}
              {row.status === "UNREPORTED" && (
                <p className="text-destructive">{t("notScheduled")}</p>
              )}
              {row.status === "SUBMISSION_FAILED" && (
                <p className="text-destructive">{t("submissionFailed")}</p>
              )}
              {row.worktreeRefreshError && (
                <p className="break-words text-amber-700 dark:text-amber-300">
                  {t("refreshWarning")} {row.worktreeRefreshError}
                </p>
              )}
              {row.jobId && (
                <Button
                  asChild
                  size="sm"
                  variant="link"
                  className="h-auto px-0"
                >
                  <Link
                    href={`/jobs/${row.jobId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("logs")} <ExternalLink />
                  </Link>
                </Button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
