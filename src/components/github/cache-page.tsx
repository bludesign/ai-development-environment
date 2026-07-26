"use client";

import {
  Database,
  ExternalLink,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
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
import { SearchableSelect } from "@/components/common/searchable-select";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  GitHubApiType,
  GitHubCachedEntryView,
  GitHubCacheMetrics,
  GitHubCacheTtlOverrideView,
  GitHubCallSource,
  GitHubMetricWindow,
  GitHubPaginatedResult,
  GitHubRateLimitSnapshotView,
  GitHubRequestSource,
  GitHubSettingsView,
} from "@/services/github/types";

const PAGE_SIZE = 50;
const WINDOW_FIELDS =
  "window total live cache errors averageMs pointsUsed pointsAvoided";
const API_TYPE_FILTERS = ["ALL", "GRAPHQL", "REST"] as const;
const CALL_SOURCE_FILTERS = ["ALL", "LIVE", "CACHE"] as const;
const REQUEST_SOURCE_FILTERS = [
  "ALL",
  "GITHUB_API",
  "GITHUB_SETTINGS",
  "COMMENTS_PAGE",
  "CODEBASE_REPOSITORY",
  "PULL_REQUESTS_PAGE",
  "PULL_REQUEST_DETAILS",
  "ACTIONS_PAGE",
  "WORKTREES",
  "WORKTREE_PIPELINES",
  "WORKTREE_AUTOMATION",
  "AUTO_RETRY",
  "WORKFLOW_AUTOMATION",
  "ACTIONS_NOTIFICATIONS",
  "CACHE_MANAGEMENT",
] as const;

type ApiTypeFilter = GitHubApiType | "ALL";
type CallSourceFilter = Exclude<GitHubCallSource, "ERROR"> | "ALL";
type RequestSourceFilter = GitHubRequestSource | "ALL";

