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
  FilePenLine,
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
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { dayKey, formatDateValue } from "@/lib/date-format";
import { formatProviderLabel } from "@/lib/enum-label";
import { isRowActivation, rowLinkClass } from "@/lib/row-activation";
import { cn } from "@/lib/utils";
import { worktreeHighlightBackgroundClasses } from "@/lib/worktree-highlight";

import { RUN_DRAFT_FIELDS } from "./graphql-fields";
import type { RunDraftView } from "./types";

export function DraftsPage() {
  const t = useTranslations("runs");
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<RunDraftView[]>([]);
  const [search, setSearch] = useState("");
  const [archiveFilter, setArchiveFilter] = useState("ACTIVE");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editMode, setEditMode] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        runDrafts: {
          items: RunDraftView[];
          nextCursor: string | null;
          totalCount: number;
        };
      }>(
        `query RunDrafts($search: String, $archive: String!) { runDrafts(search: $search, archive: $archive, first: 100) { items { ${RUN_DRAFT_FIELDS} } nextCursor totalCount } }`,
        { search: search.trim() || null, archive: archiveFilter },
      );
      setItems(data.runDrafts.items);
      setNextCursor(data.runDrafts.nextCursor);
      setTotalCount(data.runDrafts.totalCount);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [archiveFilter, search]);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 150);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await controlPlaneRequest<{
        runDrafts: {
          items: RunDraftView[];
          nextCursor: string | null;
          totalCount: number;
        };
      }>(
        `query MoreRunDrafts($search: String, $archive: String!, $after: ID!) { runDrafts(search: $search, archive: $archive, first: 100, after: $after) { items { ${RUN_DRAFT_FIELDS} } nextCursor totalCount } }`,
        {
          search: search.trim() || null,
          archive: archiveFilter,
          after: nextCursor,
        },
      );
      setItems((current) => [
        ...current,
        ...data.runDrafts.items.filter(
          (item) => !current.some(({ id }) => id === item.id),
        ),
      ]);
      setNextCursor(data.runDrafts.nextCursor);
      setTotalCount(data.runDrafts.totalCount);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  }, [archiveFilter, nextCursor, search]);

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

  const groups = useMemo(() => {
    const result: Array<{ key: string; value: string; items: RunDraftView[] }> =
      [];
    for (const item of items) {
      const key = dayKey(item.updatedAt) ?? item.updatedAt;
      const group = result.at(-1);
      if (group?.key === key) group.items.push(item);
      else result.push({ key, value: item.updatedAt, items: [item] });
    }
    return result;
  }, [items]);

  const toggleSelected = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const mutate = async (query: string, variables: Record<string, unknown>) => {
    try {
      await controlPlaneRequest(query, variables);
      setSelected(new Set());
      await refresh();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  const archive = (ids: string[], archived: boolean) =>
    mutate(
      "mutation ArchiveDrafts($ids: [ID!]!, $archived: Boolean!) { archiveRunDrafts(ids: $ids, archived: $archived) }",
      { ids, archived },
    );
  const remove = (ids: string[]) =>
    mutate(
      "mutation DeleteDrafts($ids: [ID!]!) { deleteRunDrafts(ids: $ids) }",
      { ids },
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>{t("drafts")}</CardTitle>
            <div className="flex gap-2">
              <Button
                onClick={() => setEditMode((value) => !value)}
                variant="outline"
              >
                <FilePenLine /> {editMode ? t("done") : t("edit")}
              </Button>
              <Button asChild>
                <Link href="/runs/new">
                  <Plus /> {t("newDraft")}
                </Link>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full md:mr-auto md:w-auto md:min-w-56 md:flex-1">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label={t("searchDrafts")}
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchDrafts")}
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
          </div>
          {editMode && selected.size > 0 && (
            <div className="flex gap-2 rounded-lg border p-3">
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
        <p className="flex gap-2 text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : !items.length ? (
        <p className="rounded-lg border p-12 text-center text-muted-foreground">
          {t("noDrafts")}
        </p>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <Table>
            <TableHeader>
              <TableRow>
                {editMode && <TableHead className="w-10" />}
                <TableHead>{t("mode")}</TableHead>
                <TableHead>{t("worktree")}</TableHead>
                <TableHead>{t("ticket")}</TableHead>
                <TableHead>{t("prompt")}</TableHead>
                <TableHead>{t("tool")}</TableHead>
                <TableHead>{t("attachments")}</TableHead>
                <TableHead>{t("age")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-muted/20 hover:bg-muted/20">
                    <TableCell
                      className="py-1.5 text-xs font-normal text-muted-foreground"
                      colSpan={editMode ? 9 : 8}
                    >
                      {formatDateValue(group.value, "long", {
                        locale,
                        showTime: false,
                      })}
                    </TableCell>
                  </TableRow>
                  {group.items.map((draft) => (
                    <TableRow
                      className={cn(
                        "cursor-pointer",
                        draft.worktree?.highlightColor &&
                          worktreeHighlightBackgroundClasses[
                            draft.worktree.highlightColor
                          ],
                      )}
                      key={draft.id}
                      /* In edit mode the row is a selection target, so it
                         toggles rather than navigating away mid-selection. */
                      onClick={(event) => {
                        if (!isRowActivation(event)) return;
                        if (editMode) toggleSelected(draft.id);
                        else router.push(`/runs/new?draft=${draft.id}`);
                      }}
                    >
                      {editMode && (
                        <TableCell>
                          <Checkbox
                            aria-label={t("selectDraft")}
                            checked={selected.has(draft.id)}
                            onCheckedChange={(checked) =>
                              setSelected((current) => {
                                const next = new Set(current);
                                if (checked) next.add(draft.id);
                                else next.delete(draft.id);
                                return next;
                              })
                            }
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge>
                          {draft.kind === "PLAN" ? t("plan") : t("session")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {draft.worktree ? (
                          <Link
                            className={cn(rowLinkClass, "block min-w-0")}
                            href={`/worktrees/${draft.worktree.id}`}
                            title={draft.worktree.folder}
                          >
                            <span className="block truncate">
                              {draft.worktree.branch ?? "—"}
                            </span>
                            <span className="block max-w-56 truncate font-mono text-xs text-muted-foreground">
                              {draft.worktree.folder}
                            </span>
                          </Link>
                        ) : (
                          <p>—</p>
                        )}
                      </TableCell>
                      <TableCell>{draft.jiraIssueKey ?? "—"}</TableCell>
                      <TableCell>
                        <Link
                          className={cn(
                            rowLinkClass,
                            "block max-w-96 truncate",
                          )}
                          href={`/runs/new?draft=${draft.id}`}
                          title={draft.prompt}
                        >
                          {draft.prompt}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {formatProviderLabel(draft.provider)} · {draft.model}
                      </TableCell>
                      <TableCell>{draft.attachments.length}</TableCell>
                      <TableCell>
                        <DateTime kind="relative" value={draft.updatedAt} />
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            aria-label={
                              draft.archivedAt ? t("restore") : t("archive")
                            }
                            onClick={() =>
                              void archive([draft.id], !draft.archivedAt)
                            }
                            size="icon-sm"
                            variant="ghost"
                          >
                            {draft.archivedAt ? <Undo2 /> : <Archive />}
                          </Button>
                          <Button
                            aria-label={t("delete")}
                            onClick={() => setDeleteIds([draft.id])}
                            size="icon-sm"
                            variant="destructive"
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
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
        description={t("deleteDraftDescription")}
        onConfirm={() => void remove(deleteIds)}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        open={deleteIds.length > 0}
        title={t("deleteDraftTitle")}
      />
    </div>
  );
}
