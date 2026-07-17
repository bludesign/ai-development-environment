"use client";

import { Calculator, RefreshCw, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import type { Agent } from "@/components/agents/types";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
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
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";

type AgentProgress = {
  agent: Agent;
  status:
    | "QUEUING"
    | "QUEUED"
    | "RUNNING"
    | "SUCCEEDED"
    | "FAILED"
    | "CANCELLED"
    | "TIMED_OUT"
    | "OFFLINE"
    | "UNSUPPORTED"
    | "INVALID";
  jobId: string | null;
  error: string | null;
  warnings: string[];
};

type DerivedDataEntry = {
  id: string;
  name: string;
  status: "READY" | "UNLINKED" | "PENDING" | "SHARED_CACHE";
  workspacePath: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  sizeBytes: number | null;
  operation: "IDLE" | "SIZING" | "DELETING";
  error: string | null;
  agent: Agent;
};

type DerivedDataCollection = {
  id: string;
  status: "COLLECTING" | "COMPLETED";
  createdAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  progress: {
    eligibleCount: number;
    finishedCount: number;
    successfulCount: number;
    agents: AgentProgress[];
  };
  entries: DerivedDataEntry[];
};

type HistoryItem = {
  id: string;
  agentId: string | null;
  agentName: string;
  folderName: string;
  worktreeId: string | null;
  worktreePath: string | null;
  source: "USER" | "AUTOMATIC";
  deletedAt: string;
};

const COLLECTION_FIELDS = `
  id status createdAt deadlineAt finishedAt
  progress {
    eligibleCount finishedCount successfulCount
    agents { agent { ${AGENT_FIELDS} } status jobId error warnings }
  }
  entries {
    id name status workspacePath worktreeId worktreePath sizeBytes operation error
    agent { ${AGENT_FIELDS} }
  }
`;

function formatBytes(value: number, locale: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    value / 1024 ** index,
  )} ${units[index]}`;
}

function relativeAge(value: string, locale: string, now: number): string {
  const seconds = Math.round((Date.parse(value) - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}

export function BuildDataPage() {
  const t = useTranslations("buildData");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [collectionId, setCollectionId] = useState(createClientId);
  const [collection, setCollection] = useState<DerivedDataCollection | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [now, setNow] = useState<number | null>(null);

  const applyCollection = useCallback((next: DerivedDataCollection) => {
    setCollection(next);
    setLoading(false);
    setError(null);
  }, []);

  useEffect(() => {
    let disposed = false;
    const subscription = controlPlaneSubscriptions().subscribe<{
      derivedDataCollectionChanged: DerivedDataCollection;
    }>(
      {
        query: `subscription DerivedDataCollectionChanged($id: ID!) {
          derivedDataCollectionChanged(id: $id) { ${COLLECTION_FIELDS} }
        }`,
        variables: { id: collectionId },
      },
      {
        next: (value) => {
          if (value.data?.derivedDataCollectionChanged) {
            applyCollection(value.data.derivedDataCollectionChanged);
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const reconcile = async () => {
      try {
        const data = await controlPlaneRequest<{
          derivedDataCollection: DerivedDataCollection | null;
        }>(
          `query DerivedDataCollection($id: ID!) {
            derivedDataCollection(id: $id) { ${COLLECTION_FIELDS} }
          }`,
          { id: collectionId },
        );
        if (!disposed && data.derivedDataCollection) {
          applyCollection(data.derivedDataCollection);
        }
      } catch {
        // The start mutation or subscription can still deliver the collection.
      }
    };
    void controlPlaneRequest<{ refreshDerivedData: DerivedDataCollection }>(
      `mutation RefreshDerivedData($requestId: ID!) {
        refreshDerivedData(requestId: $requestId) { ${COLLECTION_FIELDS} }
      }`,
      { requestId: collectionId },
    )
      .then((data) => !disposed && applyCollection(data.refreshDerivedData))
      .catch((value) => {
        if (disposed) return;
        setError(value instanceof Error ? value.message : String(value));
        setLoading(false);
      });
    void reconcile();
    const timer = window.setInterval(() => void reconcile(), 2_000);
    return () => {
      disposed = true;
      subscription();
      window.clearInterval(timer);
    };
  }, [applyCollection, collectionId]);

  const loadHistory = useCallback(async (after?: string | null) => {
    setHistoryLoading(true);
    try {
      const data = await controlPlaneRequest<{
        derivedDataDeletionHistory: {
          items: HistoryItem[];
          nextCursor: string | null;
        };
      }>(
        `query DerivedDataDeletionHistory($after: ID) {
          derivedDataDeletionHistory(first: 100, after: $after) {
            items { id agentId agentName folderName worktreeId worktreePath source deletedAt }
            nextCursor
          }
        }`,
        { after: after ?? null },
      );
      setHistory((current) =>
        after
          ? [...current, ...data.derivedDataDeletionHistory.items]
          : data.derivedDataDeletionHistory.items,
      );
      setHistoryCursor(data.derivedDataDeletionHistory.nextCursor);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [historyVersion, loadHistory]);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const initial = window.setTimeout(update, 0);
    const timer = window.setInterval(update, 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const entries = collection?.entries ?? [];
  const activeOperation = entries.some((entry) => entry.operation !== "IDLE");
  const selectedEntries = entries.filter((entry) => selected.has(entry.id));
  const allSelected =
    entries.length > 0 && selectedEntries.length === entries.length;
  const someSelected = selectedEntries.length > 0 && !allSelected;

  const runOperation = async (
    operation: "calculateDerivedDataSizes" | "deleteDerivedDataEntries",
    entryIds: string[],
  ) => {
    if (!collection) return;
    setOperationBusy(true);
    setError(null);
    try {
      const data = await controlPlaneRequest<
        Record<string, DerivedDataCollection>
      >(
        `mutation BuildDataOperation($collectionId: ID!, $entryIds: [ID!]!, $requestId: ID!) {
          ${operation}(collectionId: $collectionId, entryIds: $entryIds, requestId: $requestId) {
            ${COLLECTION_FIELDS}
          }
        }`,
        { collectionId: collection.id, entryIds, requestId: createClientId() },
      );
      applyCollection(data[operation]);
      if (operation === "deleteDerivedDataEntries") {
        setSelected(new Set());
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setOperationBusy(false);
    }
  };

  const previousEntryCount = useMemo(() => entries.length, [entries.length]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!activeOperation && !loading) {
        setHistoryVersion((value) => value + 1);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeOperation, loading, previousEntryCount]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setCollectionId(createClientId());
  };

  const groupedHistory = useMemo(() => {
    const groups = new Map<string, { label: string; items: HistoryItem[] }>();
    const formatter = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
    for (const item of history) {
      const date = new Date(item.deletedAt);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const group = groups.get(key) ?? {
        label: formatter.format(date),
        items: [],
      };
      group.items.push(item);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [history, locale]);

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
            disabled={
              !entries.length || loading || activeOperation || operationBusy
            }
            onClick={() =>
              void runOperation(
                "calculateDerivedDataSizes",
                entries.map((entry) => entry.id),
              )
            }
            variant="outline"
          >
            <Calculator /> {t("calculateSizes")}
          </Button>
          <Button
            disabled={loading || activeOperation}
            onClick={refresh}
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

      {collection && <ProgressPanel collection={collection} />}

      {loading && !collection ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> {t("loading")}
        </p>
      ) : entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="gap-0 py-0">
          {selectedEntries.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-b p-3">
              <p className="text-sm">
                {t("selected", { count: selectedEntries.length })}
              </p>
              <Button
                disabled={activeOperation || operationBusy}
                onClick={() =>
                  setConfirmDelete(selectedEntries.map((entry) => entry.id))
                }
                size="sm"
                variant="destructive"
              >
                <Trash2 /> {t("deleteSelected")}
              </Button>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
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
                          ? new Set(entries.map((entry) => entry.id))
                          : new Set(),
                      )
                    }
                  />
                </TableHead>
                <TableHead>{t("folder")}</TableHead>
                <TableHead>{t("worktree")}</TableHead>
                <TableHead>{t("size")}</TableHead>
                <TableHead>{t("agent")}</TableHead>
                <TableHead className="text-right">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <Checkbox
                      aria-label={t("selectEntry", { name: entry.name })}
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
                  <TableCell>
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-xs">
                        {entry.name}
                      </span>
                      {entry.status !== "READY" && (
                        <Badge variant="secondary">
                          {t(`status.${entry.status}`)}
                        </Badge>
                      )}
                      {entry.operation !== "IDLE" && <Spinner />}
                    </div>
                    {entry.error && (
                      <p className="mt-1 text-xs text-destructive">
                        {entry.error}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.worktreeId && entry.worktreePath ? (
                      <Link
                        className="underline-offset-4 hover:underline"
                        href={`/worktrees/${entry.worktreeId}`}
                      >
                        {entry.worktreePath}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {entry.sizeBytes === null
                      ? "—"
                      : formatBytes(entry.sizeBytes, locale)}
                  </TableCell>
                  <TableCell>
                    <Link
                      className="underline-offset-4 hover:underline"
                      href={`/agents/${entry.agent.id}`}
                    >
                      {entry.agent.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      aria-label={t("deleteEntry", { name: entry.name })}
                      disabled={activeOperation || operationBusy}
                      onClick={() => setConfirmDelete([entry.id])}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="flex-row items-center justify-between gap-3 border-b">
          <CardTitle>{t("history")}</CardTitle>
          {history.length > 0 && (
            <ConfirmationDialog
              actionLabel={t("clearHistory")}
              cancelLabel={tc("cancel")}
              description={t("clearHistoryDescription")}
              onConfirm={async () => {
                await controlPlaneRequest(
                  `mutation { clearDerivedDataDeletionHistory }`,
                );
                setHistoryVersion((value) => value + 1);
              }}
              title={t("clearHistoryTitle")}
              trigger={
                <Button size="sm" variant="outline">
                  <Trash2 /> {t("clearHistory")}
                </Button>
              }
            />
          )}
        </CardHeader>
        <CardContent className="p-0">
          {historyLoading && history.length === 0 ? (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner /> {t("loadingHistory")}
            </p>
          ) : history.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {t("noHistory")}
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("folder")}</TableHead>
                    <TableHead>{t("worktree")}</TableHead>
                    <TableHead>{t("agent")}</TableHead>
                    <TableHead>{t("deleted")}</TableHead>
                    <TableHead>{t("sourceLabel")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedHistory.map((group) => (
                    <Fragment key={group.label}>
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell className="font-medium" colSpan={5}>
                          {group.label}
                        </TableCell>
                      </TableRow>
                      {group.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono text-xs">
                            {item.folderName}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {item.worktreePath ?? "—"}
                          </TableCell>
                          <TableCell>{item.agentName}</TableCell>
                          <TableCell
                            title={new Date(item.deletedAt).toLocaleString(
                              locale,
                            )}
                          >
                            {relativeAge(
                              item.deletedAt,
                              locale,
                              now ?? Date.parse(item.deletedAt),
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary">
                              {t(`source.${item.source}`)}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
              {historyCursor && (
                <div className="border-t p-3 text-center">
                  <Button
                    disabled={historyLoading}
                    onClick={() => void loadHistory(historyCursor)}
                    variant="outline"
                  >
                    {historyLoading && <Spinner />} {t("loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <ConfirmationDialog
        actionLabel={t("delete")}
        cancelLabel={tc("cancel")}
        description={t("deleteDescription", {
          count: confirmDelete?.length ?? 0,
        })}
        onConfirm={() => {
          const ids = confirmDelete ?? [];
          setConfirmDelete(null);
          return runOperation("deleteDerivedDataEntries", ids);
        }}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        open={confirmDelete !== null}
        title={t("deleteTitle")}
      />
    </section>
  );
}

function ProgressPanel({ collection }: { collection: DerivedDataCollection }) {
  const t = useTranslations("buildData");
  const problems = collection.progress.agents.filter(
    (item) => item.status !== "SUCCEEDED" || item.warnings.length > 0,
  );
  if (collection.status === "COMPLETED" && problems.length === 0) return null;
  return (
    <Alert>
      <AlertDescription className="space-y-1">
        <p className="flex items-center gap-2 font-medium">
          {collection.status === "COLLECTING" && <Spinner />}
          {t("progress", {
            complete: collection.progress.finishedCount,
            total: collection.progress.eligibleCount,
          })}
        </p>
        {problems.map((item) => (
          <p key={item.agent.id}>
            {item.agent.name}: {t(`agentStatus.${item.status}`)}
            {item.error ? ` — ${item.error}` : ""}
            {item.warnings.length ? ` — ${item.warnings.join("; ")}` : ""}
          </p>
        ))}
      </AlertDescription>
    </Alert>
  );
}
