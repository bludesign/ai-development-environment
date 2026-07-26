"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import type {
  GitHubWebhookDeliveryPage,
  GitHubWebhookDeliveryView,
} from "@/services/github/types";

const PAGE_SIZE = 50;
const firstColumn = "pl-4";
const lastColumn = "pr-4";

function humanize(value: string): string {
  return value.replaceAll("_", " ").toLowerCase();
}

function outcomeClass(outcome: string): string {
  if (outcome === "PROCESSED") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (outcome === "ERROR") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (outcome === "RECEIVED") {
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const t = useTranslations("githubWebhooks");
  const label =
    outcome === "PROCESSED"
      ? t("outcomes.processed")
      : outcome === "IGNORED"
        ? t("outcomes.ignored")
        : outcome === "ERROR"
          ? t("outcomes.error")
          : outcome === "RECEIVED"
            ? t("outcomes.received")
            : humanize(outcome);
  return <Badge className={outcomeClass(outcome)}>{label}</Badge>;
}

export function GitHubWebhooksPage() {
  const t = useTranslations("githubWebhooks");
  const locale = useLocale();
  const router = useRouter();
  const [page, setPage] = useState<GitHubWebhookDeliveryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        githubWebhookDeliveries: GitHubWebhookDeliveryPage;
      }>(
        `query GitHubWebhooksPage($limit: Int!, $offset: Int!) {
          githubWebhookDeliveries(limit: $limit, offset: $offset) {
            enabled total limit offset
            items {
              deliveryId event action repositoryName workflowRunId outcome error
              receivedAt processedAt
            }
          }
        }`,
        { limit: PAGE_SIZE, offset },
      );
      setPage(data.githubWebhookDeliveries);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  useEffect(() => {
    if (page?.enabled === false) router.replace("/");
  }, [page?.enabled, router]);

  const groups = useMemo(() => {
    const grouped: Array<{
      key: string;
      dateKey: string;
      label: string;
      items: GitHubWebhookDeliveryView[];
    }> = [];
    for (const delivery of page?.items ?? []) {
      const date = new Date(delivery.receivedAt);
      const dateKey = dayKey(date) ?? delivery.receivedAt;
      const group = grouped.at(-1);
      if (group?.dateKey === dateKey) {
        group.items.push(delivery);
      } else {
        grouped.push({
          key: `${dateKey}-${delivery.deliveryId}`,
          dateKey,
          label: formatDateValue(date, "long", {
            locale,
            showTime: false,
          }),
          items: [delivery],
        });
      }
    }
    return grouped;
  }, [locale, page?.items]);

  if (!page && loading) {
    return (
      <Card className="gap-0 overflow-hidden p-4">
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((item) => (
            <Skeleton className="h-8 w-full" key={item} />
          ))}
        </div>
      </Card>
    );
  }
  if (page?.enabled === false) return null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge variant="outline">
          {t("deliveryCount", { count: page?.total ?? 0 })}
        </Badge>
        <Button
          aria-label={t("refresh")}
          onClick={() => void load()}
          size="icon"
          type="button"
          variant="outline"
        >
          <RefreshCw />
        </Button>
      </div>

      {loading ? (
        <Card className="gap-0 overflow-hidden p-4">
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((item) => (
              <Skeleton className="h-8 w-full" key={item} />
            ))}
          </div>
        </Card>
      ) : page?.items.length ? (
        <Card className="gap-0 overflow-hidden py-0">
          <Table className="min-w-[52rem] table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className={`w-[12%] ${firstColumn}`}>
                  {t("received")}
                </TableHead>
                <TableHead className="w-[18%]">{t("event")}</TableHead>
                <TableHead className="w-[22%]">{t("repository")}</TableHead>
                <TableHead className="w-[14%]">{t("outcome")}</TableHead>
                <TableHead className={`w-[34%] ${lastColumn}`}>
                  {t("details")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell
                      className={`${firstColumn} py-1.5 text-xs font-normal text-muted-foreground`}
                      colSpan={5}
                    >
                      {group.label}
                    </TableCell>
                  </TableRow>
                  {group.items.map((delivery) => (
                    <TableRow key={delivery.deliveryId}>
                      <TableCell
                        className={`${firstColumn} align-top text-xs text-muted-foreground`}
                      >
                        <DateTime kind="time" value={delivery.receivedAt} />
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <p className="font-medium capitalize">
                          {humanize(delivery.event)}
                        </p>
                        {delivery.action && (
                          <Badge className="mt-1 capitalize" variant="outline">
                            {humanize(delivery.action)}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <p>{delivery.repositoryName ?? "—"}</p>
                        {delivery.workflowRunId && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("workflowRun", {
                              id: delivery.workflowRunId,
                            })}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <OutcomeBadge outcome={delivery.outcome} />
                      </TableCell>
                      <TableCell
                        className={`${lastColumn} align-top whitespace-normal`}
                      >
                        {delivery.error && (
                          <p className="mb-1 text-destructive">
                            {delivery.error}
                          </p>
                        )}
                        <p className="font-mono text-xs break-all text-muted-foreground">
                          {delivery.deliveryId}
                        </p>
                        {delivery.processedAt && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("processed")}{" "}
                            <DateTime
                              kind="time"
                              value={delivery.processedAt}
                            />
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t p-3 text-sm">
            <span className="text-muted-foreground">
              {t("showing", {
                start: page.total === 0 ? 0 : offset + 1,
                end: Math.min(offset + PAGE_SIZE, page.total),
                total: page.total,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("previous")}
              </Button>
              <Button
                disabled={offset + PAGE_SIZE >= page.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("next")}
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyTitle>{t("empty")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
