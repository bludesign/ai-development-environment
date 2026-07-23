"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  Cpu,
  FilePenLine,
  Gauge,
  Play,
  Plus,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DateTime } from "@/components/common/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { worktreeHighlightBackgroundClasses } from "@/lib/worktree-highlight";

import { RUN_LIST_FIELDS } from "./graphql-fields";
import type { AgentRunView } from "./types";

function IconAction({
  label,
  children,
  onClick,
  disabled,
  destructive,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
          }}
          size="icon-sm"
          variant={destructive ? "destructive" : "ghost"}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function EffortIcon({ effort }: { effort: string | null }) {
  const value = effort?.toLowerCase() ?? "auto";
  const Icon =
    value === "low"
      ? BatteryLow
      : value === "medium"
        ? BatteryMedium
        : value === "high" || value === "xhigh" || value === "max"
          ? BatteryFull
          : Gauge;
  return <Icon aria-hidden="true" className="size-4" />;
}

export function RunsPage({ kind }: { kind: "PLAN" | "SESSION" }) {
  const t = useTranslations("runs");
  const locale = useLocale();
  const [items, setItems] = useState<AgentRunView[]>([]);
  const [search, setSearch] = useState("");
  const [archiveFilter, setArchiveFilter] = useState("ACTIVE");
  const [provider, setProvider] = useState("ALL");
  const [origin, setOrigin] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        agentRuns: {
          items: AgentRunView[];
          nextCursor: string | null;
          totalCount: number;
        };
      }>(
        `query AgentRuns($kind: RunKind!, $search: String, $archive: String!, $provider: String, $origin: RunOrigin) {
          agentRuns(kind: $kind, search: $search, archive: $archive, provider: $provider, origin: $origin, first: 200) {
            items { ${RUN_LIST_FIELDS} } nextCursor totalCount
          }
        }`,
        {
          kind,
          search: search.trim() || null,
          archive: archiveFilter,
          provider: provider === "ALL" ? null : provider,
          origin: origin === "ALL" ? null : origin,
        },
      );
      setItems(data.agentRuns.items);
      setNextCursor(data.agentRuns.nextCursor);
      setTotalCount(data.agentRuns.totalCount);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [archiveFilter, kind, origin, provider, search]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await controlPlaneRequest<{
        agentRuns: {
          items: AgentRunView[];
          nextCursor: string | null;
          totalCount: number;
        };
      }>(
        `query MoreAgentRuns($kind: RunKind!, $search: String, $archive: String!, $provider: String, $origin: RunOrigin, $after: ID!) { agentRuns(kind: $kind, search: $search, archive: $archive, provider: $provider, origin: $origin, first: 200, after: $after) { items { ${RUN_LIST_FIELDS} } nextCursor totalCount } }`,
        {
          kind,
          search: search.trim() || null,
          archive: archiveFilter,
          provider: provider === "ALL" ? null : provider,
          origin: origin === "ALL" ? null : origin,
          after: nextCursor,
        },
      );
      setItems((current) => [
        ...current,
        ...data.agentRuns.items.filter(
          (item) => !current.some(({ id }) => id === item.id),
        ),
      ]);
      setNextCursor(data.agentRuns.nextCursor);
      setTotalCount(data.agentRuns.totalCount);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 150);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const unsubscribe = controlPlaneSubscriptions().subscribe(
      { query: "subscription RunsChanged { agentRunsChanged { id } }" },
      {
        next: () => void refresh(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return unsubscribe;
  }, [refresh]);

  const groups = useMemo(() => {
    const result: Array<{ key: string; value: string; items: AgentRunView[] }> =
      [];
    for (const item of items) {
      const key = dayKey(item.createdAt) ?? item.createdAt;
      const group = result.at(-1);
      if (group?.key === key) group.items.push(item);
      else result.push({ key, value: item.createdAt, items: [item] });
    }
    return result;
  }, [items]);

  const mutate = async (query: string, variables: Record<string, unknown>) => {
    try {
      await controlPlaneRequest(query, variables);
      setSelected(new Set());
      setError(null);
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const play = (id: string) =>
    mutate("mutation PlayPlan($id: ID!) { playPlan(planId: $id) { id } }", {
      id,
    });
  const archive = (ids: string[], archived: boolean) =>
    mutate(
      "mutation ArchiveRuns($ids: [ID!]!, $archived: Boolean!) { archiveAgentRuns(ids: $ids, archived: $archived) }",
      { ids, archived },
    );
  const remove = (ids: string[]) =>
    mutate("mutation DeleteRuns($ids: [ID!]!) { deleteAgentRuns(ids: $ids) }", {
      ids,
    });

  const title = kind === "PLAN" ? t("plans") : t("sessions");
  const detailBase = kind === "PLAN" ? "/plans" : "/sessions";
  const currency = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{title}</CardTitle>
            <div className="flex gap-2">
              <Button
                onClick={() => setEditMode((value) => !value)}
                variant="outline"
              >
                <FilePenLine /> {editMode ? t("done") : t("edit")}
              </Button>
              <Button asChild>
                <Link href={`/runs/new?kind=${kind.toLowerCase()}`}>
                  <Plus />{" "}
                  {t("newRun", {
                    kind: kind === "PLAN" ? t("plan") : t("session"),
                  })}
                </Link>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 md:grid-cols-[minmax(14rem,1fr)_11rem_11rem_11rem]">
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label={t("search", { kind: title.toLowerCase() })}
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("search", { kind: title.toLowerCase() })}
                value={search}
              />
            </div>
            <Select
              onValueChange={(value) => setArchiveFilter(value ?? "ACTIVE")}
              value={archiveFilter}
            >
              <SelectTrigger aria-label={t("archiveFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">{t("active")}</SelectItem>
                <SelectItem value="ARCHIVED">{t("archived")}</SelectItem>
                <SelectItem value="ALL">{t("all")}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) => setProvider(value ?? "ALL")}
              value={provider}
            >
              <SelectTrigger aria-label={t("provider")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("allProviders")}</SelectItem>
                <SelectItem value="CODEX">Codex</SelectItem>
                <SelectItem value="CLAUDE">Claude</SelectItem>
                <SelectItem value="OPENCODE">OpenCode</SelectItem>
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) => setOrigin(value ?? "ALL")}
              value={origin}
            >
              <SelectTrigger aria-label={t("origin")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("allOrigins")}</SelectItem>
                <SelectItem value="MANAGED">{t("managed")}</SelectItem>
                <SelectItem value="IMPORTED">{t("imported")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {editMode && selected.size > 0 && (
            <div className="flex flex-wrap gap-2 rounded-lg border bg-muted/30 p-3">
              <span className="mr-auto text-sm text-muted-foreground">
                {t("selected", { count: selected.size })}
              </span>
              <Button
                onClick={() =>
                  void archive([...selected], archiveFilter !== "ARCHIVED")
                }
                size="sm"
                variant="outline"
              >
                {archiveFilter === "ARCHIVED" ? <Undo2 /> : <Archive />}{" "}
                {archiveFilter === "ARCHIVED" ? t("restore") : t("archive")}
              </Button>
              <Button
                onClick={() => setDeleteIds([...selected])}
                size="sm"
                variant="destructive"
              >
                <Trash2 /> {t("delete")}
              </Button>
            </div>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {loading ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : !items.length ? (
        <Empty className="border py-12">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Cpu />
            </EmptyMedia>
            <EmptyTitle>{t("empty", { kind: title })}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                {editMode && <TableHead className="w-10" />}
                <TableHead>{t("id")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead>{t("repoBranch")}</TableHead>
                <TableHead>{t("ticket")}</TableHead>
                {kind === "SESSION" && <TableHead>{t("plan")}</TableHead>}
                <TableHead>{t("prompt")}</TableHead>
                <TableHead>{t("cost")}</TableHead>
                <TableHead>{t("modelEffort")}</TableHead>
                <TableHead>{t("age")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell
                      className="py-2 font-medium"
                      colSpan={
                        editMode
                          ? kind === "SESSION"
                            ? 11
                            : 10
                          : kind === "SESSION"
                            ? 10
                            : 9
                      }
                    >
                      {formatDateValue(group.value, "long", {
                        locale,
                        showTime: false,
                      })}
                    </TableCell>
                  </TableRow>
                  {group.items.map((run) => {
                    const highlighted = run.worktree?.highlightColor
                      ? worktreeHighlightBackgroundClasses[
                          run.worktree.highlightColor
                        ]
                      : undefined;
                    return (
                      <TableRow className={cn(highlighted)} key={run.id}>
                        {editMode && (
                          <TableCell>
                            <Checkbox
                              aria-label={t("selectRun", {
                                id: run.displayNumber,
                              })}
                              checked={selected.has(run.id)}
                              onCheckedChange={(checked) =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (checked) next.add(run.id);
                                  else next.delete(run.id);
                                  return next;
                                })
                              }
                            />
                          </TableCell>
                        )}
                        <TableCell>
                          <Link
                            className="font-mono font-medium hover:underline"
                            href={`${detailBase}/${run.id}`}
                          >
                            #{run.displayNumber}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex max-w-48 flex-wrap gap-1">
                            <Badge
                              variant={
                                run.status === "FAILED"
                                  ? "destructive"
                                  : run.status === "COMPLETED"
                                    ? "default"
                                    : "secondary"
                              }
                            >
                              {t(`statuses.${run.status}`)}
                            </Badge>
                            {run.phase !== run.status && (
                              <Badge variant="outline">
                                {run.phase.replaceAll("_", " ")}
                              </Badge>
                            )}
                            <Badge variant="outline">
                              {run.provider === "OPENCODE"
                                ? "OpenCode"
                                : run.provider[0] +
                                  run.provider.slice(1).toLowerCase()}
                            </Badge>
                            {run.origin === "IMPORTED" && (
                              <Badge variant="secondary">{t("imported")}</Badge>
                            )}
                            {kind === "PLAN" && (
                              <Badge
                                variant={run.playedAt ? "default" : "outline"}
                              >
                                {run.playedAt
                                  ? t("sessionCreated")
                                  : t("notRun")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-48">
                            <p className="truncate">{run.repositoryName}</p>
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {run.branch ?? "—"}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          {run.jiraIssueKey ? (
                            <Link
                              className="hover:underline"
                              href={`/jira/tickets/${encodeURIComponent(run.jiraIssueKey)}`}
                            >
                              {run.jiraIssueKey}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        {kind === "SESSION" && (
                          <TableCell>
                            {run.sourcePlan ? (
                              <Link
                                className="font-mono hover:underline"
                                href={`/plans/${run.sourcePlan.id}`}
                              >
                                #{run.sourcePlan.displayNumber}
                              </Link>
                            ) : run.sourcePlanNumber !== null ? (
                              <span className="font-mono">
                                #{run.sourcePlanNumber}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        )}
                        <TableCell>
                          <Link
                            className="block max-w-72 truncate hover:underline"
                            href={`${detailBase}/${run.id}`}
                            title={run.initialPrompt}
                          >
                            {run.initialPrompt}
                          </Link>
                        </TableCell>
                        <TableCell title={t("estimatedCost")}>
                          {run.estimatedCost === null
                            ? "—"
                            : `≈${currency.format(run.estimatedCost)}`}
                        </TableCell>
                        <TableCell>
                          <div
                            className="flex items-center gap-2"
                            title={`${run.model} · ${run.effort ?? "auto"}`}
                          >
                            <Cpu className="size-4" />
                            <span className="max-w-28 truncate text-xs">
                              {run.model}
                            </span>
                            <EffortIcon effort={run.effort} />
                          </div>
                        </TableCell>
                        <TableCell>
                          <DateTime kind="relative" value={run.createdAt} />
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            {kind === "PLAN" && (
                              <IconAction
                                disabled={
                                  run.status !== "COMPLETED" ||
                                  Boolean(run.playedAt) ||
                                  !run.finalOutput
                                }
                                label={t("play")}
                                onClick={() => void play(run.id)}
                              >
                                <Play />
                              </IconAction>
                            )}
                            <IconAction
                              label={
                                run.archivedAt ? t("restore") : t("archive")
                              }
                              onClick={() =>
                                void archive([run.id], !run.archivedAt)
                              }
                            >
                              {run.archivedAt ? <Undo2 /> : <Archive />}
                            </IconAction>
                            <IconAction
                              destructive
                              label={t("delete")}
                              onClick={() => setDeleteIds([run.id])}
                            >
                              <Trash2 />
                            </IconAction>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {items.length > 0 && (
        <div className="flex items-center justify-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t("showingCount", { count: items.length, total: totalCount })}
          </span>
          {nextCursor && (
            <Button
              disabled={loadingMore}
              onClick={() => void loadMore()}
              variant="outline"
            >
              {loadingMore ? <Spinner /> : null}
              {t("loadMore")}
            </Button>
          )}
        </div>
      )}
      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={t("cancel")}
        description={t("deleteDescription")}
        onConfirm={() => void remove(deleteIds)}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        open={deleteIds.length > 0}
        title={t("deleteTitle")}
      />
    </div>
  );
}
