"use client";

import {
  Calculator,
  Check,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AGENT_FIELDS } from "@/components/agents/graphql-fields";
import type { Agent } from "@/components/agents/types";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTime } from "@/components/ui/date-time";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { formatDateValue } from "@/lib/date-format";

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
  kind: "PROJECT" | "PENDING" | "SHARED_CACHE" | "DEVICE_SUPPORT";
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
  entryKind: "PROJECT" | "PENDING" | "SHARED_CACHE" | "DEVICE_SUPPORT";
  deletedAt: string;
};

const COLLECTION_FIELDS = `
  id status createdAt deadlineAt finishedAt
  progress {
    eligibleCount finishedCount successfulCount
    agents { agent { ${AGENT_FIELDS} } status jobId error warnings }
  }
  entries {
    id name kind status workspacePath worktreeId worktreePath sizeBytes operation error
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
  const [armedDeleteKey, setArmedDeleteKey] = useState<string | null>(null);
  const armedDeleteTimer = useRef<number | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyVersion, setHistoryVersion] = useState(0);

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
            items { id agentId agentName folderName worktreeId worktreePath source entryKind deletedAt }
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

  useEffect(
    () => () => {
      if (armedDeleteTimer.current) {
        window.clearTimeout(armedDeleteTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [historyVersion, loadHistory]);

  const allEntries = collection?.entries ?? [];
  const entries = allEntries.filter((entry) => entry.kind !== "DEVICE_SUPPORT");
  const deviceSupportEntries = allEntries.filter(
    (entry) => entry.kind === "DEVICE_SUPPORT",
  );
  const activeOperation = allEntries.some(
    (entry) => entry.operation !== "IDLE",
  );
  const selectedEntries = allEntries.filter((entry) => selected.has(entry.id));
  const allSelected =
    allEntries.length > 0 && selectedEntries.length === allEntries.length;
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
        setArmedDeleteKey(null);
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setOperationBusy(false);
    }
  };

  const previousEntryCount = useMemo(
    () => allEntries.length,
    [allEntries.length],
  );
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
    setArmedDeleteKey(null);
    setCollectionId(createClientId());
  };

  const inlineDelete = (key: string, entryIds: string[]) => {
    if (armedDeleteKey !== key) {
      setArmedDeleteKey(key);
      if (armedDeleteTimer.current) {
        window.clearTimeout(armedDeleteTimer.current);
      }
      armedDeleteTimer.current = window.setTimeout(
        () => setArmedDeleteKey(null),
        5_000,
      );
      return;
    }
    if (armedDeleteTimer.current) {
      window.clearTimeout(armedDeleteTimer.current);
      armedDeleteTimer.current = null;
    }
    setArmedDeleteKey(null);
    void runOperation("deleteDerivedDataEntries", entryIds);
  };

  const groupedHistory = useMemo(() => {
    const groups = new Map<string, { label: string; items: HistoryItem[] }>();
    for (const item of history) {
      const date = new Date(item.deletedAt);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const group = groups.get(key) ?? {
        label: formatDateValue(date, "long", { locale, showTime: false }),
        items: [],
      };
      group.items.push(item);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [history, locale]);
  const bulkDeleteKey = `bulk:${selectedEntries
    .map((entry) => entry.id)
    .sort()
    .join(":")}`;
  const bulkDeleteArmed = armedDeleteKey === bulkDeleteKey;

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
              !allEntries.length || loading || activeOperation || operationBusy
            }
            onClick={() =>
              void runOperation(
                "calculateDerivedDataSizes",
                allEntries.map((entry) => entry.id),
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
      ) : allEntries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {entries.length > 0 && (
            <Card className="gap-0 py-0">
              <CardHeader>
                <CardTitle>{t("derivedDataTitle")}</CardTitle>
                <CardDescription>{t("derivedDataDescription")}</CardDescription>
              </CardHeader>
              {selectedEntries.length > 0 && (
                <div className="flex items-center justify-between gap-3 border-b p-3">
                  <p className="text-sm">
                    {t("selected", { count: selectedEntries.length })}
                  </p>
                  <Button
                    className="w-40"
                    disabled={activeOperation || operationBusy}
                    onClick={() =>
                      inlineDelete(
                        bulkDeleteKey,
                        selectedEntries.map((entry) => entry.id),
                      )
                    }
                    size="sm"
                    variant={bulkDeleteArmed ? "destructive" : "outline"}
                  >
                    {bulkDeleteArmed ? <Check /> : <Trash2 />}
                    {bulkDeleteArmed ? t("confirmDelete") : t("deleteSelected")}
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
                        onCheckedChange={(checked) => {
                          setArmedDeleteKey(null);
                          setSelected(
                            checked === true
                              ? new Set(allEntries.map((entry) => entry.id))
                              : new Set(),
                          );
                        }}
                      />
                    </TableHead>
                    <TableHead>{t("folder")}</TableHead>
                    <TableHead>{t("worktree")}</TableHead>
                    <TableHead>{t("size")}</TableHead>
                    <TableHead>{t("agent")}</TableHead>
                    <TableHead className="w-12 text-right">
                      <span className="sr-only">{t("actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell>
                        <Checkbox
                          aria-label={t("selectEntry", { name: entry.name })}
                          checked={selected.has(entry.id)}
                          onCheckedChange={(checked) => {
                            setArmedDeleteKey(null);
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(entry.id);
                              else next.delete(entry.id);
                              return next;
                            });
                          }}
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
                      <TableCell className="w-12 text-right">
                        <DropdownMenu
                          onOpenChange={(open) => {
                            if (!open && armedDeleteKey === `row:${entry.id}`) {
                              if (armedDeleteTimer.current) {
                                window.clearTimeout(armedDeleteTimer.current);
                                armedDeleteTimer.current = null;
                              }
                              setArmedDeleteKey(null);
                            }
                          }}
                        >
                          <DropdownMenuTrigger asChild>
                            <Button
                              aria-label={t("entryActions", {
                                name: entry.name,
                              })}
                              className="ml-auto"
                              disabled={activeOperation || operationBusy}
                              size="icon-sm"
                              variant="ghost"
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              onSelect={(event) => {
                                if (armedDeleteKey !== `row:${entry.id}`) {
                                  event.preventDefault();
                                }
                                inlineDelete(`row:${entry.id}`, [entry.id]);
                              }}
                              variant={
                                armedDeleteKey === `row:${entry.id}`
                                  ? "destructive"
                                  : "default"
                              }
                            >
                              {armedDeleteKey === `row:${entry.id}` ? (
                                <Check />
                              ) : (
                                <Trash2 />
                              )}
                              {armedDeleteKey === `row:${entry.id}`
                                ? t("confirmDelete")
                                : t("delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
          <DeviceSupportCard
            activeOperation={activeOperation || operationBusy}
            entries={deviceSupportEntries}
            locale={locale}
            onDelete={(entryId) =>
              void runOperation("deleteDerivedDataEntries", [entryId])
            }
            onDeleteMany={(entryIds) =>
              void runOperation("deleteDerivedDataEntries", entryIds)
            }
            onSelectionChange={(entryId, checked) => {
              setArmedDeleteKey(null);
              setSelected((current) => {
                const next = new Set(current);
                if (checked) next.add(entryId);
                else next.delete(entryId);
                return next;
              });
            }}
            selected={selected}
          />
        </>
      )}

      <Card className="gap-0 py-0">
        <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
          <CardTitle>{t("history")}</CardTitle>
          <CardDescription>{t("historyDescription")}</CardDescription>
          {history.length > 0 && (
            <CardAction className="max-sm:col-start-1 max-sm:row-start-3 max-sm:row-span-1 max-sm:mt-3 max-sm:justify-self-stretch">
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
            </CardAction>
          )}
        </CardHeader>
        {historyLoading && history.length === 0 ? (
          <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Spinner /> {t("loadingHistory")}
          </p>
        ) : history.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyDescription>{t("noHistory")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
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
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell
                        className="py-1.5 text-xs font-normal text-muted-foreground"
                        colSpan={5}
                      >
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
                        <TableCell>
                          <DateTime kind="relative" value={item.deletedAt} />
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
      </Card>
    </section>
  );
}

function DeviceSupportCard({
  entries,
  selected,
  activeOperation,
  locale,
  onSelectionChange,
  onDelete,
  onDeleteMany,
}: {
  entries: DerivedDataEntry[];
  selected: Set<string>;
  activeOperation: boolean;
  locale: string;
  onSelectionChange: (entryId: string, checked: boolean) => void;
  onDelete: (entryId: string) => void;
  onDeleteMany: (entryIds: string[]) => void;
}) {
  const t = useTranslations("buildData");
  const tc = useTranslations("common");
  const selectedEntries = entries.filter((entry) => selected.has(entry.id));
  const allSelected =
    entries.length > 0 && selectedEntries.length === entries.length;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
        <CardTitle>{t("deviceSupportTitle")}</CardTitle>
        <CardDescription>{t("deviceSupportDescription")}</CardDescription>
        {selectedEntries.length > 0 && (
          <CardAction className="max-sm:col-start-1 max-sm:row-start-3 max-sm:row-span-1 max-sm:mt-3 max-sm:justify-self-stretch">
            <ConfirmationDialog
              actionLabel={t("deleteSelected")}
              cancelLabel={tc("cancel")}
              description={t("deleteDeviceSupportDescription", {
                count: selectedEntries.length,
              })}
              onConfirm={() =>
                onDeleteMany(selectedEntries.map((entry) => entry.id))
              }
              title={t("deleteDeviceSupportTitle")}
              trigger={
                <Button disabled={activeOperation} size="sm" variant="outline">
                  <Trash2 /> {t("deleteSelected")}
                </Button>
              }
            />
          </CardAction>
        )}
      </CardHeader>
      {entries.length === 0 ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyDescription>{t("noDeviceSupport")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <Checkbox
                  aria-label={t("selectAllDeviceSupport")}
                  checked={
                    allSelected
                      ? true
                      : selectedEntries.length
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(checked) => {
                    for (const entry of entries) {
                      onSelectionChange(entry.id, checked === true);
                    }
                  }}
                />
              </TableHead>
              <TableHead>{t("deviceSupportVersion")}</TableHead>
              <TableHead>{t("size")}</TableHead>
              <TableHead>{t("agent")}</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">{t("actions")}</span>
              </TableHead>
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
                      onSelectionChange(entry.id, checked === true)
                    }
                  />
                </TableCell>
                <TableCell>
                  <span className="font-mono text-xs">{entry.name}</span>
                  {entry.operation !== "IDLE" && <Spinner className="ml-2" />}
                  {entry.error && (
                    <p className="mt-1 text-xs text-destructive">
                      {entry.error}
                    </p>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {entry.sizeBytes === null
                    ? "—"
                    : formatBytes(entry.sizeBytes, locale)}
                </TableCell>
                <TableCell>
                  <Link href={`/agents/${entry.agent.id}`}>
                    {entry.agent.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <ConfirmationDialog
                    actionLabel={t("delete")}
                    cancelLabel={tc("cancel")}
                    description={t("deleteDeviceSupportDescription", {
                      count: 1,
                    })}
                    onConfirm={() => onDelete(entry.id)}
                    title={t("deleteDeviceSupportTitle")}
                    trigger={
                      <Button
                        aria-label={t("entryActions", { name: entry.name })}
                        disabled={activeOperation}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash2 />
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
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
