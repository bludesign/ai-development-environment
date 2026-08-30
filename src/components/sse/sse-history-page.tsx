"use client";

import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Columns3,
  Download,
  FileText,
  Filter,
  History,
  ListFilter,
  Paintbrush,
  Plus,
  Printer,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { DateTime } from "@/components/common/date-time";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatEnumLabel } from "@/lib/enum-label";

import { SSE_HISTORY_EXPORT_QUERY, SSE_HISTORY_QUERY } from "./graphql";
import {
  SseHistoryEventsTable,
  STREAM_EVENT_COLUMNS,
} from "./sse-history-events-table";
import { ModeBadge, SsePageShell } from "./sse-shell";
import {
  SseHistoryColumnHead,
  SseHistoryDayRow,
  sseHistoryDayKey,
} from "./sse-history-table-parts";
import type {
  SseEndpoint,
  SseHistoryEvent,
  SseHistoryRequest,
  SseHistoryStage,
  SseHistoryView,
  SseMode,
} from "./types";
import { useSseLiveReload } from "./use-sse-live-reload";

type HistoryPageData = {
  sseHistory: {
    view: SseHistoryView;
    streams: SseHistoryRequest[];
    events: SseHistoryEvent[];
    nextCursor: string | null;
    matchingCount: number;
    totalCount: number;
  };
  sseEndpoints: Pick<SseEndpoint, "id" | "name" | "mode" | "publicUrl">[];
  sseHistoryFacets: {
    endpoints?: Array<{ id: string; name: string }>;
    modes?: string[];
    statuses?: string[];
    eventNames?: string[];
  };
  sseHistoryViewSettings: {
    view: SseHistoryView;
    columns: string[];
    timeFormat: string;
    activeColumnPresetId: string | null;
    activeSavedFilterId: string | null;
  };
  sseHistoryColumnPresets: Array<{
    id: string;
    view: SseHistoryView;
    name: string;
    columns: string[];
    isDefault: boolean;
  }>;
  sseHistorySavedFilters: Array<{
    id: string;
    view: SseHistoryView;
    name: string;
    definition: Record<string, unknown>;
  }>;
};

type HistoryExportData = {
  sseHistory: Pick<
    HistoryPageData["sseHistory"],
    "view" | "nextCursor" | "streams" | "events"
  >;
};

type HistoryColumnPreset = HistoryPageData["sseHistoryColumnPresets"][number];

const STREAM_COLUMNS = [
  "endpoint",
  "startedAt",
  "method",
  "mode",
  "status",
  "responseStatus",
  "eventCount",
  "duration",
  "storedBytes",
];
const EVENT_COLUMNS = [
  "endpoint",
  "createdAt",
  "eventName",
  "stage",
  "eventId",
  "data",
  "sequence",
  "mode",
];

const COLUMN_LABELS: Record<string, string> = {
  endpoint: "Endpoint",
  startedAt: "Started At",
  createdAt: "Create At",
  method: "Method",
  mode: "Mode",
  status: "Status",
  responseStatus: "Response Status",
  eventCount: "Event Count",
  duration: "Duration",
  storedBytes: "Stored Bytes",
  eventName: "Event Name",
  stage: "Stage",
  eventId: "Event ID",
  data: "Data",
  sequence: "Sequence",
};

const COLUMN_ALIASES: Record<string, string> = {
  endpointName: "endpoint",
  durationMs: "duration",
};

function columnLabel(column: string) {
  return COLUMN_LABELS[column] ?? column;
}

