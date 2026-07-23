"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  Cpu,
  FilePenLine,
  GalleryVerticalEnd,
  Play,
  Plus,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { JiraTicketDrawer } from "@/components/jira/ticket-drawer";
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
import { Link, useRouter } from "@/i18n/navigation";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import { formatModelLabel } from "@/lib/enum-label";
import { isRowActivation, rowLinkClass } from "@/lib/row-activation";
import {
  DEFAULT_RUN_FILTERS,
  writeRunFilterCookie,
  type RunFilterState,
  type RunKind,
} from "@/lib/run-filter-state";
import { cn } from "@/lib/utils";
import { worktreeHighlightBackgroundClasses } from "@/lib/worktree-highlight";

import { RUN_LIST_FIELDS } from "./graphql-fields";
import { EffortIcon } from "./effort-icon";
import { ProviderIcon } from "./provider-icon";
import { useRunLabels } from "./run-labels";
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

export function RunsPage({
  initialFilters = DEFAULT_RUN_FILTERS,
  kind,
}: {
  initialFilters?: RunFilterState;
  kind: RunKind;
}) {
  const t = useTranslations("runs");
  const labels = useRunLabels();
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<AgentRunView[]>([]);
  const [search, setSearch] = useState("");
  const [archiveFilter, setArchiveFilter] = useState(initialFilters.archive);
  const [provider, setProvider] = useState(initialFilters.provider);
  const [origin, setOrigin] = useState(initialFilters.origin);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [drawerIssueKey, setDrawerIssueKey] = useState<string | null>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    writeRunFilterCookie(kind, {
      archive: archiveFilter,
      provider,
      origin,
    });
  }, [archiveFilter, kind, origin, provider]);

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

  const loadMore = useCallback(async () => {
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
  }, [archiveFilter, kind, nextCursor, origin, provider, search]);

  useEffect(() => {
    if (!nextCursor || loading || loadingMore || error) return;
    const trigger = loadMoreTriggerRef.current;
    if (!trigger) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        void loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [error, loadMore, loading, loadingMore, nextCursor]);

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
  /** Sessions carry a source-plan column that Plans do not. */
  const session = kind === "SESSION";
  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full md:mr-auto md:w-auto md:min-w-56 md:flex-1">
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
                <SelectItem value="ALL">
                  <GalleryVerticalEnd />
                  {t("allProviders")}
                </SelectItem>
                <SelectItem value="CODEX">
                  <ProviderIcon provider="CODEX" />
                  Codex
                </SelectItem>
                <SelectItem value="CLAUDE">
                  <ProviderIcon provider="CLAUDE" />
                  Claude
                </SelectItem>
                <SelectItem value="OPENCODE">
                  <ProviderIcon provider="OPENCODE" />
                  OpenCode
                </SelectItem>
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
          {/*
           * An auto layout sizes columns to their content and hands every
           * spare pixel to the gaps, so a wider window left the same truncated
           * text sitting further apart. A fixed layout divides the whole width
           * between the columns, which means the cells below can size to their
           * column with `w-full` and only truncate when the column is genuinely
           * too narrow. Percentages, so they keep sharing at any width.
           */}
          {/*
           * Percentages alone would keep dividing a phone-width table into
           * columns too narrow to read anything in. The floor is the sum of
           * what each column actually needs — roughly 50px for the id, 122 for
           * the status badges, 160 for the repository, 200 for a two-line
           * prompt, 156 for a model name, and 114 for the action buttons — so
           * below it the container's `overflow-x-auto` takes over and the
           * table scrolls at full legibility instead of shrinking.
           */}
          <Table
            className={cn(
              "table-fixed",
              editMode ? "min-w-[67rem]" : "min-w-[64rem]",
            )}
          >
            <TableHeader>
              <TableRow>
                {editMode && <TableHead className="w-10" />}
                <TableHead className="w-[5%]">{t("id")}</TableHead>
                <TableHead className={session ? "w-[11%]" : "w-[12%]"}>
                  {t("status")}
                </TableHead>
                <TableHead className={session ? "w-[18%]" : "w-[19%]"}>
                  {t("repoBranch")}
                </TableHead>
                {/* Sized for a longer key than this workspace happens to use
                    today — `PROJ-12345` needs ~98px with padding, where
                    `AIDE-66` needs 69 — so a bigger project or issue number
                    does not start truncating the one column nobody can guess
                    the rest of from context. */}
                <TableHead className="w-[10%]">{t("ticket")}</TableHead>
                {session && (
                  <TableHead className="w-[5%]">{t("plan")}</TableHead>
                )}
                <TableHead className={session ? "w-[21%]" : "w-[22%]"}>
                  {t("prompt")}
                </TableHead>
                {/* Money right-aligns so the digits line up and the column
                    reads tight against its neighbour rather than trailing off. */}
                <TableHead className="w-[6%] text-right">{t("cost")}</TableHead>
                {/* Wide enough for the common model names to read in full;
                    only the `opencode/…` namespaced ones still truncate, and
                    the cell carries the full name as a tooltip. */}
                <TableHead className="w-[15%]">{t("modelEffort")}</TableHead>
                <TableHead
                  className={cn("text-right", session ? "w-[9%]" : "w-[11%]")}
                >
                  {t("actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell
                      className="py-1.5 text-xs font-normal text-muted-foreground"
                      colSpan={8 + (session ? 1 : 0) + (editMode ? 1 : 0)}
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
                      <TableRow
                        className={cn("cursor-pointer", highlighted)}
                        key={run.id}
                        /* In edit mode the row is a selection target, so it
                           toggles rather than navigating away mid-selection. */
                        onClick={(event) => {
                          if (!isRowActivation(event)) return;
                          if (editMode) toggleSelected(run.id);
                          else router.push(`${detailBase}/${run.id}`);
                        }}
                      >
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
                            className={cn(
                              rowLinkClass,
                              "inline-block font-mono font-medium",
                            )}
                            href={`${detailBase}/${run.id}`}
                          >
                            #{run.displayNumber}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            <Badge
                              variant={
                                run.status === "FAILED"
                                  ? "destructive"
                                  : run.status === "COMPLETED"
                                    ? "success"
                                    : "secondary"
                              }
                            >
                              {labels.status(run.status)}
                            </Badge>
                            {run.phase !== run.status &&
                              run.phase !== "IMPORTED_SYNCED" && (
                                <Badge variant="outline">
                                  {labels.phase(run.phase)}
                                </Badge>
                              )}
                            {run.origin === "IMPORTED" && (
                              <Badge variant="secondary">{t("imported")}</Badge>
                            )}
                            {kind === "PLAN" && run.playedAt && (
                              <Badge variant="default">{t("run")}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {/* Only a run whose worktree still exists can open
                              one; imported and cleaned-up runs keep the plain
                              text so the link never dead-ends. */}
                          {run.worktree ? (
                            <Link
                              className={cn(rowLinkClass, "block min-w-0")}
                              href={`/worktrees/${run.worktree.id}`}
                              title={run.worktree.folder}
                            >
                              <span className="block truncate">
                                {run.repositoryName}
                              </span>
                              <span className="block truncate font-mono text-xs text-muted-foreground">
                                {run.branch ?? "—"}
                              </span>
                            </Link>
                          ) : (
                            <div className="min-w-0">
                              <p
                                className="truncate"
                                title={run.repositoryName}
                              >
                                {run.repositoryName}
                              </p>
                              <p
                                className="truncate font-mono text-xs text-muted-foreground"
                                title={run.branch ?? undefined}
                              >
                                {run.branch ?? "—"}
                              </p>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {run.jiraIssueKey ? (
                            <button
                              className={cn(
                                rowLinkClass,
                                "max-w-full truncate",
                              )}
                              onClick={() =>
                                setDrawerIssueKey(run.jiraIssueKey)
                              }
                              type="button"
                            >
                              {run.jiraIssueKey}
                            </button>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        {session && (
                          <TableCell>
                            {run.sourcePlan ? (
                              <Link
                                className={cn(
                                  rowLinkClass,
                                  "inline-block font-mono",
                                )}
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
                        {/* Cells are `whitespace-nowrap` by default, which no
                            amount of clamping can wrap. */}
                        <TableCell className="whitespace-normal">
                          <Link
                            className={cn(rowLinkClass, "line-clamp-2")}
                            href={`${detailBase}/${run.id}`}
                            title={run.initialPrompt}
                          >
                            {run.initialPrompt}
                          </Link>
                        </TableCell>
                        <TableCell
                          className="text-right"
                          title={t("estimatedCost")}
                        >
                          {run.estimatedCost === null
                            ? "—"
                            : currency.format(run.estimatedCost)}
                        </TableCell>
                        <TableCell>
                          <div
                            className="flex items-center gap-2"
                            title={`${run.model} · ${run.effort ?? "auto"}`}
                          >
                            <ProviderIcon provider={run.provider} />
                            {/* No `flex-1`: it would stretch a short name to
                                the full column and strand the effort icon at
                                the far edge. Shrink-to-fit, truncate only when
                                the name genuinely runs out of room. */}
                            <span className="min-w-0 truncate text-xs">
                              {formatModelLabel(run.model)}
                            </span>
                            <EffortIcon effort={run.effort} />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            <DateTime kind="relative" value={run.createdAt} />
                          </div>
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
        <div className="flex flex-col items-center justify-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t("showingCount", { count: items.length, total: totalCount })}
          </span>
          {nextCursor && (
            <div
              className="flex min-h-10 items-center justify-center gap-2 text-sm text-muted-foreground"
              ref={loadMoreTriggerRef}
              role="status"
            >
              {loadingMore && (
                <>
                  <Spinner /> {t("loadingMore")}
                </>
              )}
            </div>
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
      <JiraTicketDrawer
        issueKey={drawerIssueKey}
        onClose={() => setDrawerIssueKey(null)}
      />
    </div>
  );
}
