"use client";

import { Database, ExternalLink, RefreshCw, Save, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { DateTime } from "@/components/common/date-time";
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
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
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
import { dayKey, formatDateValue } from "@/lib/date-format";
import type {
  GitHubApiCallView,
  GitHubCachedEntryView,
  GitHubCacheMetrics,
  GitHubMetricWindow,
  GitHubPaginatedResult,
  GitHubRateLimitSnapshotView,
  GitHubSettingsView,
} from "@/services/github/types";

const PAGE_SIZE = 50;
const WINDOW_FIELDS =
  "window total live cache errors averageMs pointsUsed pointsAvoided";

type CachePageData = {
  githubSettings: GitHubSettingsView;
  githubRateLimitSnapshots: GitHubRateLimitSnapshotView[];
  githubCacheMetrics: GitHubCacheMetrics;
  githubApiCalls: GitHubPaginatedResult<GitHubApiCallView>;
  githubCachedEntries: GitHubPaginatedResult<GitHubCachedEntryView>;
};

function statusClass(source: string) {
  if (source === "LIVE")
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  if (source === "ERROR")
    return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

export function GitHubCachePage() {
  const t = useTranslations("githubCache");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [data, setData] = useState<CachePageData | null>(null);
  const [ttlMinutes, setTtlMinutes] = useState("5");
  const [callOffset, setCallOffset] = useState(0);
  const [entryOffset, setEntryOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await controlPlaneRequest<CachePageData>(
        `query GitHubCachePage($limit: Int!, $callOffset: Int!, $entryOffset: Int!) {
          githubSettings { tokenConfigured defaultJiraKeyRegex actionsNotificationPollIntervalSeconds cacheTtlSeconds updatedAt }
          githubRateLimitSnapshots { authentication resource limit remaining used resetAt observedAt }
          githubCacheMetrics { windows { ${WINDOW_FIELDS} } operations { operation windows { ${WINDOW_FIELDS} } } }
          githubApiCalls(limit: $limit, offset: $callOffset) {
            items { id authentication apiType method endpoint operation requestSource requestSummary variables source durationMs statusCode error servedStale pointCost pointsAvoided rateLimitLimit rateLimitRemaining rateLimitUsed rateLimitResetAt rateLimitResource createdAt }
            total limit offset
          }
          githubCachedEntries(limit: $limit, offset: $entryOffset) {
            items { id authentication operation endpoint fetchedAt pointCost stale }
            total limit offset
          }
        }`,
        { limit: PAGE_SIZE, callOffset, entryOffset },
      );
      setData(result);
      setTtlMinutes(
        String(Math.round(result.githubSettings.cacheTtlSeconds / 60)),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [callOffset, entryOffset]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const callGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      dateKey: string;
      label: string;
      items: GitHubApiCallView[];
    }> = [];
    for (const call of data?.githubApiCalls.items ?? []) {
      const date = new Date(call.createdAt);
      const dateKey = dayKey(date) ?? call.createdAt;
      const group = groups.at(-1);
      if (group?.dateKey === dateKey) {
        group.items.push(call);
      } else {
        groups.push({
          key: `${dateKey}-${call.id}`,
          dateKey,
          label: formatDateValue(date, "long", {
            locale,
            showTime: false,
          }),
          items: [call],
        });
      }
    }
    return groups;
  }, [data?.githubApiCalls.items, locale]);

  const updateTtl = async (event: FormEvent) => {
    event.preventDefault();
    setBusyKey("ttl");
    try {
      await controlPlaneRequest(
        "mutation UpdateGitHubCacheTtl($ttlMinutes: Int!) { updateGitHubCacheTtl(ttlMinutes: $ttlMinutes) { cacheTtlSeconds } }",
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
      await controlPlaneRequest("mutation { clearGitHubCache }");
      setEntryOffset(0);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const refreshEntry = async (id: string) => {
    setBusyKey(id);
    try {
      await controlPlaneRequest(
        "mutation RefreshGitHubCachedEntry($id: ID!) { refreshGitHubCachedEntry(id: $id) { id } }",
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteEntry = async (id: string) => {
    setBusyKey(id);
    try {
      await controlPlaneRequest(
        "mutation DeleteGitHubCachedEntry($id: ID!) { deleteGitHubCachedEntry(id: $id) }",
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
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
            <Label className="sr-only" htmlFor="github-cache-ttl">
              {t("ttl")}
            </Label>
            <Input
              className="w-28"
              id="github-cache-ttl"
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
            <RateLimitSection snapshots={data.githubRateLimitSnapshots} />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {data.githubCacheMetrics.windows.map((window) => (
                <MetricCard key={window.window} metric={window} />
              ))}
            </div>
            <Panel
              title={t("operationsTitle")}
              description={t("operationsDescription")}
            >
              {data.githubCacheMetrics.operations.length === 0 ? (
                <EmptyState>{t("noMetrics")}</EmptyState>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("operation")}</TableHead>
                      {data.githubCacheMetrics.windows.map((window) => (
                        <TableHead key={window.window}>
                          {window.window}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.githubCacheMetrics.operations.map((operation) => (
                      <TableRow key={operation.operation}>
                        <TableCell className="font-medium">
                          {operation.operation.replaceAll("_", " ")}
                        </TableCell>
                        {operation.windows.map((window) => (
                          <TableCell key={window.window}>
                            <span className="font-medium">{window.total}</span>
                            <span className="ml-2 text-xs text-muted-foreground">
                              L {window.live} · C {window.cache} · E{" "}
                              {window.errors} · P {window.pointsUsed}/
                              {window.pointsAvoided}
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
              {data.githubApiCalls.items.length === 0 ? (
                <EmptyState>{t("noCalls")}</EmptyState>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("time")}</TableHead>
                        <TableHead>{t("operation")}</TableHead>
                        <TableHead>{t("callInfo")}</TableHead>
                        <TableHead>{t("source")}</TableHead>
                        <TableHead>{t("status")}</TableHead>
                        <TableHead>{t("pointRate")}</TableHead>
                        <TableHead>{t("error")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {callGroups.map((group) => (
                        <Fragment key={group.key}>
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell
                              className="py-1.5 text-xs font-normal text-muted-foreground"
                              colSpan={7}
                            >
                              {group.label}
                            </TableCell>
                          </TableRow>
                          {group.items.map((call) => (
                            <TableRow key={call.id}>
                              <TableCell>
                                <DateTime kind="time" value={call.createdAt} />
                              </TableCell>
                              <TableCell className="font-medium">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline">
                                    {call.apiType}
                                  </Badge>
                                  <Badge variant="secondary">
                                    {call.authentication}
                                  </Badge>
                                  <span>
                                    {call.operation.replaceAll("_", " ")}
                                  </span>
                                </div>
                                <p className="mt-1 max-w-sm truncate font-mono text-xs font-normal text-muted-foreground">
                                  {call.method} {call.endpoint}
                                </p>
                                <p className="mt-1 text-xs font-normal text-muted-foreground">
                                  {call.durationMs} ms · HTTP{" "}
                                  {call.statusCode ?? "—"}
                                </p>
                              </TableCell>
                              <TableCell className="max-w-md whitespace-normal">
                                <p className="text-sm">{call.requestSummary}</p>
                                <pre className="mt-1 max-h-24 max-w-md overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs leading-4">
                                  {JSON.stringify(call.variables, null, 2)}
                                </pre>
                              </TableCell>
                              <TableCell>
                                {t(`requestSources.${call.requestSource}`)}
                              </TableCell>
                              <TableCell>
                                <Badge className={statusClass(call.source)}>
                                  {t(`statuses.${call.source}`)}
                                  {call.servedStale ? ` · ${t("stale")}` : ""}
                                </Badge>
                              </TableCell>
                              <TableCell className="whitespace-normal">
                                <span className="font-medium">
                                  {call.pointCost ?? "—"}
                                </span>
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {t("avoided", { count: call.pointsAvoided })}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {call.rateLimitResource ?? "—"} · {t("used")}{" "}
                                  {call.rateLimitUsed ?? "—"} · {t("remaining")}{" "}
                                  {call.rateLimitRemaining ?? "—"}/
                                  {call.rateLimitLimit ?? "—"}
                                </span>
                                {call.rateLimitResetAt && (
                                  <span className="block text-xs text-muted-foreground">
                                    {t("reset")}{" "}
                                    <DateTime value={call.rateLimitResetAt} />
                                  </span>
                                )}
                              </TableCell>
                              <TableCell className="max-w-xs whitespace-normal text-destructive">
                                {call.error ?? "—"}
                              </TableCell>
                            </TableRow>
                          ))}
                        </Fragment>
                      ))}
                    </TableBody>
                  </Table>
                  <Pager
                    offset={callOffset}
                    setOffset={setCallOffset}
                    total={data.githubApiCalls.total}
                  />
                </>
              )}
            </Panel>
            <Panel
              title={t("entriesTitle")}
              description={t("entriesDescription")}
            >
              {data.githubCachedEntries.items.length === 0 ? (
                <EmptyState>{t("noEntries")}</EmptyState>
              ) : (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("operation")}</TableHead>
                        <TableHead>{t("authentication")}</TableHead>
                        <TableHead>{t("freshness")}</TableHead>
                        <TableHead>{t("lastFetched")}</TableHead>
                        <TableHead>{t("lastCost")}</TableHead>
                        <TableHead className="text-right">
                          {t("actions")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.githubCachedEntries.items.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            <p className="font-medium">
                              {entry.operation.replaceAll("_", " ")}
                            </p>
                            <p className="max-w-md truncate text-xs text-muted-foreground">
                              {entry.endpoint}
                            </p>
                          </TableCell>
                          <TableCell>{entry.authentication}</TableCell>
                          <TableCell>
                            <Badge
                              className={
                                entry.stale
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                  : statusClass("CACHE")
                              }
                            >
                              {entry.stale ? t("stale") : t("fresh")}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <DateTime value={entry.fetchedAt} />
                          </TableCell>
                          <TableCell>{entry.pointCost ?? "—"}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              <Button asChild size="icon-sm" variant="ghost">
                                <Link
                                  href={`/github/cache/entries/${entry.id}`}
                                >
                                  <ExternalLink />
                                  <span className="sr-only">{t("open")}</span>
                                </Link>
                              </Button>
                              <Button
                                disabled={busyKey === entry.id}
                                onClick={() => void refreshEntry(entry.id)}
                                size="icon-sm"
                                variant="ghost"
                              >
                                <RefreshCw
                                  className={
                                    busyKey === entry.id
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
                                onConfirm={() => deleteEntry(entry.id)}
                                title={t("confirmDeleteEntry", {
                                  operation: entry.operation,
                                })}
                                trigger={
                                  <Button
                                    disabled={busyKey === entry.id}
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
                    offset={entryOffset}
                    setOffset={setEntryOffset}
                    total={data.githubCachedEntries.total}
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

function RateLimitSection({
  snapshots,
}: {
  snapshots: GitHubRateLimitSnapshotView[];
}) {
  const t = useTranslations("githubCache");
  const graphql = snapshots.filter(
    (snapshot) => snapshot.resource === "graphql",
  );
  const rest = snapshots.filter((snapshot) => snapshot.resource !== "graphql");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <RateLimitPanel
        title={t("graphqlRateTitle")}
        description={t("graphqlRateDescription")}
        snapshots={graphql}
      />
      <RateLimitPanel
        title={t("restRateTitle")}
        description={t("restRateDescription")}
        snapshots={rest}
      />
    </div>
  );
}

function RateLimitPanel({
  title,
  description,
  snapshots,
}: {
  title: string;
  description: string;
  snapshots: GitHubRateLimitSnapshotView[];
}) {
  const t = useTranslations("githubCache");
  return (
    <Panel title={title} description={description}>
      {snapshots.length === 0 ? (
        <EmptyState>{t("noRateData")}</EmptyState>
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          {snapshots.map((snapshot) => (
            <Card key={`${snapshot.authentication}-${snapshot.resource}`}>
              <CardContent>
                <div className="flex justify-between">
                  <span className="font-medium">
                    {snapshot.authentication} · {snapshot.resource}
                  </span>
                  <Badge variant="outline">
                    {snapshot.remaining} / {snapshot.limit}
                  </Badge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-muted-foreground">{t("limit")}</dt>
                  <dd>{snapshot.limit}</dd>
                  <dt className="text-muted-foreground">{t("remaining")}</dt>
                  <dd>{snapshot.remaining}</dd>
                  <dt className="text-muted-foreground">{t("used")}</dt>
                  <dd>{snapshot.used}</dd>
                  <dt className="text-muted-foreground">{t("reset")}</dt>
                  <dd>
                    <DateTime value={snapshot.resetAt} />
                  </dd>
                  <dt className="text-muted-foreground">{t("resource")}</dt>
                  <dd>{snapshot.resource}</dd>
                  <dt className="text-muted-foreground">{t("observed")}</dt>
                  <dd>
                    <DateTime value={snapshot.observedAt} />
                  </dd>
                </dl>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Panel>
  );
}

function MetricCard({ metric }: { metric: GitHubMetricWindow }) {
  const t = useTranslations("githubCache");
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
        <p className="mt-2 text-xs text-muted-foreground">
          {t("points", {
            used: metric.pointsUsed,
            avoided: metric.pointsAvoided,
          })}
        </p>
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
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children}
    </Card>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Empty className="py-8">
      <EmptyHeader>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
  const t = useTranslations("githubCache");
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