function normalizeColumns(columns: string[], view: SseHistoryView) {
  const allowed = new Set(view === "STREAMS" ? STREAM_COLUMNS : EVENT_COLUMNS);
  return [
    ...new Set(
      columns
        .map((column) => COLUMN_ALIASES[column] ?? column)
        .filter((column) => allowed.has(column)),
    ),
  ];
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function SseHistoryPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState<SseHistoryView>("EVENTS");
  const [endpointId, setEndpointId] = useState(
    params.get("endpointId") ?? "all",
  );
  const [mode, setMode] = useState<SseMode | "all">("all");
  const [status, setStatus] = useState("all");
  const [eventName, setEventName] = useState("all");
  const [stage, setStage] = useState<SseHistoryStage | "all">("SOURCE");
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState("TEXT");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [data, setData] = useState<HistoryPageData | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [columns, setColumns] = useState<string[]>(EVENT_COLUMNS);
  const [filterName, setFilterName] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [timeFormat, setTimeFormat] = useState("TWELVE_HOUR");

  const variables = useMemo(
    () => ({
      view,
      first: 100,
      endpointId: endpointId === "all" ? null : endpointId,
      modes: mode === "all" ? null : [mode],
      statuses: status === "all" ? null : [status],
      eventNames: eventName === "all" ? null : [eventName],
      stages: view === "EVENTS" && stage !== "all" ? [stage] : null,
      search: search || null,
      searchMode,
      caseSensitive,
    }),
    [
      caseSensitive,
      endpointId,
      eventName,
      mode,
      search,
      searchMode,
      stage,
      status,
      view,
    ],
  );

  const load = useCallback(async () => {
    try {
      const response = await controlPlaneRequest<HistoryPageData>(
        SSE_HISTORY_QUERY,
        { input: variables, view },
      );
      setData(response);
      setColumns((current) =>
        response.sseHistoryViewSettings.columns.length
          ? normalizeColumns(response.sseHistoryViewSettings.columns, view)
          : current,
      );
      setTimeFormat(response.sseHistoryViewSettings.timeFormat);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [variables, view]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("history", () => void load());

  function changeView(next: string) {
    if (next !== "STREAMS" && next !== "EVENTS") return;
    setView(next);
    setColumns(next === "STREAMS" ? STREAM_COLUMNS : EVENT_COLUMNS);
    setSelectedIds(new Set());
    setEditMode(false);
    setLoading(true);
  }

  async function clearSelected() {
    if (!selectedIds.size) return;
    try {
      const ids =
        view === "STREAMS"
          ? [...selectedIds]
          : [
              ...new Set(
                (data?.sseHistory.events ?? [])
                  .filter((item) => selectedIds.has(item.id))
                  .map((item) => item.requestId),
              ),
            ];
      await controlPlaneRequest(
        `mutation ClearSseHistory($ids: [ID!]) { clearSseHistory(ids: $ids) }`,
        { ids },
      );
      setSelectedIds(new Set());
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function saveViewSettings(input: {
    columns?: string[];
    timeFormat?: string;
    activeColumnPresetId?: string | null;
  }) {
    try {
      const response = await controlPlaneRequest<{
        saveSseHistoryViewSettings: HistoryPageData["sseHistoryViewSettings"];
      }>(
        `mutation SaveSseHistorySettings($input: SseHistoryViewSettingsInput!) {
          saveSseHistoryViewSettings(input: $input) {
            view columns timeFormat activeColumnPresetId activeSavedFilterId
          }
        }`,
        { input: { view, ...input } },
      );
      if (input.columns) setColumns(normalizeColumns(input.columns, view));
      if (input.timeFormat) setTimeFormat(input.timeFormat);
      setData((current) =>
        current
          ? {
              ...current,
              sseHistoryViewSettings: {
                ...current.sseHistoryViewSettings,
                ...response.saveSseHistoryViewSettings,
              },
            }
          : current,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  function removeColumn(column: string) {
    if (columns.length <= 1) return;
    const next = columns.filter((candidate) => candidate !== column);
    void saveViewSettings({ columns: next, activeColumnPresetId: null });
  }

  const filterDefinition = useMemo(
    () => ({
      endpointId: endpointId === "all" ? null : endpointId,
      mode: mode === "all" ? null : mode,
      status: status === "all" ? null : status,
      eventName: eventName === "all" ? null : eventName,
      stage: view === "EVENTS" && stage !== "all" ? stage : null,
      search,
      searchMode,
      caseSensitive,
    }),
    [
      caseSensitive,
      endpointId,
      eventName,
      mode,
      search,
      searchMode,
      stage,
      status,
      view,
    ],
  );
  async function saveFilter() {
    if (!filterName.trim()) return;
    try {
      await controlPlaneRequest(
        `mutation SaveSseFilter($input: SseHistorySavedFilterInput!) { saveSseHistorySavedFilter(input: $input) { id } }`,
        { input: { view, name: filterName, definition: filterDefinition } },
      );
      setFilterName("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  function applyFilter(definition: Record<string, unknown>) {
    setEndpointId(
      typeof definition.endpointId === "string" ? definition.endpointId : "all",
    );
    setMode(
      typeof definition.mode === "string"
        ? (definition.mode as SseMode)
        : "all",
    );
    setStatus(
      typeof definition.status === "string" ? definition.status : "all",
    );
    setEventName(
      typeof definition.eventName === "string" ? definition.eventName : "all",
    );
    setStage(
      definition.stage === "SOURCE" ||
        definition.stage === "EMITTED" ||
        definition.stage === "DROPPED"
        ? definition.stage
        : "all",
    );
    setSearch(typeof definition.search === "string" ? definition.search : "");
    setSearchMode(
      typeof definition.searchMode === "string"
        ? definition.searchMode
        : "TEXT",
    );
    setCaseSensitive(definition.caseSensitive === true);
  }

  const rows =
    view === "STREAMS"
      ? (data?.sseHistory.streams ?? [])
      : (data?.sseHistory.events ?? []);

  async function loadMore() {
    const after = data?.sseHistory.nextCursor;
    if (!after) return;
    setLoadingMore(true);
    try {
      const response = await controlPlaneRequest<HistoryPageData>(
        SSE_HISTORY_QUERY,
        { input: { ...variables, after }, view },
      );
      setData((current) => {
        if (!current) return response;
        return {
          ...response,
          sseHistory: {
            ...response.sseHistory,
            streams: [
              ...current.sseHistory.streams,
              ...response.sseHistory.streams,
            ],
            events: [
              ...current.sseHistory.events,
              ...response.sseHistory.events,
            ],
          },
        };
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportRows(format: "csv" | "markdown") {
    try {
      const matchingRows: Array<SseHistoryRequest | SseHistoryEvent> = [];
      let after: string | null = null;
      do {
        const response: HistoryExportData =
          await controlPlaneRequest<HistoryExportData>(
            SSE_HISTORY_EXPORT_QUERY,
            {
              input: { ...variables, first: 500, after },
            },
          );
        matchingRows.push(
          ...(response.sseHistory.view === "STREAMS"
            ? response.sseHistory.streams
            : response.sseHistory.events),
        );
        after = response.sseHistory.nextCursor;
      } while (after);

      const exported = matchingRows.map((row) =>
        view === "STREAMS"
          ? {
              endpoint: (row as SseHistoryRequest).endpointName,
              startedAt: (row as SseHistoryRequest).startedAt,
              method: (row as SseHistoryRequest).method,
              mode: (row as SseHistoryRequest).mode,
              status:
                (row as SseHistoryRequest).outcome ??
                (row as SseHistoryRequest).status,
              responseStatus: (row as SseHistoryRequest).responseStatus,
              events: (row as SseHistoryRequest).eventCount,
              durationMs: (row as SseHistoryRequest).durationMs,
            }
          : {
              endpoint: (row as SseHistoryEvent).request?.endpointName,
              createdAt: (row as SseHistoryEvent).createdAt,
              eventName: (row as SseHistoryEvent).eventName,
              stage: (row as SseHistoryEvent).stage,
              eventId: (row as SseHistoryEvent).eventId,
              data: (row as SseHistoryEvent).data,
            },
      );
      const keys = Object.keys(exported[0] ?? {});
      if (format === "csv")
        download(
          "sse-history.csv",
          [
            keys.map(csvCell).join(","),
            ...exported.map((item) =>
              keys
                .map((key) => csvCell((item as Record<string, unknown>)[key]))
                .join(","),
            ),
          ].join("\n"),
          "text/csv",
        );
      else
        download(
          "sse-history.md",
          [
            `| ${keys.join(" | ")} |`,
            `| ${keys.map(() => "---").join(" | ")} |`,
            ...exported.map(
              (item) =>
                `| ${keys
                  .map((key) =>
                    String((item as Record<string, unknown>)[key] ?? "")
                      .replaceAll("|", "\\|")
                      .replaceAll("\n", "<br>"),
                  )
                  .join(" | ")} |`,
            ),
          ].join("\n"),
          "text/markdown",
        );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const allColumns = view === "STREAMS" ? STREAM_COLUMNS : EVENT_COLUMNS;
  const hour12 = !["24", "TWENTY_FOUR_HOUR"].includes(timeFormat);
  return (
    <SsePageShell
      badge={data ? `${data.sseHistory.matchingCount} matching` : undefined}
      description="Inspect every hosted SSE stream and logical event with live updates, endpoint facets, saved filters, configurable columns, and export."
      title="SSE History"
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Filters and views</CardTitle>
          <CardDescription>
            Text, glob, and regular-expression search cover request URLs,
            endpoint names, event names, event IDs, data, and errors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              onValueChange={changeView}
              spacing={0}
              type="single"
              value={view}
              variant="outline"
            >
              <ToggleGroupItem value="STREAMS">
                <History /> Streams
              </ToggleGroupItem>
              <ToggleGroupItem value="EVENTS">
                <FileText /> Events
              </ToggleGroupItem>
            </ToggleGroup>
            <Select onValueChange={setEndpointId} value={endpointId}>
              <SelectTrigger className="min-w-56">
                <SelectValue placeholder="All endpoints" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All endpoints</SelectItem>
                {data?.sseEndpoints.map((endpoint) => (
                  <SelectItem key={endpoint.id} value={endpoint.id}>
                    {endpoint.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              onValueChange={(value) => setMode(value as SseMode | "all")}
              value={mode}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All modes</SelectItem>
                {["FORWARD", "MOCK", "BREAKPOINT"].map((value) => (
                  <SelectItem key={value} value={value}>
                    {formatEnumLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select onValueChange={setStatus} value={status}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                {data?.sseHistoryFacets.statuses?.map((value) => (
                  <SelectItem key={value} value={value}>
                    {formatEnumLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {view === "EVENTS" ? (
              <>
                <Select
                  onValueChange={(value) =>
                    setStage(value as SseHistoryStage | "all")
                  }
                  value={stage}
                >
                  <SelectTrigger aria-label="Stage" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stages</SelectItem>
                    <SelectItem value="SOURCE">Source</SelectItem>
                    <SelectItem value="EMITTED">Emitted</SelectItem>
                    <SelectItem value="DROPPED">Dropped</SelectItem>
                  </SelectContent>
                </Select>
                <Select onValueChange={setEventName} value={eventName}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All event names</SelectItem>
                    {data?.sseHistoryFacets.eventNames?.map((value) => (
                      <SelectItem key={value} value={value}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-64 flex-1">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search history"
                value={search}
              />
            </div>
            <Select onValueChange={setSearchMode} value={searchMode}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TEXT">Text</SelectItem>
                <SelectItem value="GLOB">Glob</SelectItem>
                <SelectItem value="REGEX">Regex</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => setCaseSensitive((value) => !value)}
              variant={caseSensitive ? "secondary" : "outline"}
            >
              Aa
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Filter /> Saved filters <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Saved filters</DropdownMenuLabel>
                {data?.sseHistorySavedFilters.length ? (
                  data.sseHistorySavedFilters.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onClick={() => applyFilter(item.definition)}
                    >
                      {item.name}
                    </DropdownMenuItem>
                  ))
                ) : (
                  <DropdownMenuItem disabled>No saved filters</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <div className="flex gap-2 p-2">
                  <Input
                    onChange={(event) => setFilterName(event.target.value)}
                    placeholder="Filter name"
                    value={filterName}
                  />
                  <Button
                    disabled={!filterName.trim()}
                    onClick={() => void saveFilter()}
                    size="sm"
                  >
                    <Check />
                  </Button>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => setColumnsOpen(true)} variant="outline">
              <Columns3 /> Columns
            </Button>
            <Button
              onClick={() => {
                setEditMode((current) => {
                  if (current) setSelectedIds(new Set());
                  return !current;
                });
              }}
              variant={editMode ? "default" : "outline"}
            >
              {editMode ? <X /> : <ListFilter />}
              {editMode ? "Done" : "Edit"}
            </Button>
            <Tabs
              onValueChange={(value) =>
                void saveViewSettings({
                  timeFormat:
                    value === "24" ? "TWENTY_FOUR_HOUR" : "TWELVE_HOUR",
                })
              }
              value={hour12 ? "12" : "24"}
            >
              <TabsList>
                <TabsTrigger value="12">12h</TabsTrigger>
                <TabsTrigger value="24">24h</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {data?.sseHistory.matchingCount ?? 0} matching of{" "}
          {data?.sseHistory.totalCount ?? 0}
        </p>
        <div className="flex flex-wrap gap-2">
          {editMode && selectedIds.size ? (
            <Button onClick={() => void clearSelected()} variant="destructive">
              <Trash2 /> Delete {selectedIds.size}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                <Download /> Export <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void exportRows("csv")}>
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportRows("markdown")}>
                Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => window.print()}>
                <Printer /> Print / Save PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="overflow-x-auto p-0">
          {loading ? (
            <p className="flex items-center gap-2 p-4 text-muted-foreground">
              <Spinner /> Loading history…
            </p>
          ) : rows.length === 0 ? (
            <p className="p-16 text-center text-sm text-muted-foreground">
              No history matches these filters.
            </p>
          ) : view === "STREAMS" ? (
            <SseHistoryStreamsTable
              columns={columns}
              rows={data?.sseHistory.streams ?? []}
              selected={selectedIds}
              setSelected={setSelectedIds}
              editMode={editMode}
              hour12={hour12}
              onRemoveColumn={removeColumn}
              openStream={(id) => router.push(`/sse/history/${id}`)}
            />
          ) : (
            <SseHistoryEventsTable
              columns={columns}
              rows={data?.sseHistory.events ?? []}
              selected={selectedIds}
              setSelected={setSelectedIds}
              editMode={editMode}
              hour12={hour12}
              onRemoveColumn={removeColumn}
            />
          )}
        </CardContent>
      </Card>
      {data?.sseHistory.nextCursor ? (
        <Button
          disabled={loadingMore}
          onClick={() => void loadMore()}
          variant="outline"
        >
          {loadingMore ? <Spinner /> : null} Load More
        </Button>
      ) : null}
      {data ? (
        <SseHistoryColumnsDialog
          activePresetId={data.sseHistoryViewSettings.activeColumnPresetId}
          allColumns={allColumns}
          columns={columns}
          key={`columns:${columnsOpen}:${view}:${columns.join("|")}`}
          onChanged={() => void load()}
          onError={setError}
          onOpenChange={setColumnsOpen}
          onSave={(nextColumns, activeColumnPresetId) =>
            saveViewSettings({
              columns: nextColumns,
              activeColumnPresetId,
            })
          }
          open={columnsOpen}
          presets={data.sseHistoryColumnPresets}
          view={view}
        />
      ) : null}
    </SsePageShell>
  );
}

function Selection({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <Checkbox
      aria-label={label}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
    />
  );
}
function setRow(
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>,
  id: string,
  checked: boolean,
) {
  setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  });
}

export function SseHistoryStreamsTable({
  rows,
  columns,
  selected,
  setSelected,
  openStream,
  editMode,
  hour12,
  onRemoveColumn,
}: {
  rows: SseHistoryRequest[];
  columns: string[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  openStream: (id: string) => void;
  editMode: boolean;
  hour12: boolean;
  onRemoveColumn: (column: string) => void;
}) {
  const idsByDay = new Map<string, string[]>();
  for (const row of rows) {
    const day = sseHistoryDayKey(row.startedAt);
    idsByDay.set(day, [...(idsByDay.get(day) ?? []), row.id]);
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 w-20 px-2">
            {editMode ? (
              <Selection
                checked={
                  rows.length > 0 && rows.every((row) => selected.has(row.id))
                }
                label="Select all streams"
                onCheckedChange={(checked) =>
                  setSelected(
                    checked ? new Set(rows.map((row) => row.id)) : new Set(),
                  )
                }
              />
            ) : (
              <span className="sr-only">Open stream</span>
            )}
          </TableHead>
          {columns.map((column) => (
            <SseHistoryColumnHead
              key={column}
              label={columnLabel(column)}
              onRemove={() => onRemoveColumn(column)}
              removable={columns.length > 1}
            />
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => {
          const day = sseHistoryDayKey(row.startedAt);
          const dayIds = idsByDay.get(day) ?? [];
          const selectedDayCount = dayIds.filter((id) =>
            selected.has(id),
          ).length;
          const showDay =
            index === 0 || sseHistoryDayKey(rows[index - 1]!.startedAt) !== day;
          return (
            <Fragment key={row.id}>
              {showDay ? (
                <SseHistoryDayRow
                  checked={
                    editMode
                      ? selectedDayCount === dayIds.length
                        ? true
                        : selectedDayCount
                          ? "indeterminate"
                          : false
                      : undefined
                  }
                  colSpan={columns.length + 1}
                  onCheckedChange={
                    editMode
                      ? (checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            for (const id of dayIds) {
                              if (checked) next.add(id);
                              else next.delete(id);
                            }
                            return next;
                          })
                      : undefined
                  }
                  value={row.startedAt}
                />
              ) : null}
              <TableRow
                aria-label={`View ${row.endpointName} stream`}
                className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                onClick={() => openStream(row.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openStream(row.id);
                  }
                }}
                role="link"
                tabIndex={0}
              >
                <TableCell className="px-2 py-1.5">
                  <span className="flex items-center gap-1">
                    {editMode ? (
                      <span
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <Selection
                          checked={selected.has(row.id)}
                          label={`Select ${row.endpointName}`}
                          onCheckedChange={(checked) =>
                            setRow(setSelected, row.id, checked)
                          }
                        />
                      </span>
                    ) : null}
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </span>
                </TableCell>
                {columns.map((column) => (
                  <TableCell className="px-2 py-1.5" key={column}>
                    {streamCell(row, column, hour12)}
                  </TableCell>
                ))}
              </TableRow>
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}
function streamCell(row: SseHistoryRequest, column: string, hour12: boolean) {
  switch (column) {
    case "endpoint":
      return <span className="font-medium">{row.endpointName}</span>;
    case "startedAt":
      return <DateTime hour12={hour12} kind="time" value={row.startedAt} />;
    case "method":
      return <code>{row.method}</code>;
    case "mode":
      return <ModeBadge mode={row.mode} />;
    case "status":
      return (
        <Badge
          variant={
            row.error
              ? "destructive"
              : row.outcome === "COMPLETED"
                ? "success"
                : "outline"
          }
        >
          {formatEnumLabel(row.outcome ?? row.status)}
        </Badge>
      );
    case "responseStatus":
      return row.responseStatus ?? "—";
    case "eventCount":
      return row.eventCount;
    case "duration":
      return row.durationMs === null ? "—" : `${row.durationMs} ms`;
    case "storedBytes":
      return row.truncated ? `${row.storedBytes} (truncated)` : row.storedBytes;
    default:
      return "—";
  }
}

function SseHistoryColumnsDialog({
  open,
  onOpenChange,
  view,
  columns,
  allColumns,
  presets,
  activePresetId,
  onSave,
  onChanged,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: SseHistoryView;
  columns: string[];
  allColumns: string[];
  presets: HistoryColumnPreset[];
  activePresetId: string | null;
  onSave: (columns: string[], activePresetId: string | null) => Promise<void>;
  onChanged: () => Promise<void> | void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(columns);
  const [draftPresetId, setDraftPresetId] = useState(activePresetId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  function move(index: number, direction: -1 | 1) {
    setDraftPresetId(null);
    setDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function savePreset(preset?: HistoryColumnPreset) {
    const input = preset
      ? {
          id: preset.id,
          view,
          name: preset.name,
          columns: preset.columns,
          isDefault: true,
        }
      : {
          id: editingId,
          view,
          name: presetName,
          columns: draft,
          isDefault: makeDefault,
        };
    setSaving(true);
    try {
      const response = await controlPlaneRequest<{
        saveSseHistoryColumnPreset: HistoryColumnPreset;
      }>(
        `mutation SaveSseHistoryColumnPreset($input: SseHistoryColumnPresetInput!) {
          saveSseHistoryColumnPreset(input: $input) {
            id view name columns isDefault
          }
        }`,
        { input },
      );
      setDraftPresetId(response.saveSseHistoryColumnPreset.id);
      setEditingId(null);
      setPresetName("");
      setMakeDefault(false);
      await onChanged();
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }

  async function deletePreset(id: string) {
    try {
      await controlPlaneRequest(
        `mutation DeleteSseHistoryColumnPreset($id: ID!) {
          deleteSseHistoryColumnPreset(id: $id)
        }`,
        { id },
      );
      if (draftPresetId === id) setDraftPresetId(null);
      if (editingId === id) {
        setEditingId(null);
        setPresetName("");
        setMakeDefault(false);
      }
      await onChanged();
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage Columns</DialogTitle>
          <DialogDescription>
            Choose and reorder table columns, then save reusable presets for the{" "}
            {view === "EVENTS" ? "Events" : "Streams"} view.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Available Columns</h3>
            <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border p-2">
              {allColumns.map((column) => {
                const index = draft.indexOf(column);
                return (
                  <div className="flex items-center gap-2" key={column}>
                    <Checkbox
                      aria-label={columnLabel(column)}
                      checked={index >= 0}
                      onCheckedChange={(checked) => {
                        setDraftPresetId(null);
                        setDraft((current) =>
                          checked
                            ? [...current, column]
                            : current.length > 1
                              ? current.filter((item) => item !== column)
                              : current,
                        );
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {columnLabel(column)}
                    </span>
                    {index >= 0 ? (
                      <>
                        <Button
                          aria-label={`Move ${columnLabel(column)} up`}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          aria-label={`Move ${columnLabel(column)} down`}
                          disabled={index === draft.length - 1}
                          onClick={() => move(index, 1)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <ArrowDown />
                        </Button>
                      </>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <Button
              onClick={() => {
                setDraft(allColumns);
                setDraftPresetId(null);
              }}
              size="sm"
              variant="outline"
            >
              Reset Columns
            </Button>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Column Presets</h3>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {presets.length ? (
                presets.map((preset) => (
                  <div
                    className="flex items-center gap-1 rounded-lg border p-2"
                    key={preset.id}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {preset.name}
                      {preset.isDefault ? " · Default" : ""}
                    </span>
                    <Button
                      onClick={() => {
                        setDraft(normalizeColumns(preset.columns, view));
                        setDraftPresetId(preset.id);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Load
                    </Button>
                    <Button
                      aria-label={`Edit ${preset.name}`}
                      onClick={() => {
                        setDraft(normalizeColumns(preset.columns, view));
                        setDraftPresetId(preset.id);
                        setEditingId(preset.id);
                        setPresetName(preset.name);
                        setMakeDefault(preset.isDefault);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    {!preset.isDefault ? (
                      <Button
                        aria-label={`Make ${preset.name} the default`}
                        onClick={() => void savePreset(preset)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Paintbrush />
                      </Button>
                    ) : null}
                    <Button
                      aria-label={`Delete ${preset.name}`}
                      onClick={() => void deletePreset(preset.id)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">
                  No column presets saved.
                </p>
              )}
            </div>
            <Input
              aria-label="Preset name"
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="Preset name"
              value={presetName}
            />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={makeDefault}
                onCheckedChange={(checked) => setMakeDefault(checked === true)}
              />
              Set as default
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!presetName.trim() || !draft.length || saving}
                onClick={() => void savePreset()}
                size="sm"
              >
                {saving ? <Spinner /> : <Plus />}
                {editingId ? "Update Preset" : "Save Preset"}
              </Button>
              {editingId ? (
                <Button
                  onClick={() => {
                    setEditingId(null);
                    setPresetName("");
                    setMakeDefault(false);
                  }}
                  size="sm"
                  variant="outline"
                >
                  Save As New
                </Button>
              ) : null}
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button
            disabled={!draft.length}
            onClick={() => {
              void onSave(draft, draftPresetId);
              onOpenChange(false);
            }}
          >
            Apply Columns
          </Button>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HeaderList({
  title,
  headers,
}: {
  title: string;
  headers: Array<{ name: string; value: string }>;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 text-xs">
          {headers.length
            ? headers
                .map((header) => `${header.name}: ${header.value}`)
                .join("\n")
            : "No headers"}
        </pre>
      </CardContent>
    </Card>
  );
}

function DetailValue({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export function SseStreamHistoryDetails({
  request,
}: {
  request: SseHistoryRequest;
}) {
  const [eventSearch, setEventSearch] = useState("");
  const [eventStage, setEventStage] = useState<SseHistoryStage | "all">("all");
  const [eventNameFilter, setEventNameFilter] = useState("all");
  const [eventColumns, setEventColumns] = useState<string[]>([
    ...STREAM_EVENT_COLUMNS,
  ]);
  const [eventHour12, setEventHour12] = useState(true);
  const events = request.events ?? [];
  const eventNames = [
    ...new Set(events.map((event) => event.eventName)),
  ].sort();
  const filteredEvents = events.filter((event) => {
    if (eventStage !== "all" && event.stage !== eventStage) return false;
    if (eventNameFilter !== "all" && event.eventName !== eventNameFilter) {
      return false;
    }
    if (!eventSearch.trim()) return true;
    const term = eventSearch.toLocaleLowerCase();
    return (
      event.eventName.toLocaleLowerCase().includes(term) ||
      event.data.toLocaleLowerCase().includes(term) ||
      (event.eventId ?? "").toLocaleLowerCase().includes(term)
    );
  });

  return (
    <div className="min-w-0 space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap gap-2">
        <ModeBadge mode={request.mode} />
        <Badge variant={request.error ? "destructive" : "success"}>
          {formatEnumLabel(request.outcome ?? request.status)}
        </Badge>
        {request.truncated ? (
          <Badge variant="destructive">History truncated</Badge>
        ) : null}
        <Badge variant="outline">{request.eventCount} events</Badge>
      </div>
      {request.error ? (
        <Alert variant="destructive">
          <AlertDescription>{request.error}</AlertDescription>
        </Alert>
      ) : null}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Stream overview</CardTitle>
          <CardDescription>
            Original and effective request information captured for this
            connection.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <DetailValue label="Started">
              <DateTime value={request.startedAt} />
            </DetailValue>
            <DetailValue label="First Event">
              <DateTime value={request.firstEventAt} />
            </DetailValue>
            <DetailValue label="Finished">
              <DateTime value={request.finishedAt} />
            </DetailValue>
            <DetailValue label="Duration">
              {request.durationMs === null ? "—" : `${request.durationMs} ms`}
            </DetailValue>
            <DetailValue label="Effective Request" className="sm:col-span-2">
              <p className="break-all">
                <code>{request.effectiveMethod ?? request.method}</code>{" "}
                {request.effectiveUrl ?? "Not forwarded"}
              </p>
            </DetailValue>
            <DetailValue label="Response Status">
              {request.responseStatus ?? "—"}
            </DetailValue>
            <DetailValue label="Persisted Data">
              {request.storedBytes.toLocaleString()} bytes
            </DetailValue>
          </dl>
        </CardContent>
      </Card>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Headers</h3>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <HeaderList
            headers={request.requestHeaders}
            title="Original request"
          />
          <HeaderList
            headers={request.effectiveHeaders}
            title="Effective forwarded"
          />
          <HeaderList
            headers={request.upstreamHeaders}
            title="Upstream response"
          />
          <HeaderList
            headers={request.responseHeaders}
            title="Emitted response"
          />
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Request bodies</h3>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Original body</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-xs">
                {request.requestBody ?? "No body"}
              </pre>
            </CardContent>
          </Card>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Effective body</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-xs">
                {request.effectiveBody ?? "No body"}
              </pre>
            </CardContent>
          </Card>
        </div>
      </section>
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Event Stream</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Filter the retained source, emitted, and dropped records, then
            expand any row to inspect the complete event.
          </p>
        </div>
        <Card size="sm">
          <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_12rem_14rem_auto_auto]">
            <div className="relative sm:col-span-2 xl:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search stream events"
                className="pl-9"
                onChange={(event) => setEventSearch(event.target.value)}
                placeholder="Search event name, data, or ID"
                type="search"
                value={eventSearch}
              />
            </div>
            <Select
              onValueChange={(value) =>
                setEventStage(value as SseHistoryStage | "all")
              }
              value={eventStage}
            >
              <SelectTrigger aria-label="Filter stream events by stage">
                <SelectValue placeholder="All Stages" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Stages</SelectItem>
                <SelectItem value="SOURCE">Source</SelectItem>
                <SelectItem value="EMITTED">Emitted</SelectItem>
                <SelectItem value="DROPPED">Dropped</SelectItem>
              </SelectContent>
            </Select>
            <Select onValueChange={setEventNameFilter} value={eventNameFilter}>
              <SelectTrigger aria-label="Filter stream events by name">
                <SelectValue placeholder="All Event Names" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Event Names</SelectItem>
                {eventNames.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Columns3 /> Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Visible Columns</DropdownMenuLabel>
                {STREAM_EVENT_COLUMNS.map((column) => (
                  <DropdownMenuCheckboxItem
                    checked={eventColumns.includes(column)}
                    key={column}
                    onCheckedChange={(checked) =>
                      setEventColumns((current) =>
                        checked
                          ? [...current, column]
                          : current.length > 1
                            ? current.filter((item) => item !== column)
                            : current,
                      )
                    }
                  >
                    {columnLabel(column)}
                  </DropdownMenuCheckboxItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setEventColumns([...STREAM_EVENT_COLUMNS])}
                >
                  Reset Columns
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tabs
              onValueChange={(value) => setEventHour12(value === "12")}
              value={eventHour12 ? "12" : "24"}
            >
              <TabsList>
                <TabsTrigger value="12">12h</TabsTrigger>
                <TabsTrigger value="24">24h</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Events</CardTitle>
            <CardDescription>
              {filteredEvents.length} of {events.length} retained records
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {request.events ? (
              filteredEvents.length ? (
                <SseHistoryEventsTable
                  columns={eventColumns}
                  hour12={eventHour12}
                  onRemoveColumn={(column) =>
                    setEventColumns((current) =>
                      current.length > 1
                        ? current.filter((item) => item !== column)
                        : current,
                    )
                  }
                  rows={filteredEvents}
                  stream={request}
                />
              ) : (
                <p className="p-10 text-center text-sm text-muted-foreground">
                  No retained event records match these filters.
                </p>
              )
            ) : (
              <p className="flex items-center gap-2 p-4 text-muted-foreground">
                <Spinner /> Loading event records…
              </p>
            )}
          </CardContent>
        </Card>
      </section>
      <details className="rounded-lg border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Configuration snapshot
        </summary>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-xs">
          {JSON.stringify(request.configSnapshot, null, 2)}
        </pre>
      </details>
    </div>
  );
}
