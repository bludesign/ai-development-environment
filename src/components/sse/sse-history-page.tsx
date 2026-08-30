"use client";

import {
  Check,
  ChevronDown,
  Columns3,
  Download,
  FileText,
  Filter,
  History,
  Printer,
  Search,
  Trash2,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatEnumLabel } from "@/lib/enum-label";

import { SSE_HISTORY_EXPORT_QUERY, SSE_HISTORY_QUERY } from "./graphql";
import { SseHistoryEventsTable } from "./sse-history-events-table";
import { ModeBadge, SsePageShell } from "./sse-shell";
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
  const [presetName, setPresetName] = useState("");
  const [filterName, setFilterName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  async function saveColumns() {
    try {
      await controlPlaneRequest(
        `mutation SaveSseHistorySettings($input: SseHistoryViewSettingsInput!) { saveSseHistoryViewSettings(input: $input) { view columns } }`,
        { input: { view, columns, timeFormat: "LOCAL" } },
      );
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function savePreset() {
    if (!presetName.trim()) return;
    try {
      await controlPlaneRequest(
        `mutation SaveSseColumnPreset($input: SseHistoryColumnPresetInput!) { saveSseHistoryColumnPreset(input: $input) { id } }`,
        { input: { view, name: presetName, columns } },
      );
      setPresetName("");
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
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
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">
                  <Columns3 /> Columns
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <p className="mb-2 font-medium">Visible columns</p>
                <div className="space-y-2">
                  {allColumns.map((column) => (
                    <label
                      className="flex items-center gap-2 text-sm"
                      key={column}
                    >
                      <Checkbox
                        checked={columns.includes(column)}
                        onCheckedChange={(checked) =>
                          setColumns((current) =>
                            checked
                              ? [...current, column]
                              : current.filter((item) => item !== column),
                          )
                        }
                      />
                      {columnLabel(column)}
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <Input
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="Preset name"
                    value={presetName}
                  />
                  <Button
                    disabled={!presetName.trim()}
                    onClick={() => void savePreset()}
                    size="sm"
                  >
                    Save
                  </Button>
                </div>
                <Button
                  className="mt-2 w-full"
                  onClick={() => void saveColumns()}
                  size="sm"
                  variant="outline"
                >
                  Save as my view
                </Button>
              </PopoverContent>
            </Popover>
            {data?.sseHistoryColumnPresets.length ? (
              <Select
                onValueChange={(id) => {
                  const preset = data.sseHistoryColumnPresets.find(
                    (item) => item.id === id,
                  );
                  if (preset)
                    setColumns(normalizeColumns(preset.columns, view));
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Column preset" />
                </SelectTrigger>
                <SelectContent>
                  {data.sseHistoryColumnPresets.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {data?.sseHistory.matchingCount ?? 0} matching of{" "}
          {data?.sseHistory.totalCount ?? 0}
        </p>
        <div className="flex flex-wrap gap-2">
          {selectedIds.size ? (
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
      <Card>
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
            <StreamsTable
              columns={columns}
              rows={data?.sseHistory.streams ?? []}
              selected={selectedIds}
              setSelected={setSelectedIds}
              openStream={(id) => router.push(`/sse/history/${id}`)}
            />
          ) : (
            <SseHistoryEventsTable
              columns={columns}
              rows={data?.sseHistory.events ?? []}
              selected={selectedIds}
              setSelected={setSelectedIds}
            />
          )}
        </CardContent>
      </Card>
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

function StreamsTable({
  rows,
  columns,
  selected,
  setSelected,
  openStream,
}: {
  rows: SseHistoryRequest[];
  columns: string[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  openStream: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
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
          </TableHead>
          {columns.map((column) => (
            <TableHead key={column}>{columnLabel(column)}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            aria-label={`View ${row.endpointName} stream`}
            className="cursor-pointer focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            key={row.id}
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
            <TableCell onClick={(event) => event.stopPropagation()}>
              <Selection
                checked={selected.has(row.id)}
                label={`Select ${row.endpointName}`}
                onCheckedChange={(checked) =>
                  setRow(setSelected, row.id, checked)
                }
              />
            </TableCell>
            {columns.map((column) => (
              <TableCell key={column}>{streamCell(row, column)}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
function streamCell(row: SseHistoryRequest, column: string) {
  switch (column) {
    case "endpoint":
      return <span className="font-medium">{row.endpointName}</span>;
    case "startedAt":
      return <DateTime value={row.startedAt} />;
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
          <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 xl:grid-cols-[minmax(16rem,1fr)_12rem_14rem]">
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
                  columns={[
                    "createdAt",
                    "eventName",
                    "stage",
                    "eventId",
                    "data",
                    "sequence",
                  ]}
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
