"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { DateTime } from "@/components/common/date-time";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
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
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
  onControlPlaneConnected,
} from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import type {
  JiraWebhookDeliveryPage,
  JiraWebhookDeliveryView,
} from "@/services/jira/types";

const PAGE_SIZE = 50;
const firstColumn = "pl-4";
const lastColumn = "pr-4";

const DELIVERY_FIELDS =
  "deliveryId event issueKey projectKey retryCount outcome error receivedAt processedAt";

function humanize(value: string): string {
  return value
    .replace(/^jira:/, "")
    .replaceAll("_", " ")
    .toLowerCase();
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
  const t = useTranslations("jiraWebhooks");
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

export function JiraWebhooksPage() {
  const t = useTranslations("jiraWebhooks");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [page, setPage] = useState<JiraWebhookDeliveryPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (requestOffset: number) => {
    setLoading(true);
    try {
      const data = await controlPlaneRequest<{
        jiraWebhookDeliveries: JiraWebhookDeliveryPage;
      }>(
        `query JiraWebhooksPage($limit: Int!, $offset: Int!) {
          jiraWebhookDeliveries(limit: $limit, offset: $offset) {
            enabled total limit offset
            items { ${DELIVERY_FIELDS} }
          }
        }`,
        { limit: PAGE_SIZE, offset: requestOffset },
      );
      setPage(data.jiraWebhookDeliveries);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  const clearHistory = async () => {
    setClearing(true);
    try {
      await controlPlaneRequest("mutation { clearJiraWebhookDeliveries }");
      setOffset(0);
      setPage((current) =>
        current
          ? { ...current, items: [], total: 0, limit: PAGE_SIZE, offset: 0 }
          : current,
      );
      await load(0);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setClearing(false);
    }
  };

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(offset), 0);
    return () => window.clearTimeout(timeout);
  }, [load, offset]);

  // Live deliveries only make sense on the first page — anywhere else, a new
  // arrival would shift rows out from under whoever is paging through history.
  useEffect(() => {
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      jiraWebhookDeliveryChanged: JiraWebhookDeliveryView;
    }>(
      {
        query: `subscription JiraWebhookDeliveryChanged {
          jiraWebhookDeliveryChanged { ${DELIVERY_FIELDS} }
        }`,
      },
      {
        next: (result) => {
          const delivery = result.data?.jiraWebhookDeliveryChanged;
          if (!delivery) return;
          if (offset !== 0) return;
          setPage((current) => {
            if (!current) return current;
            const existing = current.items.some(
              (item) => item.deliveryId === delivery.deliveryId,
            );
            const items = existing
              ? current.items.map((item) =>
                  item.deliveryId === delivery.deliveryId ? delivery : item,
                )
              : [delivery, ...current.items].slice(0, PAGE_SIZE);
            return {
              ...current,
              items,
              total: existing ? current.total : current.total + 1,
            };
          });
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const reconnect = onControlPlaneConnected(() => void load(offset));
    return () => {
      unsubscribe();
      reconnect();
    };
  }, [load, offset]);

  useEffect(() => {
    if (page?.enabled === false) router.replace("/");
  }, [page?.enabled, router]);

  const groups = useMemo(() => {
    const grouped: Array<{
      key: string;
      dateKey: string;
      label: string;
      items: JiraWebhookDeliveryView[];
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
          label: formatDateValue(date, "long", { locale, showTime: false }),
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
        <div className="flex items-center gap-2">
          <ConfirmationDialog
            actionLabel={t("clearHistory")}
            cancelLabel={tc("cancel")}
            description={tc("cannotBeUndone")}
            onConfirm={clearHistory}
            title={t("confirmClearHistory")}
            trigger={
              <Button
                disabled={clearing || loading || (page?.total ?? 0) === 0}
                size="sm"
                type="button"
                variant="outline"
              >
                <Trash2 />
                {t("clearHistory")}
              </Button>
            }
          />
          <Button
            aria-label={t("refresh")}
            disabled={clearing}
            onClick={() => void load(offset)}
            size="icon"
            type="button"
            variant="outline"
          >
            <RefreshCw />
          </Button>
        </div>
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
                <TableHead className="w-[22%]">{t("event")}</TableHead>
                <TableHead className="w-[18%]">{t("issue")}</TableHead>
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
                        {delivery.retryCount ? (
                          <Badge className="mt-1" variant="outline">
                            {t("retry", { count: delivery.retryCount })}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <p className="font-mono text-sm">
                          {delivery.issueKey ?? "—"}
                        </p>
                        {delivery.projectKey && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {delivery.projectKey}
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
