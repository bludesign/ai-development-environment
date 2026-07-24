"use client";

import { RefreshCw, RotateCcw, Save, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { DateTime } from "@/components/common/date-time";
import { SortableTableHead } from "@/components/common/sortable-table-head";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  MODEL_COST_CATALOG_FIELDS,
  MODEL_COST_ENTRY_FIELDS,
  perMillion,
  type ModelCostCatalogView,
  type ModelCostEntryView,
  type ModelCostSortDirection,
  type ModelCostSortKey,
} from "./types";

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 250;

type Sort = { key: ModelCostSortKey; direction: ModelCostSortDirection };

/**
 * Prices run from single-digit cents to hundreds of dollars per million tokens,
 * so a fixed precision either loses the cheap models or pads the dear ones.
 */
function priceLabel(value: number | null, locale: string): string {
  if (value === null) return "—";
  const perMTok = perMillion(value);
  if (perMTok === 0) return "$0";
  return `$${perMTok.toLocaleString(locale, {
    maximumFractionDigits: perMTok < 1 ? 4 : 2,
    minimumFractionDigits: 2,
  })}`;
}

export function CostsPage() {
  const t = useTranslations("costs");
  const locale = useLocale();
  const [catalog, setCatalog] = useState<ModelCostCatalogView | null>(null);
  const [entries, setEntries] = useState<ModelCostEntryView[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "MODEL", direction: "ASC" });
  const [urlDraft, setUrlDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<"save" | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

  const applyCatalog = useCallback((value: ModelCostCatalogView) => {
    setCatalog(value);
    setUrlDraft(value.customUrl ?? "");
  }, []);

  const load = useCallback(
    async (term: string, order: Sort) => {
      try {
        const data = await controlPlaneRequest<{
          modelCostCatalog: ModelCostCatalogView;
          modelCostEntries: {
            items: ModelCostEntryView[];
            totalCount: number;
          };
        }>(
          `query CostsPage($search: String, $first: Int!, $sortKey: ModelCostSortKey!, $direction: ModelCostSortDirection!) {
            modelCostCatalog { ${MODEL_COST_CATALOG_FIELDS} }
            modelCostEntries(search: $search, first: $first, sortKey: $sortKey, direction: $direction) {
              items { ${MODEL_COST_ENTRY_FIELDS} }
              totalCount
            }
          }`,
          {
            search: term || null,
            first: PAGE_SIZE,
            sortKey: order.key,
            direction: order.direction,
          },
        );
        applyCatalog(data.modelCostCatalog);
        setEntries(data.modelCostEntries.items);
        setTotalCount(data.modelCostEntries.totalCount);
        setError(null);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        setLoading(false);
      }
    },
    [applyCatalog],
  );

  /**
   * The query itself is what waits out the typing, so there is no second copy
   * of the term to keep in step with the box. Re-sorting goes through the same
   * path — the order is the server's to decide across every page — but a click
   * is a finished intent rather than a half-typed one, so only a changed search
   * term is worth coalescing. The first load is immediate for the same reason.
   */
  const loadedSearch = useRef(search);
  useEffect(() => {
    const typing = loadedSearch.current !== search;
    loadedSearch.current = search;
    const timer = window.setTimeout(
      () => void load(search, sort),
      typing ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => window.clearTimeout(timer);
  }, [load, search, sort]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const data = await controlPlaneRequest<{
        modelCostEntries: { items: ModelCostEntryView[]; totalCount: number };
      }>(
        `query MoreModelCosts($search: String, $first: Int!, $offset: Int!, $sortKey: ModelCostSortKey!, $direction: ModelCostSortDirection!) {
          modelCostEntries(search: $search, first: $first, offset: $offset, sortKey: $sortKey, direction: $direction) {
            items { ${MODEL_COST_ENTRY_FIELDS} }
            totalCount
          }
        }`,
        {
          search: search || null,
          first: PAGE_SIZE,
          offset: entries.length,
          sortKey: sort.key,
          direction: sort.direction,
        },
      );
      /*
       * The offset is taken from what is already on screen, so a page that
       * arrives after a re-sort can overlap the one before it. Keying by model
       * — which the catalog makes unique — drops the duplicates rather than
       * rendering a row twice.
       */
      setEntries((current) => {
        const seen = new Set(current.map(({ model }) => model));
        return [
          ...current,
          ...data.modelCostEntries.items.filter(
            ({ model }) => !seen.has(model),
          ),
        ];
      });
      setTotalCount(data.modelCostEntries.totalCount);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoadingMore(false);
    }
  }, [entries.length, search, sort]);

  /**
   * Hidden rows load as the reader approaches them rather than on a click. The
   * margin starts the fetch before the sentinel is actually visible, so the
   * table usually grows without the reader meeting its end.
   */
  useEffect(() => {
    if (loading || loadingMore || error) return;
    if (entries.length >= totalCount) return;
    const trigger = loadMoreTriggerRef.current;
    if (!trigger) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (!records.some((record) => record.isIntersecting)) return;
        void loadMore();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [entries.length, error, loadMore, loading, loadingMore, totalCount]);

  const selectSort = (key: ModelCostSortKey) =>
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "ASC" ? "DESC" : "ASC",
          }
        : /*
           * A name reads naturally A→Z, while someone sorting by a price or a
           * context window is looking for the extreme, so those open descending.
           */
          {
            key,
            direction: key === "MODEL" || key === "PROVIDER" ? "ASC" : "DESC",
          },
    );

  const saveUrl = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    try {
      const data = await controlPlaneRequest<{
        saveModelCostSettings: ModelCostCatalogView;
      }>(
        `mutation SaveModelCostSettings($catalogUrl: String) {
          saveModelCostSettings(catalogUrl: $catalogUrl) { ${MODEL_COST_CATALOG_FIELDS} }
        }`,
        { catalogUrl: urlDraft.trim() || null },
      );
      applyCatalog(data.saveModelCostSettings);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      await controlPlaneRequest(
        `mutation RefreshModelCosts {
          refreshModelCosts { ${MODEL_COST_CATALOG_FIELDS} }
        }`,
      );
      await load(search, sort);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(null);
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
        <Button disabled={busy !== null} onClick={() => void refresh()}>
          {busy === "refresh" ? <Spinner /> : <RefreshCw />} {t("fetchLatest")}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {catalog?.error && (
        <Alert variant="destructive">
          <AlertDescription>
            {t("lastFetchFailed", { error: catalog.error })}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("sourceTitle")}</CardTitle>
          <CardDescription>{t("sourceDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => void saveUrl(event)}
          >
            <Label className="sr-only" htmlFor="model-cost-url">
              {t("catalogUrl")}
            </Label>
            <Input
              className="min-w-0 flex-1 font-mono text-xs"
              id="model-cost-url"
              onChange={(event) => setUrlDraft(event.target.value)}
              placeholder={catalog?.defaultUrl ?? ""}
              type="url"
              value={urlDraft}
            />
            <Button disabled={busy !== null} type="submit" variant="outline">
              {busy === "save" ? <Spinner /> : <Save />} {t("save")}
            </Button>
            {/*
             * Clearing the field is what restores the default, so the reset is
             * a shortcut to that rather than a second way to set a value.
             */}
            <Button
              disabled={busy !== null || !urlDraft}
              onClick={() => setUrlDraft("")}
              type="button"
              variant="ghost"
            >
              <RotateCcw /> {t("useDefault")}
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              {t("lastFetched")}
              {catalog?.fetchedAt ? (
                <DateTime value={catalog.fetchedAt} />
              ) : (
                t("never")
              )}
            </span>
            <span>{t("modelCount", { count: catalog?.entryCount ?? 0 })}</span>
            {catalog?.customUrl ? (
              <Badge variant="outline">{t("customSource")}</Badge>
            ) : (
              <Badge variant="outline">{t("defaultSource")}</Badge>
            )}
            {catalog?.stale && (
              <Badge variant="outline">{t("staleCatalog")}</Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{t("modelsTitle")}</CardTitle>
              <CardDescription>{t("modelsDescription")}</CardDescription>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label={t("searchModels")}
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchModels")}
                type="search"
                value={search}
              />
            </div>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {(
                  [
                    ["MODEL", t("model"), "left", "pl-3"],
                    ["PROVIDER", t("provider"), "left", undefined],
                    ["INPUT_COST", t("inputPrice"), "right", undefined],
                    ["OUTPUT_COST", t("outputPrice"), "right", undefined],
                    [
                      "CACHE_READ_COST",
                      t("cacheReadPrice"),
                      "right",
                      undefined,
                    ],
                    [
                      "CACHE_WRITE_COST",
                      t("cacheWritePrice"),
                      "right",
                      undefined,
                    ],
                    ["CONTEXT_WINDOW", t("contextWindow"), "right", "pr-3"],
                  ] as const
                ).map(([key, label, align, className]) => (
                  <SortableTableHead
                    active={sort.key === key}
                    align={align}
                    ariaLabel={t("sortBy", { column: label })}
                    className={className}
                    direction={sort.direction === "ASC" ? "asc" : "desc"}
                    key={key}
                    label={label}
                    onSort={() => selectSort(key)}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.model}>
                  <TableCell className="pl-4 font-mono text-xs">
                    {entry.model}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {entry.provider ?? "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {priceLabel(entry.inputCostPerToken, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {priceLabel(entry.outputCostPerToken, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {priceLabel(entry.cacheReadCostPerToken, locale)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {priceLabel(entry.cacheWriteCostPerToken, locale)}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {entry.maxInputTokens === null
                      ? "—"
                      : entry.maxInputTokens.toLocaleString(locale)}
                  </TableCell>
                </TableRow>
              ))}
              {!entries.length && (
                <TableRow>
                  <TableCell
                    className="h-24 text-center text-muted-foreground"
                    colSpan={7}
                  >
                    {loading ? <Spinner /> : t("noModels")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {entries.length > 0 && (
          <div className="flex flex-col items-center gap-2 border-t p-3 text-sm text-muted-foreground">
            <span>
              {t("showingCount", { shown: entries.length, total: totalCount })}
            </span>
            {/*
             * The sentinel is what the observer watches, so it only exists
             * while there is more to fetch — once the table is complete there
             * is nothing left to trip.
             */}
            {entries.length < totalCount && (
              <div
                className="flex min-h-6 items-center gap-2"
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
      </Card>
    </section>
  );
}
