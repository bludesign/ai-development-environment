"use client";

import { ExternalLink, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { ReviewerPerson } from "./reviewer-person";
import {
  WORKTREE_REVIEW_STATUS_FIELDS,
  type CodeReviewerPerson,
  type WorktreeReviewStatus,
} from "./types";

function ReviewPeople({
  ids,
  people,
  approvedIds = [],
  requestedIds = [],
}: {
  ids: string[];
  people: Map<string, CodeReviewerPerson>;
  approvedIds?: string[];
  requestedIds?: string[];
}) {
  const t = useTranslations("reviewers");
  return (
    <ul className="space-y-2">
      {[...new Set(ids)].map((id) => {
        const person = people.get(id);
        return (
          <li className="flex items-center gap-2" key={id}>
            {person ? (
              <ReviewerPerson person={person} />
            ) : (
              <span className="min-w-0 flex-1 break-words text-xs text-muted-foreground">
                {t("unavailablePerson", { id })}
              </span>
            )}
            <span className="flex shrink-0 flex-col items-end gap-1">
              {approvedIds.includes(id) && (
                <Badge variant="success">{t("approved")}</Badge>
              )}
              {requestedIds.includes(id) && (
                <Badge variant="secondary">{t("requested")}</Badge>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function WorktreeReviewStatusPopover({
  worktreeId,
  requestId,
  requestUrl,
  requestLabel,
  children,
}: {
  worktreeId: string;
  requestId: string;
  requestUrl: string;
  requestLabel: string;
  children: ReactNode;
}) {
  const t = useTranslations("reviewers");
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<WorktreeReviewStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadAll, setLoadAll] = useState(false);
  const requestChangedMessage = t("status.requestChanged");

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void controlPlaneRequest<{ worktreeReviewStatus: WorktreeReviewStatus }>(
        `query WorktreeReviewStatus($worktreeId: ID!, $all: Boolean!, $refresh: Boolean!) {
          worktreeReviewStatus(worktreeId: $worktreeId, includeEligibleReviewers: $all, refresh: $refresh) { ${WORKTREE_REVIEW_STATUS_FIELDS} }
        }`,
        { worktreeId, all: loadAll, refresh: revision > 0 },
        { signal: controller.signal },
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          if (
            result.worktreeReviewStatus.requestId !== requestId ||
            result.worktreeReviewStatus.worktreeId !== worktreeId
          ) {
            setData(null);
            throw new Error(requestChangedMessage);
          }
          setData(result.worktreeReviewStatus);
        })
        .catch((value: unknown) => {
          if (!controller.signal.aborted)
            setError(value instanceof Error ? value.message : String(value));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, worktreeId, requestId, revision, loadAll, requestChangedMessage]);

  // Also hide a previous snapshot synchronously when the linked request changes.
  const details =
    data?.requestId === requestId && data.worktreeId === worktreeId
      ? data
      : null;
  const people = new Map(
    details?.reviewers.map((person) => [person.id, person]),
  );
  const title = t("status.open", { request: requestLabel });

  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (value) {
          setLoadAll(false);
          setRevision(0);
          setData(null);
          setError(null);
          setLoading(true);
        }
        setOpen(value);
      }}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={title}
          className="inline-flex cursor-pointer rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          onClick={(event) => event.stopPropagation()}
          type="button"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={title}
        className="max-h-[min(70dvh,42rem,var(--radix-popover-content-available-height))] w-[min(26rem,calc(100vw-1rem))] gap-3 overflow-y-auto"
        collisionPadding={8}
        onClick={(event) => event.stopPropagation()}
      >
        <PopoverHeader>
          <div className="flex items-center justify-between gap-2">
            <PopoverTitle>{t("status.title")}</PopoverTitle>
            <Button
              aria-label={t("status.refresh")}
              disabled={loading}
              onClick={() => setRevision((value) => value + 1)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <RefreshCw />
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a
              className="inline-flex items-center gap-1 text-xs hover:underline"
              href={details?.requestUrl ?? requestUrl}
              rel="noreferrer"
              target="_blank"
            >
              {t("status.openProvider", { request: requestLabel })}{" "}
              <ExternalLink className="size-3" />
            </a>
            {children}
          </div>
        </PopoverHeader>
        {loading && (
          <p className="flex items-center gap-2 text-sm" role="status">
            <Spinner aria-hidden="true" />
            {t("loading")}
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!loadAll && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => setLoadAll(true)}
          >
            {t("loadAllReviewers")}
          </Button>
        )}
        {details?.directoryStale && (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {t("staleDirectory")}
          </p>
        )}
        {details && (
          <>
            {!details.requestOpen && (
              <p className="text-xs text-muted-foreground">
                {t("status.closed")}
              </p>
            )}
            {(!details.discoveryComplete || details.issues.length > 0) && (
              <Alert>
                <AlertDescription className="space-y-1">
                  {!details.discoveryComplete && (
                    <p>{t("incompleteDiscovery")}</p>
                  )}
                  {details.issues.map((issue) => (
                    <p className="break-words" key={issue}>
                      {issue}
                    </p>
                  ))}
                </AlertDescription>
              </Alert>
            )}
            <section
              aria-label={t("status.approvers")}
              className="space-y-2 border-t pt-3"
            >
              <h3 className="text-sm font-medium">{t("status.approvers")}</h3>
              {details.approvedReviewerIds.length ? (
                <ReviewPeople
                  ids={details.approvedReviewerIds}
                  people={people}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("status.noApprovers")}
                </p>
              )}
            </section>
            <section
              aria-label={t("status.requested")}
              className="space-y-2 border-t pt-3"
            >
              <h3 className="text-sm font-medium">{t("status.requested")}</h3>
              {details.currentReviewerIds.length ? (
                <ReviewPeople
                  ids={details.currentReviewerIds}
                  people={people}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("status.noRequested")}
                </p>
              )}
            </section>
            <section
              aria-label={t("status.rules")}
              className="space-y-2 border-t pt-3"
            >
              <h3 className="text-sm font-medium">{t("status.rules")}</h3>
              {!details.requirements.length && (
                <p className="text-xs text-muted-foreground">
                  {t(
                    details.discoveryComplete
                      ? "status.noRules"
                      : "status.rulesUnavailable",
                  )}
                </p>
              )}
              {details.requirements.map((rule) => (
                <section
                  aria-label={rule.name}
                  className="space-y-2 rounded-md border p-2.5"
                  key={rule.id}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="min-w-0 break-words text-sm font-medium">
                      {rule.name}
                    </h4>
                    {!rule.isRequired && (
                      <Badge variant="secondary">{t("status.suggested")}</Badge>
                    )}
                  </div>
                  {rule.groups
                    .filter((group) => group.kind !== "GENERAL")
                    .map((group) => (
                      <p
                        className="break-words text-xs text-muted-foreground"
                        key={group.key}
                      >
                        {group.name}
                      </p>
                    ))}
                  {rule.patterns.length > 0 && (
                    <p className="break-words font-mono text-xs text-muted-foreground">
                      {rule.patterns.join(", ")}
                    </p>
                  )}
                  {rule.isRequired && (
                    <p className="text-xs font-medium">
                      {t("status.progress", {
                        approved: new Set(rule.approvedReviewerIds).size,
                        required: rule.requiredApprovals,
                      })}
                    </p>
                  )}
                  {details.membersLoaded !== false && (
                    <p className="text-xs text-muted-foreground">
                      {t("status.requestedCount", {
                        count: new Set(rule.requestedReviewerIds).size,
                      })}
                    </p>
                  )}
                  {details.membersLoaded !== false && (
                    <details className="text-xs">
                      <summary className="cursor-pointer rounded-sm focus-visible:outline-ring">
                        {t("status.members", {
                          count: rule.eligibleReviewerIds.length,
                        })}
                      </summary>
                      <div className="pt-3">
                        {rule.eligibleReviewerIds.length ? (
                          <ReviewPeople
                            ids={rule.eligibleReviewerIds}
                            people={people}
                            approvedIds={rule.approvedReviewerIds}
                            requestedIds={rule.requestedReviewerIds}
                          />
                        ) : (
                          <p className="text-muted-foreground">
                            {t("status.noMembers")}
                          </p>
                        )}
                      </div>
                    </details>
                  )}
                </section>
              ))}
            </section>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
