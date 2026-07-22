"use client";

import {
  Check,
  DatabaseZap,
  Eye,
  Pencil,
  RefreshCw,
  Search,
  SearchCheck,
  Settings2,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { DateTime } from "@/components/ui/date-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import {
  CACHE_ENTRY_FIELDS,
  STORAGE_LOCATION_FIELDS,
  type CacheEntryDetailView,
  type CacheEntryMatchView,
  type CacheEntryPageView,
} from "@/services/cache-server/types";

const ITEMS_PER_PAGE_OPTIONS = [10, 20, 50, 100];

type Filters = {
  key: string;
  version: string;
  scope: string;
  repoId: string;
};

const EMPTY_FILTERS: Filters = { key: "", version: "", scope: "", repoId: "" };

function hasActiveFilters(filters: Filters): boolean {
  return Boolean(
    filters.key.trim() ||
    filters.version.trim() ||
    filters.scope.trim() ||
    filters.repoId.trim(),
  );
}

function toFilterInput(filters: Filters) {
  return {
    key: filters.key.trim() || null,
    version: filters.version.trim() || null,
    scope: filters.scope.trim() || null,
    repoId: filters.repoId.trim() || null,
  };
}

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1,
  );
  const size = value / Math.pow(1024, exponent);
  return `${size.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function CacheServerPage() {
  const t = useTranslations("cacheServer");
  const tc = useTranslations("common");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<CacheEntryPageView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [matchOpen, setMatchOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const loadGeneration = useRef(0);

  const load = useCallback(
    async (requestedPage = page) => {
      const generation = ++loadGeneration.current;
      setLoading(true);
      try {
        const config = await controlPlaneRequest<{
          cacheServerSettings: { configured: boolean };
        }>(
          "query CacheServerConfigured { cacheServerSettings { configured } }",
        );
        if (generation !== loadGeneration.current) return;
        if (!config.cacheServerSettings.configured) {
          setConfigured(false);
          setData(null);
          setError(null);
          return;
        }
        setConfigured(true);
        const result = await controlPlaneRequest<{
          cacheEntries: CacheEntryPageView;
        }>(
          `query CacheServerEntries(
          $key: String
          $version: String
          $scope: String
          $repoId: String
          $itemsPerPage: Int!
          $page: Int!
        ) {
          cacheEntries(
            key: $key
            version: $version
            scope: $scope
            repoId: $repoId
            itemsPerPage: $itemsPerPage
            page: $page
          ) {
            total
            items { ${CACHE_ENTRY_FIELDS} }
          }
        }`,
          {
            ...toFilterInput(appliedFilters),
            itemsPerPage,
            page: requestedPage,
          },
        );
        if (generation !== loadGeneration.current) return;
        const lastPage = Math.max(
          1,
          Math.ceil(result.cacheEntries.total / itemsPerPage),
        );
        if (result.cacheEntries.total > 0 && requestedPage > lastPage) {
          setData(null);
          setPage(lastPage);
          setSelected(new Set());
          return;
        }
        setData(result.cacheEntries);
        setError(null);
      } catch (value) {
        if (generation === loadGeneration.current) {
          setError(value instanceof Error ? value.message : String(value));
        }
      } finally {
        if (generation === loadGeneration.current) setLoading(false);
      }
    },
    [appliedFilters, itemsPerPage, page],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  // Selection only ever refers to the rows currently on screen, so anything that
  // swaps out those rows also clears it.
  const clearSelection = () => setSelected(new Set());

  const goToPage = (next: number) => {
    setPage(next);
    clearSelection();
  };

  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    goToPage(1);
    setAppliedFilters({ ...filters });
  };

  const resetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    goToPage(1);
  };

  const deleteEntry = async (id: string) => {
    setBusyKey(id);
    try {
      await controlPlaneRequest(
        "mutation DeleteCacheEntry($id: ID!) { deleteCacheEntry(id: $id) }",
        { id },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusyKey("selection");
    try {
      await controlPlaneRequest(
        "mutation DeleteCacheEntriesByIds($ids: [ID!]!) { deleteCacheEntriesByIds(ids: $ids) }",
        { ids },
      );
      setSelected(new Set());
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const deleteMatching = async () => {
    setBusyKey("bulk");
    try {
      await controlPlaneRequest(
        `mutation DeleteCacheEntries(
          $key: String
          $version: String
          $scope: String
          $repoId: String
        ) {
          deleteCacheEntries(
            key: $key
            version: $version
            scope: $scope
            repoId: $repoId
          )
        }`,
        toFilterInput(appliedFilters),
      );
      goToPage(1);
      await load(1);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyKey(null);
    }
  };

  const total = data?.total ?? 0;
  const items = data?.items ?? [];
  const start = total === 0 ? 0 : (page - 1) * itemsPerPage + 1;
  const end = Math.min(page * itemsPerPage, total);
  const bulkEnabled = hasActiveFilters(appliedFilters);
  const selectedItems = items.filter((entry) => selected.has(entry.id));
  const allSelected = items.length > 0 && selectedItems.length === items.length;
  const someSelected = selectedItems.length > 0 && !allSelected;

  const stopEditing = () => {
    setEditing(false);
    clearSelection();
  };

  if (configured === null) {
    return (
      <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {t("loading")}
          </div>
        )}
      </section>
    );
  }

  if (configured === false) {
    return (
      <section className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <DatabaseZap />
            </EmptyMedia>
            <EmptyTitle>{t("notConfiguredTitle")}</EmptyTitle>
            <EmptyDescription>{t("notConfiguredDescription")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild>
            <Link href="/settings">
              <Settings2 />
              {t("goToSettings")}
            </Link>
          </Button>
        </Empty>
      </section>
    );
  }

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
          <Button
            onClick={() => setMatchOpen(true)}
            type="button"
            variant="outline"
          >
            <SearchCheck />
            {t("matchLookup")}
          </Button>
          <Button
            disabled={loading}
            onClick={() => void load()}
            type="button"
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {t("refresh")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>{t("filtersTitle")}</CardTitle>
          <CardDescription>{t("filtersDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="py-4">
          <form className="space-y-4" onSubmit={applyFilters}>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="cache-filter-key">{t("key")}</Label>
                <Input
                  id="cache-filter-key"
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      key: event.target.value,
                    }))
                  }
                  placeholder={t("keyPlaceholder")}
                  value={filters.key}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cache-filter-version">{t("version")}</Label>
                <Input
                  id="cache-filter-version"
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      version: event.target.value,
                    }))
                  }
                  placeholder={t("versionPlaceholder")}
                  value={filters.version}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cache-filter-scope">{t("scope")}</Label>
                <Input
                  id="cache-filter-scope"
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      scope: event.target.value,
                    }))
                  }
                  placeholder={t("scopePlaceholder")}
                  value={filters.scope}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cache-filter-repo-id">{t("repoId")}</Label>
                <Input
                  id="cache-filter-repo-id"
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      repoId: event.target.value,
                    }))
                  }
                  placeholder={t("repoIdPlaceholder")}
                  value={filters.repoId}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Label
                  className="text-sm text-muted-foreground"
                  htmlFor="cache-items-per-page"
                >
                  {t("itemsPerPage")}
                </Label>
                <Select
                  onValueChange={(value) => {
                    setItemsPerPage(Number(value));
                    goToPage(1);
                  }}
                  value={String(itemsPerPage)}
                >
                  <SelectTrigger className="w-24" id="cache-items-per-page">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ITEMS_PER_PAGE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <ConfirmationDialog
                  actionLabel={t("deleteMatching")}
                  cancelLabel={tc("cancel")}
                  description={t("confirmDeleteMatchingDescription")}
                  onConfirm={deleteMatching}
                  title={t("confirmDeleteMatching")}
                  trigger={
                    <Button
                      disabled={!bulkEnabled || busyKey === "bulk"}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2 />
                      {t("deleteMatching")}
                    </Button>
                  }
                />
                <Button onClick={resetFilters} type="button" variant="ghost">
                  {t("reset")}
                </Button>
                <Button type="submit">
                  <Search />
                  {t("applyFilters")}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>{t("entriesTitle")}</CardTitle>
          <CardDescription>{t("entriesDescription")}</CardDescription>
          {items.length > 0 && (
            <CardAction>
              <Button
                onClick={() => (editing ? stopEditing() : setEditing(true))}
                size="sm"
                variant={editing ? "secondary" : "outline"}
              >
                {editing ? <Check /> : <Pencil />}
                {editing ? t("doneEditing") : t("edit")}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        {editing && items.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-b p-3">
            <p className="text-sm">
              {t("selected", { count: selectedItems.length })}
            </p>
            <ConfirmationDialog
              actionLabel={t("deleteSelected")}
              cancelLabel={tc("cancel")}
              description={tc("cannotBeUndone")}
              onConfirm={deleteSelected}
              title={t("confirmDeleteSelected", {
                count: selectedItems.length,
              })}
              trigger={
                <Button
                  disabled={
                    selectedItems.length === 0 || busyKey === "selection"
                  }
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  <Trash2 />
                  {t("deleteSelected")}
                </Button>
              }
            />
          </div>
        )}
        {loading && !data ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Spinner />
            {t("loading")}
          </div>
        ) : items.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyDescription>{t("noEntries")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  {editing && (
                    <TableHead className="w-12">
                      <Checkbox
                        aria-label={t("selectAll")}
                        checked={
                          allSelected
                            ? true
                            : someSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(checked) =>
                          setSelected(
                            checked === true
                              ? new Set(items.map((entry) => entry.id))
                              : new Set(),
                          )
                        }
                      />
                    </TableHead>
                  )}
                  <TableHead>{t("key")}</TableHead>
                  <TableHead>{t("scope")}</TableHead>
                  <TableHead>{t("version")}</TableHead>
                  <TableHead>{t("repoId")}</TableHead>
                  <TableHead>{t("updatedAt")}</TableHead>
                  <TableHead className="text-right">{t("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((entry) => (
                  <TableRow key={entry.id}>
                    {editing && (
                      <TableCell>
                        <Checkbox
                          aria-label={t("selectEntry", { name: entry.key })}
                          checked={selected.has(entry.id)}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(entry.id);
                              else next.delete(entry.id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                    )}
                    <TableCell className="max-w-xs truncate font-medium">
                      {entry.key}
                    </TableCell>
                    <TableCell>{entry.scope}</TableCell>
                    <TableCell className="max-w-32 truncate font-mono text-xs">
                      {entry.version}
                    </TableCell>
                    <TableCell>{entry.repoId}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <DateTime value={entry.updatedAt} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          aria-label={t("viewDetails")}
                          onClick={() => setDetailId(entry.id)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <Eye />
                        </Button>
                        <ConfirmationDialog
                          actionLabel={t("delete")}
                          cancelLabel={tc("cancel")}
                          description={tc("cannotBeUndone")}
                          onConfirm={() => deleteEntry(entry.id)}
                          title={t("confirmDeleteEntry")}
                          trigger={
                            <Button
                              aria-label={t("delete")}
                              disabled={busyKey === entry.id}
                              size="icon-sm"
                              variant="ghost"
                            >
                              <Trash2 />
                            </Button>
                          }
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex items-center justify-between border-t p-3 text-sm">
              <span className="text-muted-foreground">
                {t("showing", { start, end, total })}
              </span>
              <div className="flex gap-2">
                <Button
                  disabled={page <= 1}
                  onClick={() => goToPage(Math.max(1, page - 1))}
                  size="sm"
                  variant="outline"
                >
                  {t("previous")}
                </Button>
                <Button
                  disabled={end >= total}
                  onClick={() => goToPage(page + 1)}
                  size="sm"
                  variant="outline"
                >
                  {t("next")}
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      <CacheEntryDetailDialog
        entryId={detailId}
        onClose={() => setDetailId(null)}
        onDeleted={() => {
          setDetailId(null);
          void load();
        }}
      />
      <MatchLookupDialog onOpenChange={setMatchOpen} open={matchOpen} />
    </section>
  );
}

function CacheEntryDetailDialog({
  entryId,
  onClose,
  onDeleted,
}: {
  entryId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("cacheServer");
  const tc = useTranslations("common");
  const [detail, setDetail] = useState<CacheEntryDetailView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setDetail(null);
      setError(null);
      void controlPlaneRequest<{
        cacheEntryDetail: CacheEntryDetailView | null;
      }>(
        `query CacheEntryDetail($id: ID!) {
          cacheEntryDetail(id: $id) {
            entry { ${CACHE_ENTRY_FIELDS} }
            location { ${STORAGE_LOCATION_FIELDS} }
          }
        }`,
        { id: entryId },
      )
        .then((result) => {
          if (!cancelled) setDetail(result.cacheEntryDetail);
        })
        .catch((value) => {
          if (!cancelled) {
            setError(value instanceof Error ? value.message : String(value));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [entryId]);

  const deleteLocation = async (id: string) => {
    setBusy(true);
    try {
      await controlPlaneRequest(
        "mutation DeleteCacheStorageLocation($id: ID!) { deleteCacheStorageLocation(id: $id) }",
        { id },
      );
      onDeleted();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={entryId !== null}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("detailTitle")}</DialogTitle>
          <DialogDescription>{t("detailDescription")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner />
            {t("loading")}
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : !detail ? (
          <p className="py-6 text-sm text-muted-foreground">
            {t("entryNotFound")}
          </p>
        ) : (
          <div className="space-y-6">
            <div>
              <h3 className="mb-2 text-sm font-semibold">
                {t("entrySection")}
              </h3>
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                <DetailRow label={t("id")} value={detail.entry.id} mono />
                <DetailRow label={t("key")} value={detail.entry.key} />
                <DetailRow
                  label={t("version")}
                  value={detail.entry.version}
                  mono
                />
                <DetailRow label={t("scope")} value={detail.entry.scope} />
                <DetailRow label={t("repoId")} value={detail.entry.repoId} />
                <DetailRow
                  label={t("updatedAt")}
                  value={<DateTime value={detail.entry.updatedAt} />}
                />
                <DetailRow
                  label={t("locationId")}
                  value={detail.entry.locationId}
                  mono
                />
              </dl>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  {t("locationSection")}
                </h3>
                {detail.location && (
                  <ConfirmationDialog
                    actionLabel={t("deleteLocation")}
                    cancelLabel={tc("cancel")}
                    description={t("confirmDeleteLocationDescription")}
                    onConfirm={() => deleteLocation(detail.location!.id)}
                    title={t("confirmDeleteLocation")}
                    trigger={
                      <Button disabled={busy} size="sm" variant="destructive">
                        <Trash2 />
                        {t("deleteLocation")}
                      </Button>
                    }
                  />
                )}
              </div>
              {detail.location ? (
                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                  <DetailRow
                    label={t("folderName")}
                    value={detail.location.folderName}
                    mono
                  />
                  <DetailRow
                    label={t("partCount")}
                    value={String(detail.location.partCount)}
                  />
                  <DetailRow
                    label={t("sizeBytes")}
                    value={formatBytes(detail.location.sizeBytes)}
                  />
                  <DetailRow
                    label={t("mergeStartedAt")}
                    value={<DateTime value={detail.location.mergeStartedAt} />}
                  />
                  <DetailRow
                    label={t("mergedAt")}
                    value={<DateTime value={detail.location.mergedAt} />}
                  />
                  <DetailRow
                    label={t("partsDeletedAt")}
                    value={<DateTime value={detail.location.partsDeletedAt} />}
                  />
                  <DetailRow
                    label={t("lastDownloadedAt")}
                    value={
                      <DateTime value={detail.location.lastDownloadedAt} />
                    }
                  />
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("noLocation")}
                </p>
              )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            {t("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MatchLookupDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const t = useTranslations("cacheServer");
  const [primaryKey, setPrimaryKey] = useState("");
  const [restoreKeys, setRestoreKeys] = useState("");
  const [scopes, setScopes] = useState("");
  const [repoId, setRepoId] = useState("");
  const [version, setVersion] = useState("");
  const [result, setResult] = useState<CacheEntryMatchView | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSearched(false);
    try {
      const data = await controlPlaneRequest<{
        cacheEntryMatch: CacheEntryMatchView | null;
      }>(
        `query CacheEntryMatch(
          $primaryKey: String!
          $restoreKeys: [String!]
          $scopes: [String!]!
          $repoId: String!
          $version: String!
        ) {
          cacheEntryMatch(
            primaryKey: $primaryKey
            restoreKeys: $restoreKeys
            scopes: $scopes
            repoId: $repoId
            version: $version
          ) {
            match { ${CACHE_ENTRY_FIELDS} }
            type
          }
        }`,
        {
          primaryKey: primaryKey.trim(),
          restoreKeys: restoreKeys
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          scopes: scopes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          repoId: repoId.trim(),
          version: version.trim(),
        },
      );
      setResult(data.cacheEntryMatch);
      setSearched(true);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("matchTitle")}</DialogTitle>
          <DialogDescription>{t("matchDescription")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="match-primary-key">{t("primaryKey")}</Label>
            <Input
              id="match-primary-key"
              onChange={(event) => setPrimaryKey(event.target.value)}
              required
              value={primaryKey}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="match-restore-keys">{t("restoreKeys")}</Label>
            <Input
              id="match-restore-keys"
              onChange={(event) => setRestoreKeys(event.target.value)}
              placeholder={t("commaSeparated")}
              value={restoreKeys}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="match-scopes">{t("scopes")}</Label>
              <Input
                id="match-scopes"
                onChange={(event) => setScopes(event.target.value)}
                placeholder={t("commaSeparated")}
                required
                value={scopes}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="match-repo-id">{t("repoId")}</Label>
              <Input
                id="match-repo-id"
                onChange={(event) => setRepoId(event.target.value)}
                required
                value={repoId}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="match-version">{t("version")}</Label>
            <Input
              id="match-version"
              onChange={(event) => setVersion(event.target.value)}
              required
              value={version}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {searched &&
            (result ? (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">
                    {t("matchFound")}
                  </span>
                  <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                    {t(`matchTypes.${result.type}`)}
                  </Badge>
                </div>
                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                  <DetailRow label={t("key")} value={result.match.key} />
                  <DetailRow
                    label={t("version")}
                    value={result.match.version}
                    mono
                  />
                  <DetailRow label={t("scope")} value={result.match.scope} />
                  <DetailRow label={t("repoId")} value={result.match.repoId} />
                  <DetailRow
                    label={t("updatedAt")}
                    value={<DateTime value={result.match.updatedAt} />}
                  />
                </dl>
              </div>
            ) : (
              <Alert>
                <AlertDescription>{t("noMatch")}</AlertDescription>
              </Alert>
            ))}
          <DialogFooter>
            <Button disabled={busy} type="submit">
              {busy ? <Spinner /> : <SearchCheck />}
              {t("runMatch")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : "break-all"}>
        {value}
      </dd>
    </>
  );
}
