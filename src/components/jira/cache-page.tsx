"use client";

import { Database, ExternalLink, RefreshCw, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty as EmptyState,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import type {
  JiraApiCallView,
  JiraCachedTicketView,
  JiraCacheMetrics,
  JiraMetricWindow,
  JiraSettingsView,
  PaginatedResult,
} from "@/services/jira/types";

const PAGE_SIZE = 50;
const SETTINGS_FIELDS =
  "siteUrl email tokenConfigured cacheTtlSeconds updatedAt";
const WINDOW_FIELDS = "window total live cache errors averageMs";
const CALL_FIELDS =
  "id operation requestSummary source durationMs statusCode error itemCount servedStale createdAt";
const CACHED_TICKET_FIELDS =
  "issueKey projectKey summary status coverage stale summaryFetchedAt detailFetchedAt commentsFetchedAt updatedAt";

type CachePageData = {
  jiraSettings: JiraSettingsView;
  jiraCacheMetrics: JiraCacheMetrics;
  jiraApiCalls: PaginatedResult<JiraApiCallView>;
  jiraCachedTickets: PaginatedResult<JiraCachedTicketView>;
};

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

function sourceClass(source: string) {
  if (source === "LIVE")
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  if (source === "ERROR")
    return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function JiraCachePage() {
  const t = useTranslations("jiraCache");
  const tc = useTranslations("common");
  const [data, setData] = useState<CachePageData | null>(null);
  const [ttlMinutes, setTtlMinutes] = useState("5");
  const [callOffset, setCallOffset] = useState(0);
  const [ticketOffset, setTicketOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await controlPlaneRequest<CachePageData>(
        `query JiraCachePage($limit: Int!, $callOffset: Int!, $ticketOffset: Int!) {
          jiraSettings { ${SETTINGS_FIELDS} }
          jiraCacheMetrics { windows { ${WINDOW_FIELDS} } operations { operation windows { ${WINDOW_FIELDS} } } }
          jiraApiCalls(limit: $limit, offset: $callOffset) { items { ${CALL_FIELDS} } total limit offset }
          jiraCachedTickets(limit: $limit, offset: $ticketOffset) { items { ${CACHED_TICKET_FIELDS} } total limit offset }
        }`,
        { limit: PAGE_SIZE, callOffset, ticketOffset },
      );
      setData(result);
      setTtlMinutes(
        String(Math.round(result.jiraSettings.cacheTtlSeconds / 60)),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [callOffset, ticketOffset]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const updateTtl = async (event: FormEvent) => {
    event.preventDefault();
    setBusyKey("ttl");
    try {
      await controlPlaneRequest(
        "mutation UpdateJiraCacheTtl($ttlMinutes: Int!) { updateJiraCacheTtl(ttlMinutes: $ttlMinutes) { cacheTtlSeconds } }",
        { ttlMinutes: Number(ttlMinutes) },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const clearCache = async () => {
    setBusyKey("clear");
    try {
      await controlPlaneRequest("mutation { clearJiraCache }");
      setTicketOffset(0);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const refreshTicket = async (issueKey: string) => {
    setBusyKey(issueKey);
    try {
      await controlPlaneRequest(
        "mutation RefreshCachedTicket($issueKey: ID!) { refreshJiraCachedTicket(issueKey: $issueKey) { key } }",
        { issueKey },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteTicket = async (issueKey: string) => {
    setBusyKey(issueKey);
    try {
      await controlPlaneRequest(
        "mutation DeleteCachedTicket($issueKey: ID!) { deleteJiraCachedTicket(issueKey: $issueKey) }",
        { issueKey },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form
            className="flex gap-2"
            onSubmit={(event) => void updateTtl(event)}
          >
            <Label className="sr-only" htmlFor="cache-ttl">
              {t("ttl")}
            </Label>
            <Input
              className="w-28"
              id="cache-ttl"
              max={1440}
              min={1}
              onChange={(event) => setTtlMinutes(event.target.value)}
              required
              type="number"
              value={ttlMinutes}
            />
            <Button
              disabled={busyKey === "ttl"}
              type="submit"
              variant="outline"
            >
              <Save />
              {t("saveTtl")}
            </Button>
          </form>
          <ConfirmationDialog
            actionLabel={t("clearCache")}
            cancelLabel={tc("cancel")}
            description={tc("cannotBeUndone")}
            onConfirm={clearCache}
            title={t("confirmClear")}
            trigger={
              <Button disabled={busyKey === "clear"} variant="destructive">
                <Trash2 />
                {t("clearCache")}
              </Button>
            }
          />
        </div>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading && !data ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("loading")}
        </div>
      ) : (
        data && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.jiraCacheMetrics.windows.map((window) => (
                <MetricCard key={window.window} metric={window} />
              ))}
            </div>
            <Panel
              title={t("operationsTitle")}
              description={t("operationsDescription")}
            >
              {data.jiraCacheMetrics.operations.length === 0 ? (
                <Empty>{t("noMetrics")}</Empty>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("operation")}</TableHead>
                      {data.jiraCacheMetrics.windows.map((window) => (
                        <TableHead key={window.window}>
                          {window.window}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.jiraCacheMetrics.operations.map((operation) => (
                      <TableRow key={operation.operation}>
                        <TableCell className="font-medium">
                          {operation.operation.replaceAll("_", " ")}
                        </TableCell>
                        {operation.windows.map((window) => (
                          <TableCell key={window.window}>
                            <span className="font-medium">{window.total}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              L {window.live} · C {window.cache} · E{" "}
                              {window.errors}
                            </span>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
            <Panel
              title={t("recentTitle")}
              description={t("recentDescription")}
            >
              {data.jiraApiCalls.items.length === 0 ? (
                <Empty>{t("noCalls")}</Empty>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("time")}</TableHead>
                        <TableHead>{t("operation")}</TableHead>
                        <TableHead>{t("fetched")}</TableHead>
                        <TableHead>{t("source")}</TableHead>
                        <TableHead>{t("duration")}</TableHead>
                        <TableHead>{t("error")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.jiraApiCalls.items.map((call) => (
                        <TableRow key={call.id}>
                          <TableCell>{when(call.createdAt)}</TableCell>
                          <TableCell className="font-medium">
                            {call.operation.replaceAll("_", " ")}
                          </TableCell>
                          <TableCell className="max-w-sm whitespace-normal">
                            {call.requestSummary}
                            {call.itemCount !== null
                              ? ` · ${call.itemCount}`
                              : ""}
                          </TableCell>
                          <TableCell>
                            <Badge className={sourceClass(call.source)}>
                              {call.source}
                              {call.servedStale ? ` · ${t("stale")}` : ""}
                            </Badge>
                          </TableCell>
                          <TableCell>{call.durationMs} ms</TableCell>
                          <TableCell className="max-w-sm whitespace-normal text-destructive">
                            {call.error ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Pager
                    offset={callOffset}
                    setOffset={setCallOffset}
                    total={data.jiraApiCalls.total}
                  />
                </>
              )}
            </Panel>
            <Panel
              title={t("ticketsTitle")}
              description={t("ticketsDescription")}
            >
              {data.jiraCachedTickets.items.length === 0 ? (
                <Empty>{t("noTickets")}</Empty>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("ticket")}</TableHead>
                        <TableHead>{t("status")}</TableHead>
                        <TableHead>{t("coverage")}</TableHead>
                        <TableHead>{t("freshness")}</TableHead>
                        <TableHead>{t("lastFetched")}</TableHead>
                        <TableHead className="text-right">
                          {t("actions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.jiraCachedTickets.items.map((ticket) => (
                        <TableRow key={ticket.issueKey}>
                          <TableCell>
                            <p className="font-medium">
                              {ticket.issueKey} · {ticket.summary}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {ticket.projectKey}
                            </p>
                          </TableCell>
                          <TableCell>{ticket.status ?? "—"}</TableCell>
                          <TableCell>
                            <Badge>{ticket.coverage}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              className={
                                ticket.stale
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                  : sourceClass("CACHE")
                              }
                            >
                              {ticket.stale ? t("stale") : t("fresh")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {when(
                              ticket.detailFetchedAt ?? ticket.summaryFetchedAt,
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button asChild size="icon-sm" variant="ghost">
                                <Link
                                  href={`/jira/cache/tickets/${ticket.issueKey}`}
                                >
                                  <ExternalLink />
                                  <span className="sr-only">{t("open")}</span>
                                </Link>
                              </Button>
                              <Button
                                disabled={busyKey === ticket.issueKey}
                                onClick={() =>
                                  void refreshTicket(ticket.issueKey)
                                }
                                size="icon-sm"
                                variant="ghost"
                              >
                                <RefreshCw
                                  className={
                                    busyKey === ticket.issueKey
                                      ? "animate-spin"
                                      : undefined
                                  }
                                />
                                <span className="sr-only">{t("refresh")}</span>
                              </Button>
                              <ConfirmationDialog
                                actionLabel={t("delete")}
                                cancelLabel={tc("cancel")}
                                description={tc("cannotBeUndone")}
                                onConfirm={() => deleteTicket(ticket.issueKey)}
                                title={t("confirmDeleteTicket", {
                                  issueKey: ticket.issueKey,
                                })}
                                trigger={
                                  <Button
                                    disabled={busyKey === ticket.issueKey}
                                    size="icon-sm"
                                    variant="ghost"
                                  >
                                    <Trash2 />
                                    <span className="sr-only">
                                      {t("delete")}
                                    </span>
                                  </Button>
                                }
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Pager
                    offset={ticketOffset}
                    setOffset={setTicketOffset}
                    total={data.jiraCachedTickets.total}
                  />
                </>
              )}
            </Panel>
          </>
        )
      )}
    </section>
  );
}

function MetricCard({ metric }: { metric: JiraMetricWindow }) {
  const t = useTranslations("jiraCache");
  return (
    <Card>
      <CardContent>
        <div className="flex items-center justify-between">
          <span className="font-medium">{metric.window}</span>
          <Database className="size-4 text-muted-foreground" />
        </div>
        <p className="mt-3 text-3xl font-semibold">{metric.total}</p>
        <p className="text-xs text-muted-foreground">
          {t("average", { ms: metric.averageMs })}
        </p>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <span>
            {t("live")} {metric.live}
          </span>
          <span>
            {t("cache")} {metric.cache}
          </span>
          <span>
            {t("errors")} {metric.errors}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children}
    </Card>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <EmptyState className="py-8">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </EmptyState>
  );
}

function Pager({
  offset,
  setOffset,
  total,
}: {
  offset: number;
  setOffset: (offset: number) => void;
  total: number;
}) {
  const t = useTranslations("jiraCache");
  return (
    <div className="flex items-center justify-between border-t p-3 text-sm">
      <span className="text-muted-foreground">
        {t("showing", {
          start: total === 0 ? 0 : offset + 1,
          end: Math.min(offset + PAGE_SIZE, total),
          total,
        })}
      </span>
      <div className="flex gap-2">
        <Button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          size="sm"
          variant="outline"
        >
          {t("previous")}
        </Button>
        <Button
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          size="sm"
          variant="outline"
        >
          {t("next")}
        </Button>
      </div>
    </div>
  );
}