type CachePageData = {
  githubSettings: GitHubSettingsView;
  githubCacheTtlOverrides: GitHubCacheTtlOverrideView[];
  githubCacheableGraphqlOperations: string[];
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

function visibleRequestSummary(call: GitHubApiCallView) {
  if (
    !call.variables ||
    typeof call.variables !== "object" ||
    Array.isArray(call.variables)
  ) {
    return call.requestSummary;
  }

  const entries = Object.entries(
    call.variables as Record<string, unknown>,
  ).filter(([, value]) => value !== null);
  if (entries.length === 0) return "No variables";
  if (entries.length === Object.keys(call.variables).length) {
    return call.requestSummary;
  }

  return entries
    .map(([key, value]) => {
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      const serialized = encoded ?? String(value);
      return `${key}=${serialized.length > 120 ? `${serialized.slice(0, 117)}…` : serialized}`;
    })
    .join(" · ");
}

export function GitHubCachePage() {
  const t = useTranslations("githubCache");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [data, setData] = useState<CachePageData | null>(null);
  const [ttlMinutes, setTtlMinutes] = useState("5");
  const [overrideOperation, setOverrideOperation] = useState("");
  const [overrideTtlSeconds, setOverrideTtlSeconds] = useState("60");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>(
    {},
  );
  const [callOffset, setCallOffset] = useState(0);
  const [entryOffset, setEntryOffset] = useState(0);
  const [apiTypeFilter, setApiTypeFilter] = useState<ApiTypeFilter>("ALL");
  const [requestSourceFilter, setRequestSourceFilter] =
    useState<RequestSourceFilter>("ALL");
  const [callSourceFilter, setCallSourceFilter] =
    useState<CallSourceFilter>("ALL");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await controlPlaneRequest<CachePageData>(
        `query GitHubCachePage($limit: Int!, $callOffset: Int!, $entryOffset: Int!, $apiType: GitHubApiType, $requestSource: GitHubRequestSource, $callSource: GitHubCallSource) {
          githubSettings { tokenConfigured defaultJiraKeyRegex actionsNotificationPollIntervalSeconds cacheTtlSeconds updatedAt }
          githubCacheTtlOverrides { operation ttlSeconds builtIn createdAt updatedAt }
          githubCacheableGraphqlOperations
          githubRateLimitSnapshots { authentication resource limit remaining used resetAt observedAt }
          githubCacheMetrics {
            windows { ${WINDOW_FIELDS} }
            apiTypes { apiType windows { ${WINDOW_FIELDS} } }
            operations { operation windows { ${WINDOW_FIELDS} } }
            requestSources { requestSource windows { ${WINDOW_FIELDS} } }
          }
          githubApiCalls(limit: $limit, offset: $callOffset, apiType: $apiType, requestSource: $requestSource, source: $callSource) {
            items { id authentication apiType method endpoint operation requestSource requestSummary variables source durationMs statusCode error servedStale pointCost pointsAvoided rateLimitLimit rateLimitRemaining rateLimitUsed rateLimitResetAt rateLimitResource createdAt }
            total limit offset
          }
          githubCachedEntries(limit: $limit, offset: $entryOffset) {
            items { id authentication operation endpoint fetchedAt pointCost stale }
            total limit offset
          }
        }`,
        {
          limit: PAGE_SIZE,
          callOffset,
          entryOffset,
          apiType: apiTypeFilter === "ALL" ? undefined : apiTypeFilter,
          requestSource:
            requestSourceFilter === "ALL" ? undefined : requestSourceFilter,
          callSource: callSourceFilter === "ALL" ? undefined : callSourceFilter,
        },
      );
      setData(result);
      setTtlMinutes(
        String(Math.round(result.githubSettings.cacheTtlSeconds / 60)),
      );
      setOverrideDrafts(
        Object.fromEntries(
          result.githubCacheTtlOverrides.map((override) => [
            override.operation,
            String(override.ttlSeconds),
          ]),
        ),
      );
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [
    apiTypeFilter,
    callOffset,
    callSourceFilter,
    entryOffset,
    requestSourceFilter,
  ]);

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

  const saveTtlOverride = async (
    operation: string,
    ttlSeconds: string,
    busyKeyValue: string,
  ): Promise<boolean> => {
    setBusyKey(busyKeyValue);
    try {
      await controlPlaneRequest(
        `mutation SaveGitHubCacheTtlOverride($input: SaveGitHubCacheTtlOverrideInput!) {
          saveGitHubCacheTtlOverride(input: $input) { operation ttlSeconds builtIn createdAt updatedAt }
        }`,
        { input: { operation, ttlSeconds: Number(ttlSeconds) } },
      );
      await load();
      setError(null);
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const addTtlOverride = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await saveTtlOverride(
      overrideOperation,
      overrideTtlSeconds,
      "override:add",
    );
    if (saved) {
      setOverrideOperation("");
      setOverrideTtlSeconds("60");
    }
  };

  const deleteTtlOverride = async (operation: string) => {
    setBusyKey(`override:delete:${operation}`);
    try {
      await controlPlaneRequest(
        `mutation DeleteGitHubCacheTtlOverride($operation: String!) {
          deleteGitHubCacheTtlOverride(operation: $operation)
        }`,
        { operation },
      );
      await load();
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const clearApiCalls = async () => {
    setBusyKey("clear-calls");
    try {
      await controlPlaneRequest("mutation { clearGitHubApiCalls }");
      setCallOffset(0);
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
            <Panel
              title={t("overridesTitle")}
              description={t("overridesDescription")}
            >
              <form
                className="grid gap-3 border-b p-4 md:grid-cols-[minmax(0,1fr)_10rem_auto] md:items-end"
                onSubmit={(event) => void addTtlOverride(event)}
              >
                <div className="space-y-2">
                  <Label>{t("overrideOperation")}</Label>
                  <SearchableSelect
                    allowCustomValue
                    ariaLabel={t("overrideOperation")}
                    emptyMessage={t("noOperationMatches")}
                    onValueChange={setOverrideOperation}
                    options={data.githubCacheableGraphqlOperations
                      .filter(
                        (operation) =>
                          !data.githubCacheTtlOverrides.some(
                            (override) => override.operation === operation,
                          ),
                      )
                      .map((operation) => ({
                        value: operation,
                        label: operation,
                      }))}
                    placeholder={t("selectOperation")}
                    searchPlaceholder={t("searchOperations")}
                    value={overrideOperation}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="github-cache-override-ttl">
                    {t("overrideTtl")}
                  </Label>
                  <Input
                    id="github-cache-override-ttl"
                    max={86400}
                    min={1}
                    onChange={(event) =>
                      setOverrideTtlSeconds(event.target.value)
                    }
                    required
                    type="number"
                    value={overrideTtlSeconds}
                  />
                </div>
                <Button
                  disabled={
                    busyKey === "override:add" || !overrideOperation.trim()
                  }
                  type="submit"
                  variant="outline"
                >
                  {busyKey === "override:add" ? <Spinner /> : <Plus />}
                  {t("addOverride")}
                </Button>
              </form>
              <p className="border-b px-4 py-3 text-xs text-muted-foreground">
                {t("overridesHelp")}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("operation")}</TableHead>
                    <TableHead>{t("overrideTtl")}</TableHead>
                    <TableHead>{t("overrideType")}</TableHead>
                    <TableHead className="text-right">{t("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.githubCacheTtlOverrides.map((override) => {
                    const saveKey = `override:save:${override.operation}`;
                    const deleteKey = `override:delete:${override.operation}`;
                    return (
                      <TableRow key={override.operation}>
                        <TableCell className="font-mono text-sm font-medium">
                          {override.operation}
                        </TableCell>
                        <TableCell>
                          <Input
                            aria-label={t("overrideTtlFor", {
                              operation: override.operation,
                            })}
                            className="w-28"
                            max={86400}
                            min={1}
                            onChange={(event) =>
                              setOverrideDrafts((current) => ({
                                ...current,
                                [override.operation]: event.target.value,
                              }))
                            }
                            required
                            type="number"
                            value={
                              overrideDrafts[override.operation] ??
                              String(override.ttlSeconds)
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {override.builtIn
                              ? t("builtInOverride")
                              : t("customOverride")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              aria-label={t("saveOverride", {
                                operation: override.operation,
                              })}
                              disabled={busyKey === saveKey}
                              onClick={() =>
                                void saveTtlOverride(
                                  override.operation,
                                  overrideDrafts[override.operation] ??
                                    String(override.ttlSeconds),
                                  saveKey,
                                )
                              }
                              size="icon-sm"
                              variant="ghost"
                            >
                              {busyKey === saveKey ? <Spinner /> : <Save />}
                            </Button>
                            {!override.builtIn && (
                              <ConfirmationDialog
                                actionLabel={t("deleteOverride")}
                                cancelLabel={tc("cancel")}
                                description={t("confirmDeleteOverride", {
                                  operation: override.operation,
                                })}
                                onConfirm={() =>
                                  deleteTtlOverride(override.operation)
                                }
                                title={t("deleteOverride")}
                                trigger={
                                  <Button
                                    aria-label={t("deleteOverrideFor", {
                                      operation: override.operation,
                                    })}
                                    disabled={busyKey === deleteKey}
                                    size="icon-sm"
                                    variant="ghost"
                                  >
                                    <Trash2 />
                                  </Button>
                                }
                              />
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Panel>
            <RateLimitSection
              apiMetrics={data.githubCacheMetrics.apiTypes}
              snapshots={data.githubRateLimitSnapshots}
            />
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
                            <MetricWindowDetails metric={window} />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
            <Panel
              title={t("sourcesTitle")}
              description={t("sourcesDescription")}
            >
              {data.githubCacheMetrics.requestSources.length === 0 ? (
                <EmptyState>{t("noMetrics")}</EmptyState>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("source")}</TableHead>
                      {data.githubCacheMetrics.windows.map((window) => (
                        <TableHead key={window.window}>
                          {window.window}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.githubCacheMetrics.requestSources.map((source) => (
                      <TableRow key={source.requestSource}>
                        <TableCell className="font-medium">
                          {t(`requestSources.${source.requestSource}`)}
                        </TableCell>
                        {source.windows.map((window) => (
                          <TableCell key={window.window}>
                            <MetricWindowDetails metric={window} />
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
              action={
                <ConfirmationDialog
                  actionLabel={t("clearCalls")}
                  cancelLabel={tc("cancel")}
                  description={tc("cannotBeUndone")}
                  onConfirm={clearApiCalls}
                  title={t("confirmClearCalls")}
                  trigger={
                    <Button
                      disabled={
                        busyKey === "clear-calls" ||
                        data.githubApiCalls.total === 0
                      }
                      size="sm"
                      variant="outline"
                    >
                      <Trash2 />
                      {t("clearCalls")}
                    </Button>
                  }
                />
              }
            >
              <div className="flex flex-wrap gap-2 border-b p-3">
                <Select
                  onValueChange={(value) => {
                    setCallOffset(0);
                    setApiTypeFilter(value as ApiTypeFilter);
                  }}
                  value={apiTypeFilter}
                >
                  <SelectTrigger
                    aria-label={t("filterApiType")}
                    className="min-w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {API_TYPE_FILTERS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === "ALL" ? t("allApiTypes") : value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  onValueChange={(value) => {
                    setCallOffset(0);
                    setRequestSourceFilter(value as RequestSourceFilter);
                  }}
                  value={requestSourceFilter}
                >
                  <SelectTrigger
                    aria-label={t("filterRequestSource")}
                    className="min-w-52"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {REQUEST_SOURCE_FILTERS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === "ALL"
                          ? t("allRequestSources")
                          : t(`requestSources.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  onValueChange={(value) => {
                    setCallOffset(0);
                    setCallSourceFilter(value as CallSourceFilter);
                  }}
                  value={callSourceFilter}
                >
                  <SelectTrigger
                    aria-label={t("filterCallSource")}
                    className="min-w-40"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {CALL_SOURCE_FILTERS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value === "ALL"
                          ? t("liveAndCache")
                          : t(`statuses.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
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
                        <TableHead className="min-w-56">
                          {t("status")}
                        </TableHead>
                        <TableHead>{t("error")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {callGroups.map((group) => (
                        <Fragment key={group.key}>
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell
                              className="py-1.5 text-xs font-normal text-muted-foreground"
                              colSpan={6}
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
                                </div>
                                <p className="mt-1">
                                  {call.operation.replaceAll("_", " ")}
                                </p>
                                <p className="mt-1 max-w-sm truncate font-mono text-xs font-normal text-muted-foreground">
                                  {call.method} {call.endpoint}
                                </p>
                                <p className="mt-1 text-xs font-normal text-muted-foreground">
                                  {call.durationMs} ms · HTTP{" "}
                                  {call.statusCode ?? "—"}
                                </p>
                              </TableCell>
                              <TableCell className="max-w-md whitespace-normal">
                                <HoverCard openDelay={0}>
                                  <HoverCardTrigger asChild>
                                    <button
                                      className="cursor-help text-left text-sm"
                                      type="button"
                                    >
                                      {visibleRequestSummary(call)}
                                    </button>
                                  </HoverCardTrigger>
                                  <HoverCardContent
                                    align="start"
                                    className="w-auto max-w-[min(32rem,calc(100vw-2rem))] p-0"
                                  >
                                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 text-xs leading-4">
                                      {JSON.stringify(call.variables, null, 2)}
                                    </pre>
                                  </HoverCardContent>
                                </HoverCard>
                              </TableCell>
                              <TableCell>
                                {t(`requestSources.${call.requestSource}`)}
                              </TableCell>
                              <TableCell className="min-w-56 whitespace-normal">
                                <Badge className={statusClass(call.source)}>
                                  {t(`statuses.${call.source}`)}
                                  {call.servedStale ? ` · ${t("stale")}` : ""}
                                </Badge>
                                <div className="mt-2">
                                  <span className="font-medium">
                                    {call.pointCost ?? "—"}
                                  </span>
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    {t("avoided", {
                                      count: call.pointsAvoided,
                                    })}
                                  </span>
                                  <span className="block text-xs text-muted-foreground">
                                    {call.rateLimitResource ?? "—"} ·{" "}
                                    {t("used")} {call.rateLimitUsed ?? "—"} ·{" "}
                                    {t("remaining")}{" "}
                                    {call.rateLimitRemaining ?? "—"}/
                                    {call.rateLimitLimit ?? "—"}
                                  </span>
                                  {call.rateLimitResetAt && (
                                    <span className="block text-xs text-muted-foreground">
                                      {t("reset")}{" "}
                                      <DateTime value={call.rateLimitResetAt} />
                                    </span>
                                  )}
                                </div>
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
  apiMetrics,
  snapshots,
}: {
  apiMetrics: GitHubCacheMetrics["apiTypes"];
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
        metrics={
          apiMetrics.find((metrics) => metrics.apiType === "GRAPHQL")
            ?.windows ?? []
        }
        snapshots={graphql}
      />
      <RateLimitPanel
        title={t("restRateTitle")}
        description={t("restRateDescription")}
        metrics={
          apiMetrics.find((metrics) => metrics.apiType === "REST")?.windows ??
          []
        }
        snapshots={rest}
      />
    </div>
  );
}

function RateLimitPanel({
  title,
  description,
  metrics,
  snapshots,
}: {
  title: string;
  description: string;
  metrics: GitHubMetricWindow[];
  snapshots: GitHubRateLimitSnapshotView[];
}) {
  const t = useTranslations("githubCache");
  return (
    <Panel title={title} description={description}>
      <div>
        {snapshots.length === 0 ? (
          <EmptyState>{t("noRateData")}</EmptyState>
        ) : (
          <div
            className={`grid gap-3 p-4 ${snapshots.length > 1 ? "sm:grid-cols-2" : ""}`}
          >
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
        <div className="grid grid-cols-2 gap-3 border-t p-4">
          {metrics.map((metric) => (
            <MetricCard key={metric.window} metric={metric} />
          ))}
        </div>
      </div>
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

function MetricWindowDetails({ metric }: { metric: GitHubMetricWindow }) {
  return (
    <>
      <span className="font-medium">{metric.total}</span>
      <span className="ml-2 text-xs text-muted-foreground">
        L {metric.live} · C {metric.cache} · E {metric.errors} · P{" "}
        {metric.pointsUsed}/{metric.pointsAvoided}
      </span>
    </>
  );
}

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {action && <CardAction>{action}</CardAction>}
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
