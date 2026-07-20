"use client";

import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Columns3,
  Download,
  Filter,
  ListFilter,
  Paintbrush,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { copyText } from "@/lib/browser-utils";
import { cn } from "@/lib/utils";
import {
  flattenTelemetryObject,
  telemetryFields,
} from "@/services/telemetry/matching";
import {
  DEFAULT_TELEMETRY_COLUMNS,
  TELEMETRY_COLORS,
  TELEMETRY_FILTER_OPERATORS,
  type TelemetryColumnPresetView,
  type TelemetryEntryView,
  type TelemetryFacets,
  type TelemetryFilterCondition,
  type TelemetryFilterDefinition,
  type TelemetryQueryInput,
  type TelemetrySavedFilterView,
  type TelemetrySearchMode,
  type TelemetrySelection,
  type TelemetrySelectionRange,
  type TelemetrySettingsView,
  type TelemetryTimelinePage,
  type TelemetryView,
  type TelemetryViewSettingsView,
} from "@/services/telemetry/types";

const ENTRY_FIELDS = `
  id entryType clientTime receivedAt deviceIp message level category eventName
  eventKind screenName buildId sessionId attributes defaultParameters
  additionalParameters highlightColor separatorKind separatorName
`;

const BASE_COLUMNS: Record<TelemetryView, string[]> = {
  CONSOLE: [
    ...DEFAULT_TELEMETRY_COLUMNS.CONSOLE,
    "deviceIp",
    "receivedAt",
    "attributes",
  ],
  ANALYTICS: [
    ...DEFAULT_TELEMETRY_COLUMNS.ANALYTICS,
    "deviceIp",
    "receivedAt",
    "defaultParameters",
    "additionalParameters",
  ],
  UNIFIED: [
    ...DEFAULT_TELEMETRY_COLUMNS.UNIFIED,
    "deviceIp",
    "receivedAt",
    "category",
    "screenName",
  ],
};

const QUICK_FIELDS: Record<TelemetryView, string[]> = {
  CONSOLE: ["level", "category", "deviceIp", "buildId", "sessionId"],
  ANALYTICS: [
    "eventKind",
    "eventName",
    "screenName",
    "deviceIp",
    "buildId",
    "sessionId",
  ],
  UNIFIED: ["source", "levelKind", "deviceIp", "buildId", "sessionId"],
};

const HIGHLIGHT_CLASSES: Record<string, string> = {
  gray: "bg-slate-500/10 hover:bg-slate-500/20",
  stone: "bg-stone-500/10 hover:bg-stone-500/20",
  red: "bg-red-500/10 hover:bg-red-500/20",
  rose: "bg-rose-500/10 hover:bg-rose-500/20",
  orange: "bg-orange-500/10 hover:bg-orange-500/20",
  amber: "bg-amber-500/10 hover:bg-amber-500/20",
  yellow: "bg-yellow-500/10 hover:bg-yellow-500/20",
  lime: "bg-lime-500/10 hover:bg-lime-500/20",
  green: "bg-green-500/10 hover:bg-green-500/20",
  emerald: "bg-emerald-500/10 hover:bg-emerald-500/20",
  teal: "bg-teal-500/10 hover:bg-teal-500/20",
  cyan: "bg-cyan-500/10 hover:bg-cyan-500/20",
  sky: "bg-sky-500/10 hover:bg-sky-500/20",
  blue: "bg-blue-500/10 hover:bg-blue-500/20",
  indigo: "bg-indigo-500/10 hover:bg-indigo-500/20",
  violet: "bg-violet-500/10 hover:bg-violet-500/20",
  purple: "bg-purple-500/10 hover:bg-purple-500/20",
  fuchsia: "bg-fuchsia-500/10 hover:bg-fuchsia-500/20",
  pink: "bg-pink-500/10 hover:bg-pink-500/20",
};

const SWATCH_CLASSES: Record<string, string> = {
  gray: "border-slate-600 bg-slate-500",
  stone: "border-stone-600 bg-stone-500",
  red: "border-red-600 bg-red-500",
  rose: "border-rose-600 bg-rose-500",
  orange: "border-orange-600 bg-orange-500",
  amber: "border-amber-600 bg-amber-500",
  yellow: "border-yellow-600 bg-yellow-500",
  lime: "border-lime-600 bg-lime-500",
  green: "border-green-600 bg-green-500",
  emerald: "border-emerald-600 bg-emerald-500",
  teal: "border-teal-600 bg-teal-500",
  cyan: "border-cyan-600 bg-cyan-500",
  sky: "border-sky-600 bg-sky-500",
  blue: "border-blue-600 bg-blue-500",
  indigo: "border-indigo-600 bg-indigo-500",
  violet: "border-violet-600 bg-violet-500",
  purple: "border-purple-600 bg-purple-500",
  fuchsia: "border-fuchsia-600 bg-fuchsia-500",
  pink: "border-pink-600 bg-pink-500",
};

type Configuration = {
  settings: TelemetrySettingsView;
  viewSettings: TelemetryViewSettingsView;
  presets: TelemetryColumnPresetView[];
  savedFilters: TelemetrySavedFilterView[];
  facets: TelemetryFacets;
  fields: string[];
};

type ClientSelectionRange = TelemetrySelectionRange & { key: string };

function serverSelectionRanges(
  ranges: ClientSelectionRange[],
): TelemetrySelectionRange[] {
  return ranges.map(({ startTime, endTime, includeSeparators }) => ({
    startTime,
    endTime,
    includeSeparators,
  }));
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function badgeClass(value: string) {
  const normalized = value.toLocaleLowerCase();
  if (["error", "fatal", "fault", "failed"].includes(normalized)) {
    return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
  }
  if (["warn", "warning", "notice"].includes(normalized)) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300";
  }
  if (["debug", "trace", "verbose"].includes(normalized)) {
    return "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300";
  }
  if (["info", "product", "analytics"].includes(normalized)) {
    return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
  }
  const palette = ["emerald", "violet", "cyan", "orange", "pink"];
  const index =
    [...normalized].reduce(
      (sum, character) => sum + character.charCodeAt(0),
      0,
    ) % palette.length;
  const color = palette[index]!;
  const classes: Record<string, string> = {
    emerald:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    violet:
      "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    cyan: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
    orange:
      "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
    pink: "border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300",
  };
  return classes[color];
}

function parameterValues(entry: TelemetryEntryView) {
  const defaults = flattenTelemetryObject(
    "defaultParameters",
    entry.defaultParameters,
  );
  const additional = flattenTelemetryObject(
    "additionalParameters",
    entry.additionalParameters,
  );
  return [...Object.entries(defaults), ...Object.entries(additional)];
}

function parameterSummary(entry: TelemetryEntryView) {
  return parameterValues(entry)
    .map(
      ([key, value]) =>
        `${key.replace(/^(default|additional)Parameters\.?/, "")}: ${display(value)}`,
    )
    .join(" • ");
}

function columnLabel(column: string, t: ReturnType<typeof useTranslations>) {
  const known: Record<string, string> = {
    time: t("columns.time"),
    source: t("columns.source"),
    level: t("columns.level"),
    category: t("columns.category"),
    message: t("columns.message"),
    buildId: t("columns.buildId"),
    sessionId: t("columns.sessionId"),
    deviceIp: t("columns.deviceIp"),
    receivedAt: t("columns.receivedAt"),
    attributes: t("columns.attributes"),
    eventKind: t("columns.kind"),
    levelKind: t("columns.levelKind"),
    eventName: t("columns.name"),
    screenName: t("columns.screenName"),
    parameters: t("columns.parameters"),
    defaultParameters: t("columns.defaultParameters"),
    additionalParameters: t("columns.additionalParameters"),
    detail: t("columns.detail"),
  };
  if (known[column]) return known[column];
  return column
    .replace(/^attributes[.[]/, `${t("columns.attribute")}: `)
    .replace(/^defaultParameters[.[]/, `${t("columns.defaultParameter")}: `)
    .replace(
      /^additionalParameters[.[]/,
      `${t("columns.additionalParameter")}: `,
    )
    .replace(/]$/g, "");
}

export function TelemetryPage({ view }: { view: TelemetryView }) {
  const t = useTranslations("telemetry");
  const locale = useLocale();
  const [configuration, setConfiguration] = useState<Configuration | null>(
    null,
  );
  const [entries, setEntries] = useState<TelemetryEntryView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [matchingCount, setMatchingCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<TelemetrySearchMode>("TEXT");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [quickFilters, setQuickFilters] = useState<Record<string, string[]>>(
    {},
  );
  const [advancedFilter, setAdvancedFilter] =
    useState<TelemetryFilterDefinition>({
      mode: "ALL",
      conditions: [],
    });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [selectionRanges, setSelectionRanges] = useState<
    ClientSelectionRange[]
  >([]);
  const [selectAll, setSelectAll] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [separatorOpen, setSeparatorOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmBefore, setConfirmBefore] = useState(false);
  const initializedConfiguration = useRef(false);

  const columns =
    configuration?.viewSettings.columns ?? DEFAULT_TELEMETRY_COLUMNS[view];
  const timeFormat = configuration?.viewSettings.timeFormat ?? "12";
  const queryInput = useMemo<TelemetryQueryInput>(
    () => ({
      view,
      first: 200,
      search: search || null,
      searchMode,
      caseSensitive,
      quickFilters,
      advancedFilter: advancedFilter.conditions.length ? advancedFilter : null,
    }),
    [advancedFilter, caseSensitive, quickFilters, search, searchMode, view],
  );

  const loadConfiguration = useCallback(async () => {
    const origin = window.location.origin;
    const data = await controlPlaneRequest<{
      telemetrySettings: TelemetrySettingsView;
      telemetryViewSettings: TelemetryViewSettingsView;
      telemetryColumnPresets: TelemetryColumnPresetView[];
      telemetrySavedFilters: TelemetrySavedFilterView[];
      telemetryFacets: TelemetryFacets;
      telemetryFields: string[];
    }>(
      `query TelemetryConfiguration($view: TelemetryView!, $origin: String) {
        telemetrySettings(requestOrigin: $origin) {
          localBaseUrlOverride remoteBaseUrlOverride consoleCollectionEnabled
          analyticsCollectionEnabled detectedLocalBaseUrl detectedRemoteBaseUrl
          effectiveLocalBaseUrl effectiveRemoteBaseUrl updatedAt
        }
        telemetryViewSettings(view: $view) {
          view columns timeFormat activeColumnPresetId activeSavedFilterId
        }
        telemetryColumnPresets(view: $view) {
          id view name columns isDefault createdAt updatedAt
        }
        telemetrySavedFilters(view: $view) {
          id view name definition createdAt updatedAt
        }
        telemetryFacets(view: $view)
        telemetryFields(view: $view)
      }`,
      { view, origin },
    );
    setConfiguration({
      settings: data.telemetrySettings,
      viewSettings: data.telemetryViewSettings,
      presets: data.telemetryColumnPresets,
      savedFilters: data.telemetrySavedFilters,
      facets: data.telemetryFacets,
      fields: data.telemetryFields,
    });
    if (!initializedConfiguration.current) {
      initializedConfiguration.current = true;
      const active = data.telemetrySavedFilters.find(
        (filter) =>
          filter.id === data.telemetryViewSettings.activeSavedFilterId,
      );
      if (active) setAdvancedFilter(active.definition);
    }
  }, [view]);

  const loadTimeline = useCallback(
    async (append = false, reconcile = false) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const input = { ...queryInput, after: append ? nextCursor : null };
        const data = await controlPlaneRequest<{
          telemetryTimeline: TelemetryTimelinePage;
        }>(
          `query TelemetryTimeline($input: TelemetryTimelineInput!) {
            telemetryTimeline(input: $input) {
              items { ${ENTRY_FIELDS} }
              nextCursor matchingCount totalCount
            }
          }`,
          { input },
        );
        const page = data.telemetryTimeline;
        setEntries((current) => {
          if (append) {
            return [
              ...current,
              ...page.items.filter(
                (item) => !current.some((existing) => existing.id === item.id),
              ),
            ];
          }
          if (!reconcile || current.length === 0) return page.items;
          const newestIds = new Set(page.items.map(({ id }) => id));
          return [
            ...page.items,
            ...current.filter((item) => !newestIds.has(item.id)),
          ].sort((left, right) => {
            const time = right.clientTime.localeCompare(left.clientTime);
            if (time) return time;
            const received = right.receivedAt.localeCompare(left.receivedAt);
            return received || right.id.localeCompare(left.id);
          });
        });
        if (!reconcile) setNextCursor(page.nextCursor);
        setMatchingCount(page.matchingCount);
        setTotalCount(page.totalCount);
        setError(null);
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
      } finally {
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [nextCursor, queryInput],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfiguration().catch((value) =>
        setError(value instanceof Error ? value.message : String(value)),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadConfiguration]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTimeline(false), 180);
    return () => window.clearTimeout(timer);
  }, [queryInput]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const subscriptions = controlPlaneSubscriptions();
    const unsubscribeEntries = subscriptions.subscribe<{
      telemetryEntriesChanged: { ids: string[]; reason: string };
    }>(
      { query: "subscription { telemetryEntriesChanged { ids reason } }" },
      {
        next: (payload) => {
          const change = payload.data?.telemetryEntriesChanged;
          void loadTimeline(false, !change?.reason.startsWith("CLEARED"));
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const unsubscribeSettings = subscriptions.subscribe<{
      telemetrySettingsChanged: unknown;
    }>(
      { query: "subscription { telemetrySettingsChanged { updatedAt } }" },
      {
        next: () => void loadConfiguration(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const visible = () => {
      if (document.visibilityState === "visible")
        void loadTimeline(false, true);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      unsubscribeEntries();
      unsubscribeSettings();
      document.removeEventListener("visibilitychange", visible);
    };
  }, [loadConfiguration, loadTimeline]);

  const refresh = async () => {
    await Promise.all([loadTimeline(false), loadConfiguration()]);
  };

  const saveViewSettings = async (
    input: Partial<TelemetryViewSettingsView>,
  ) => {
    const data = await controlPlaneRequest<{
      saveTelemetryViewSettings: TelemetryViewSettingsView;
    }>(
      `mutation SaveTelemetryViewSettings($input: SaveTelemetryViewSettingsInput!) {
        saveTelemetryViewSettings(input: $input) {
          view columns timeFormat activeColumnPresetId activeSavedFilterId
        }
      }`,
      { input: { view, ...input } },
    );
    setConfiguration((current) =>
      current
        ? { ...current, viewSettings: data.saveTelemetryViewSettings }
        : current,
    );
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelected = (ids: string[], checked: boolean) => {
    setSelectAll(false);
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setExcluded((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const rangeContains = (
    range: TelemetrySelectionRange,
    entry: TelemetryEntryView,
  ) => {
    if (entry.entryType === "SEPARATOR" && !range.includeSeparators)
      return false;
    const time = Date.parse(entry.clientTime);
    return (
      (!range.startTime || time >= Date.parse(range.startTime)) &&
      (!range.endTime || time < Date.parse(range.endTime))
    );
  };

  const isSelected = (entry: TelemetryEntryView) =>
    !excluded.has(entry.id) &&
    (selectAll ||
      selected.has(entry.id) ||
      selectionRanges.some((range) => rangeContains(range, entry)));

  const toggleRange = (range: ClientSelectionRange, checked: boolean) => {
    setSelectAll(false);
    setSelectionRanges((current) =>
      checked
        ? [...current.filter((item) => item.key !== range.key), range]
        : current.filter((item) => item.key !== range.key),
    );
    const loadedIds = entries
      .filter((entry) => rangeContains(range, entry))
      .map(({ id }) => id);
    setExcluded((current) => {
      const next = new Set(current);
      for (const id of loadedIds) {
        if (checked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    if (!checked) {
      setSelected((current) => {
        const next = new Set(current);
        for (const id of loadedIds) next.delete(id);
        return next;
      });
    }
  };

  const addColumn = (column: string) => {
    if (columns.includes(column)) return;
    void saveViewSettings({ columns: [...columns, column] }).catch((value) =>
      setError(value instanceof Error ? value.message : String(value)),
    );
  };

  const filterByValue = (field: string, value: string) => {
    const filterValue =
      field === "source" &&
      ["console", "analytics"].includes(value.toLowerCase())
        ? value.toUpperCase()
        : value;
    if (
      Object.prototype.hasOwnProperty.call(configuration?.facets ?? {}, field)
    ) {
      setQuickFilters((current) => ({ ...current, [field]: [filterValue] }));
      return;
    }
    setAdvancedFilter((current) => ({
      ...current,
      conditions: [
        ...current.conditions,
        { field, operator: "IS", value: filterValue, caseSensitive: true },
      ],
    }));
    setFilterOpen(true);
  };

  const updateHighlight = async (
    entry: TelemetryEntryView,
    color: string | null,
  ) => {
    const data = await controlPlaneRequest<{
      updateTelemetryHighlight: TelemetryEntryView;
    }>(
      `mutation UpdateTelemetryHighlight($id: ID!, $color: String) {
        updateTelemetryHighlight(id: $id, color: $color) { ${ENTRY_FIELDS} }
      }`,
      { id: entry.id, color },
    );
    setEntries((current) =>
      current.map((item) =>
        item.id === entry.id ? data.updateTelemetryHighlight : item,
      ),
    );
  };

  const clearSelected = async () => {
    const rangedSelection: TelemetrySelection = {
      ids: [...selected],
      excludedIds: [...excluded],
      query: queryInput,
      ranges: serverSelectionRanges(selectionRanges),
    };
    await controlPlaneRequest(
      `mutation ClearSelectedTelemetry($selection: JSON!) {
        clearSelectedTelemetry(selection: $selection)
      }`,
      {
        selection: selectAll
          ? { query: queryInput, includeSeparators: true }
          : selectionRanges.length
            ? rangedSelection
            : { ids: [...selected] },
      },
    );
    setSelected(new Set());
    setExcluded(new Set());
    setSelectionRanges([]);
    setSelectAll(false);
    await refresh();
  };

  const clearAll = async (includeSeparators: boolean) => {
    await controlPlaneRequest(
      `mutation ClearTelemetry($view: TelemetryView!, $include: Boolean!) {
        clearTelemetry(view: $view, includeSeparators: $include)
      }`,
      { view, include: includeSeparators },
    );
    setConfirmClear(false);
    await refresh();
  };

  const clearBefore = async () => {
    await controlPlaneRequest(
      `mutation ClearBefore($view: TelemetryView!) {
        clearTelemetryBeforeLatestSeparator(view: $view)
      }`,
      { view },
    );
    setConfirmBefore(false);
    await refresh();
  };

  const titleKey =
    view === "CONSOLE"
      ? "consoleTitle"
      : view === "ANALYTICS"
        ? "analyticsTitle"
        : "unifiedTitle";
  const descriptionKey =
    view === "CONSOLE"
      ? "consoleDescription"
      : view === "ANALYTICS"
        ? "analyticsDescription"
        : "unifiedDescription";
  const loadedSelectedCount = entries.filter(isSelected).length;
  const exportSelection: TelemetrySelection | null = selectAll
    ? { query: queryInput, includeSeparators: true }
    : selectionRanges.length
      ? {
          ids: [...selected],
          excludedIds: [...excluded],
          query: queryInput,
          ranges: serverSelectionRanges(selectionRanges),
        }
      : selected.size
        ? { ids: [...selected] }
        : null;

  return (
    <section className="mx-auto flex w-full max-w-[1900px] flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t(titleKey)}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(descriptionKey)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {configuration && (
            <CollectionControls
              onChanged={(settings) =>
                setConfiguration((current) =>
                  current ? { ...current, settings } : current,
                )
              }
              settings={configuration.settings}
              view={view}
            />
          )}
          <Button
            onClick={() => setSeparatorOpen(true)}
            size="sm"
            variant="outline"
          >
            <Plus /> {t("separator")}
          </Button>
          <Button
            onClick={() => setSettingsOpen(true)}
            size="icon-sm"
            title={t("settings")}
            variant="outline"
          >
            <Settings />
          </Button>
          <Button
            disabled={loading}
            onClick={() => void refresh()}
            size="icon-sm"
            title={t("refresh")}
            variant="outline"
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card className="gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-64 flex-1 items-center gap-1 rounded-lg border bg-background pl-2">
            <Search className="size-4 text-muted-foreground" />
            <Input
              aria-label={t("search")}
              className="border-0 shadow-none focus-visible:ring-0"
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("searchPlaceholder")}
              value={search}
            />
            <Select
              onValueChange={(value) =>
                setSearchMode(value as TelemetrySearchMode)
              }
              value={searchMode}
            >
              <SelectTrigger
                aria-label={t("searchMode")}
                className="w-28 border-0 shadow-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TEXT">{t("searchModes.text")}</SelectItem>
                <SelectItem value="GLOB">{t("searchModes.glob")}</SelectItem>
                <SelectItem value="REGEX">{t("searchModes.regex")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={caseSensitive}
              onCheckedChange={(checked) => setCaseSensitive(Boolean(checked))}
            />
            {t("caseSensitive")}
          </label>
          <Button
            onClick={() => setFilterOpen(true)}
            size="sm"
            variant={advancedFilter.conditions.length ? "default" : "outline"}
          >
            <Filter /> {t("filters")}
            {advancedFilter.conditions.length > 0 && (
              <Badge>{advancedFilter.conditions.length}</Badge>
            )}
          </Button>
          <Button
            onClick={() => setColumnsOpen(true)}
            size="sm"
            variant="outline"
          >
            <Columns3 /> {t("columnsAction")}
          </Button>
          <Button
            onClick={() => setExportOpen(true)}
            size="sm"
            variant="outline"
          >
            <Download /> {t("export")}
          </Button>
          <Button
            onClick={() => setEditMode((current) => !current)}
            size="sm"
            variant={editMode ? "default" : "outline"}
          >
            {editMode ? <X /> : <ListFilter />}{" "}
            {editMode ? t("done") : t("edit")}
          </Button>
          <Tabs
            onValueChange={(value) =>
              void saveViewSettings({ timeFormat: value as "12" | "24" })
            }
            value={timeFormat}
          >
            <TabsList>
              <TabsTrigger value="12">12h</TabsTrigger>
              <TabsTrigger value="24">24h</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {QUICK_FIELDS[view].map((field) => (
              <QuickFilter
                field={field}
                key={field}
                label={columnLabel(field, t)}
                onChange={(values) =>
                  setQuickFilters((current) => ({
                    ...current,
                    [field]: values,
                  }))
                }
                selected={quickFilters[field] ?? []}
                values={facetValues(configuration?.facets ?? {}, field)}
              />
            ))}
          </div>
          <p className="text-xs tabular-nums text-muted-foreground">
            {t("count", { matching: matchingCount, total: totalCount })}
          </p>
        </div>

        {editMode && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2">
            <span className="text-xs text-muted-foreground">
              {selectAll
                ? t("allResultsSelected")
                : t("selectedCount", { count: loadedSelectedCount })}
            </span>
            <Button
              disabled={!exportSelection}
              onClick={() => void clearSelected()}
              size="sm"
              variant="destructive"
            >
              <Trash2 /> {t("clearSelected")}
            </Button>
            {confirmClear ? (
              <>
                <Button
                  onClick={() => void clearAll(false)}
                  size="sm"
                  variant="destructive"
                >
                  {t("confirmClearRecords")}
                </Button>
                <Button
                  onClick={() => void clearAll(true)}
                  size="sm"
                  variant="destructive"
                >
                  {t("confirmClearWithSeparators")}
                </Button>
                <Button
                  onClick={() => setConfirmClear(false)}
                  size="sm"
                  variant="outline"
                >
                  {t("cancel")}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setConfirmClear(true)}
                size="sm"
                variant="outline"
              >
                {t("clearAll")}
              </Button>
            )}
            {confirmBefore ? (
              <>
                <Button
                  onClick={() => void clearBefore()}
                  size="sm"
                  variant="destructive"
                >
                  {t("confirmClearBefore")}
                </Button>
                <Button
                  onClick={() => setConfirmBefore(false)}
                  size="sm"
                  variant="outline"
                >
                  {t("cancel")}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setConfirmBefore(true)}
                size="sm"
                variant="outline"
              >
                {t("clearBeforeSeparator")}
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card className="gap-0 overflow-hidden py-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {editMode && (
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label={t("selectAll")}
                      checked={
                        selectAll ||
                        (entries.length > 0 &&
                          entries.every((entry) => isSelected(entry)))
                      }
                      onCheckedChange={(checked) => {
                        const value = Boolean(checked);
                        setSelectAll(value);
                        setSelected(
                          value
                            ? new Set(entries.map(({ id }) => id))
                            : new Set(),
                        );
                        setExcluded(new Set());
                        setSelectionRanges([]);
                      }}
                    />
                  </TableHead>
                )}
                <TableHead className="w-10">
                  <span className="sr-only">{t("expand")}</span>
                </TableHead>
                {columns.map((column) => (
                  <TableHead key={column}>{columnLabel(column, t)}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length + (editMode ? 2 : 1)}>
                    <span className="flex items-center gap-2 py-8 text-muted-foreground">
                      <Spinner /> {t("loading")}
                    </span>
                  </TableCell>
                </TableRow>
              ) : entries.length === 0 ? (
                <TableRow>
                  <TableCell
                    className="py-12 text-center text-muted-foreground"
                    colSpan={columns.length + (editMode ? 2 : 1)}
                  >
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : (
                entries.map((entry, index) => {
                  const day = localDay(entry.clientTime);
                  const showDay =
                    index === 0 ||
                    localDay(entries[index - 1]!.clientTime) !== day;
                  const dayRange = localDayRange(entry.clientTime);
                  const dayKey = `day:${day}`;
                  const dayChecked = selectionRanges.some(
                    (range) => range.key === dayKey,
                  );
                  if (entry.entryType === "SEPARATOR") {
                    const newerSeparator = entries
                      .slice(0, index)
                      .findLast((item) => item.entryType === "SEPARATOR");
                    const separatorKey = `separator:${entry.id}`;
                    const separatorRange: ClientSelectionRange = {
                      key: separatorKey,
                      startTime: entry.clientTime,
                      endTime: newerSeparator?.clientTime ?? null,
                      includeSeparators: false,
                    };
                    const checked =
                      selected.has(entry.id) &&
                      selectionRanges.some(
                        (range) => range.key === separatorKey,
                      );
                    return (
                      <Fragment key={entry.id}>
                        {showDay && (
                          <DayRow
                            checked={dayChecked}
                            colSpan={columns.length + 2}
                            day={formatDay(entry.clientTime, locale)}
                            editMode={editMode}
                            onChecked={(value) =>
                              toggleRange(
                                {
                                  key: dayKey,
                                  ...dayRange,
                                  includeSeparators: true,
                                },
                                value,
                              )
                            }
                          />
                        )}
                        <TableRow className="bg-muted/40 hover:bg-muted/50">
                          {editMode && (
                            <TableCell>
                              <Checkbox
                                aria-label={t("selectSeparator", {
                                  name: entry.separatorName || t("separator"),
                                })}
                                checked={checked}
                                onCheckedChange={(value) =>
                                  (() => {
                                    const next = Boolean(value);
                                    toggleSelected([entry.id], next);
                                    toggleRange(separatorRange, next);
                                  })()
                                }
                              />
                            </TableCell>
                          )}
                          <TableCell
                            colSpan={columns.length + 1}
                            className="py-2 text-xs font-medium text-muted-foreground"
                          >
                            <span className="flex items-center gap-2">
                              <span className="h-px flex-1 bg-border" />
                              {entry.separatorName || t("separator")}
                              {entry.separatorKind === "BUILD" &&
                              entry.buildId ? (
                                <Badge>{entry.buildId}</Badge>
                              ) : null}
                              <span className="h-px flex-1 bg-border" />
                            </span>
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  }
                  return (
                    <Fragment key={entry.id}>
                      {showDay && (
                        <DayRow
                          checked={dayChecked}
                          colSpan={columns.length + 2}
                          day={formatDay(entry.clientTime, locale)}
                          editMode={editMode}
                          onChecked={(value) =>
                            toggleRange(
                              {
                                key: dayKey,
                                ...dayRange,
                                includeSeparators: true,
                              },
                              value,
                            )
                          }
                        />
                      )}
                      <TelemetryRow
                        addColumn={addColumn}
                        columns={columns}
                        editMode={editMode}
                        entry={entry}
                        expanded={expanded.has(entry.id)}
                        filterByValue={filterByValue}
                        locale={locale}
                        onHighlight={(color) =>
                          void updateHighlight(entry, color)
                        }
                        onSelected={(value) =>
                          toggleSelected([entry.id], value)
                        }
                        onToggle={() => toggleExpanded(entry.id)}
                        selected={isSelected(entry)}
                        t={t}
                        timeFormat={timeFormat}
                        view={view}
                      />
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {nextCursor && (
        <Button
          disabled={loadingMore}
          onClick={() => void loadTimeline(true)}
          variant="outline"
        >
          {loadingMore && <Spinner />} {t("loadMore")}
        </Button>
      )}

      {configuration && (
        <>
          <AdvancedFilterSheet
            definition={advancedFilter}
            fields={configuration.fields}
            key={`filters:${filterOpen}:${advancedFilter.conditions.length}`}
            onApplied={setAdvancedFilter}
            onConfiguration={setConfiguration}
            onOpenChange={setFilterOpen}
            onSaveViewSettings={saveViewSettings}
            open={filterOpen}
            savedFilters={configuration.savedFilters}
            view={view}
          />
          <ColumnsDialog
            allFields={[
              ...new Set([...BASE_COLUMNS[view], ...configuration.fields]),
            ]}
            columns={columns}
            configuration={configuration}
            key={`columns:${columnsOpen}:${columns.join("|")}`}
            onConfiguration={setConfiguration}
            onOpenChange={setColumnsOpen}
            onSave={saveViewSettings}
            open={columnsOpen}
            view={view}
          />
          <SettingsDialog
            key={`settings:${settingsOpen}:${configuration.settings.updatedAt}`}
            onOpenChange={setSettingsOpen}
            onSaved={(settings) =>
              setConfiguration((current) =>
                current ? { ...current, settings } : current,
              )
            }
            open={settingsOpen}
            settings={configuration.settings}
          />
          <SeparatorDialog
            onAdded={() => void refresh()}
            onOpenChange={setSeparatorOpen}
            open={separatorOpen}
          />
          <ExportDialog
            availableFields={configuration.fields}
            columns={columns}
            key={`export:${exportOpen}:${columns.join("|")}`}
            locale={locale}
            onOpenChange={setExportOpen}
            open={exportOpen}
            query={queryInput}
            selection={exportSelection}
            selectedCount={selectAll ? matchingCount : loadedSelectedCount}
            timeFormat={timeFormat}
            view={view}
          />
        </>
      )}
    </section>
  );
}

function localDay(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function localDayRange(value: string): TelemetrySelectionRange {
  const date = new Date(value);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { startTime: start.toISOString(), endTime: end.toISOString() };
}

function formatDay(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(
    new Date(value),
  );
}

function formatTime(
  value: string,
  locale: string,
  format: "12" | "24",
  date = false,
) {
  return new Intl.DateTimeFormat(locale, {
    ...(date ? { dateStyle: "medium" as const } : {}),
    timeStyle: "medium",
    hour12: format === "12",
  }).format(new Date(value));
}

function facetValues(facets: TelemetryFacets, field: string) {
  if (field === "levelKind") {
    return [
      ...new Set([...(facets.level ?? []), ...(facets.eventKind ?? [])]),
    ].sort();
  }
  return facets[field] ?? [];
}

function QuickFilter({
  field,
  label,
  values,
  selected,
  onChange,
}: {
  field: string;
  label: string;
  values: string[];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const t = useTranslations("telemetry");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant={selected.length ? "default" : "outline"}>
          {label}
          {selected.length > 0 && <Badge>{selected.length}</Badge>}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {selected.length > 0 && (
          <DropdownMenuItem onSelect={() => onChange([])}>
            <X /> {t("clearValues")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {values.length ? (
          values.map((value) => (
            <DropdownMenuCheckboxItem
              checked={selected.includes(value)}
              key={`${field}:${value}`}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, value]
                    : selected.filter((item) => item !== value),
                )
              }
            >
              <span className="truncate" title={value}>
                {value}
              </span>
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuItem disabled>{t("noValues")}</DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DayRow({
  day,
  editMode,
  checked,
  onChecked,
  colSpan,
}: {
  day: string;
  editMode: boolean;
  checked: boolean;
  onChecked: (value: boolean) => void;
  colSpan: number;
}) {
  const t = useTranslations("telemetry");
  return (
    <TableRow className="bg-muted/20 hover:bg-muted/20">
      {editMode && (
        <TableCell className="py-1.5">
          <Checkbox
            aria-label={t("selectDay", { day })}
            checked={checked}
            onCheckedChange={(value) => onChecked(Boolean(value))}
          />
        </TableCell>
      )}
      <TableCell
        className="py-1.5 text-xs text-muted-foreground"
        colSpan={colSpan - (editMode ? 1 : 0)}
      >
        {day}
      </TableCell>
    </TableRow>
  );
}

function TelemetryRow({
  entry,
  columns,
  expanded,
  selected,
  editMode,
  locale,
  timeFormat,
  view,
  onToggle,
  onSelected,
  onHighlight,
  addColumn,
  filterByValue,
  t,
}: {
  entry: TelemetryEntryView;
  columns: string[];
  expanded: boolean;
  selected: boolean;
  editMode: boolean;
  locale: string;
  timeFormat: "12" | "24";
  view: TelemetryView;
  onToggle: () => void;
  onSelected: (value: boolean) => void;
  onHighlight: (color: string | null) => void;
  addColumn: (column: string) => void;
  filterByValue: (field: string, value: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <>
      <TableRow
        className={cn(
          "cursor-pointer",
          entry.highlightColor && HIGHLIGHT_CLASSES[entry.highlightColor],
        )}
        onClick={onToggle}
      >
        {editMode && (
          <TableCell onClick={(event) => event.stopPropagation()}>
            <Checkbox
              aria-label={t("selectRow")}
              checked={selected}
              onCheckedChange={(value) => onSelected(Boolean(value))}
            />
          </TableCell>
        )}
        <TableCell className="pr-0">
          <Button
            aria-expanded={expanded}
            aria-label={expanded ? t("collapse") : t("expand")}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            size="icon-sm"
            variant="ghost"
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </Button>
        </TableCell>
        {columns.map((column) => {
          const value = cellValue(entry, column, locale, timeFormat);
          return (
            <TableCell
              className={cn(
                ["message", "detail", "parameters"].includes(column) &&
                  "max-w-[36rem] whitespace-normal",
              )}
              key={column}
            >
              <ValueContext
                field={column}
                filterByValue={filterByValue}
                label={columnLabel(column, t)}
                value={value}
              >
                {column === "level" ||
                column === "eventKind" ||
                column === "levelKind" ||
                column === "source" ? (
                  value ? (
                    <Badge className={badgeClass(value)}>{value}</Badge>
                  ) : (
                    "—"
                  )
                ) : (
                  <span
                    className={cn(
                      ["message", "detail", "parameters"].includes(column) &&
                        "line-clamp-2",
                    )}
                  >
                    {value || "—"}
                  </span>
                )}
              </ValueContext>
            </TableCell>
          );
        })}
      </TableRow>
      {expanded && (
        <TableRow
          className={cn(
            "hover:bg-muted/20",
            entry.highlightColor && HIGHLIGHT_CLASSES[entry.highlightColor],
          )}
        >
          <TableCell
            className="p-0"
            colSpan={columns.length + (editMode ? 2 : 1)}
          >
            <ExpandedEntry
              addColumn={addColumn}
              entry={entry}
              filterByValue={filterByValue}
              locale={locale}
              onHighlight={onHighlight}
              t={t}
              timeFormat={timeFormat}
              view={view}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function cellValue(
  entry: TelemetryEntryView,
  column: string,
  locale: string,
  timeFormat: "12" | "24",
) {
  if (column === "time")
    return formatTime(entry.clientTime, locale, timeFormat);
  if (column === "receivedAt")
    return formatTime(entry.receivedAt, locale, timeFormat, true);
  if (column === "source")
    return entry.entryType === "CONSOLE" ? "Console" : "Analytics";
  if (column === "levelKind") return entry.level ?? entry.eventKind ?? "";
  if (column === "parameters") return parameterSummary(entry);
  if (column === "detail") {
    return entry.entryType === "CONSOLE"
      ? (entry.message ?? "")
      : `${entry.eventName ?? ""}${entry.screenName ? ` (${entry.screenName})` : ""}${parameterSummary(entry) ? ` — ${parameterSummary(entry)}` : ""}`;
  }
  return display(telemetryFields(entry)[column]);
}

function ValueContext({
  field,
  label,
  value,
  filterByValue,
  children,
}: {
  field: string;
  label: string;
  value: string;
  filterByValue: (field: string, value: string) => void;
  children: ReactNode;
}) {
  const t = useTranslations("telemetry");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copyText(`${label}: ${value}`)}>
          <Clipboard /> {t("copyColumnValue", { label })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyText(value)}>
          <Clipboard /> {t("copyValue")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={!value}
          onSelect={() => filterByValue(field, value)}
        >
          <Filter /> {t("filterByValue")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ExpandedEntry({
  entry,
  locale,
  timeFormat,
  onHighlight,
  addColumn,
  filterByValue,
  t,
}: {
  entry: TelemetryEntryView;
  locale: string;
  timeFormat: "12" | "24";
  view: TelemetryView;
  onHighlight: (color: string | null) => void;
  addColumn: (column: string) => void;
  filterByValue: (field: string, value: string) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const metadata = [
    [t("columns.time"), formatTime(entry.clientTime, locale, timeFormat, true)],
    [
      t("columns.receivedAt"),
      formatTime(entry.receivedAt, locale, timeFormat, true),
    ],
    [t("columns.deviceIp"), entry.deviceIp ?? "—"],
    [t("columns.buildId"), entry.buildId ?? "—"],
    [t("columns.sessionId"), entry.sessionId ?? "—"],
    ...(entry.entryType === "CONSOLE"
      ? [
          [t("columns.level"), entry.level ?? "—"],
          [t("columns.category"), entry.category ?? "—"],
        ]
      : [
          [t("columns.kind"), entry.eventKind ?? "—"],
          [t("columns.name"), entry.eventName ?? "—"],
          [t("columns.screenName"), entry.screenName ?? "—"],
        ]),
  ];
  return (
    <div className="space-y-4 border-t bg-muted/15 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            {entry.entryType === "CONSOLE"
              ? t("columns.message")
              : t("columns.detail")}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words">
            {entry.entryType === "CONSOLE"
              ? entry.message
              : `${entry.eventName} (${entry.screenName})`}
          </p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("highlight")}
          </p>
          <ToggleGroup
            onValueChange={(value) =>
              value && onHighlight(value === "none" ? null : value)
            }
            size="sm"
            spacing={1}
            type="single"
            value={entry.highlightColor ?? "none"}
            variant="outline"
          >
            <ToggleGroupItem
              aria-label={t("clearHighlight")}
              className="size-7 p-0"
              value="none"
            >
              <X className="size-3" />
            </ToggleGroupItem>
            {TELEMETRY_COLORS.map((color) => (
              <ToggleGroupItem
                aria-label={color}
                className={cn("size-7 p-0", SWATCH_CLASSES[color])}
                key={color}
                value={color}
              />
            ))}
          </ToggleGroup>
        </div>
      </div>
      <dl className="grid gap-3 rounded-lg border bg-background/70 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        {metadata.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 break-all font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {entry.entryType === "CONSOLE" ? (
        <DictionaryBlock
          addColumn={addColumn}
          filterByValue={filterByValue}
          label={t("columns.attributes")}
          prefix="attributes"
          value={entry.attributes}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <DictionaryBlock
            addColumn={addColumn}
            filterByValue={filterByValue}
            label={t("columns.defaultParameters")}
            prefix="defaultParameters"
            value={entry.defaultParameters}
          />
          <DictionaryBlock
            addColumn={addColumn}
            filterByValue={filterByValue}
            label={t("columns.additionalParameters")}
            prefix="additionalParameters"
            value={entry.additionalParameters}
          />
        </div>
      )}
    </div>
  );
}

function DictionaryBlock({
  label,
  prefix,
  value,
  addColumn,
  filterByValue,
}: {
  label: string;
  prefix: string;
  value: Record<string, unknown>;
  addColumn: (column: string) => void;
  filterByValue: (field: string, value: string) => void;
}) {
  const t = useTranslations("telemetry");
  const fields = flattenTelemetryObject(prefix, value);
  const lines = Object.entries(fields)
    .map(([key, item]) => `${key}: ${display(item)}`)
    .join("\n");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <section className="rounded-lg border bg-background/70 p-3">
          <h3 className="mb-2 text-sm font-semibold">{label}</h3>
          {Object.keys(fields).length === 0 ? (
            <p className="text-xs text-muted-foreground">—</p>
          ) : (
            <dl className="space-y-1 text-xs">
              {Object.entries(fields).map(([key, item]) => {
                const text = display(item);
                return (
                  <ParameterContext
                    field={key}
                    filterByValue={filterByValue}
                    key={key}
                    value={text}
                  >
                    <dt className="min-w-0 flex-1 break-all font-mono text-muted-foreground">
                      {key}
                    </dt>
                    <dd className="max-w-[55%] break-all text-right">{text}</dd>
                    <Button
                      aria-label={t("addColumn", { key })}
                      className="size-6 opacity-60 group-hover:opacity-100"
                      onClick={() => addColumn(key)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Plus className="size-3" />
                    </Button>
                    <Button
                      aria-label={t("filterParameter", { key })}
                      className="size-6 opacity-60 group-hover:opacity-100"
                      onClick={() => filterByValue(key, text)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Filter className="size-3" />
                    </Button>
                  </ParameterContext>
                );
              })}
            </dl>
          )}
        </section>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => void copyText(JSON.stringify(value, null, 2))}
        >
          <Clipboard /> {t("copyJsonDictionary")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyText(lines)}>
          <Clipboard /> {t("copyPathValues")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ParameterContext({
  field,
  value,
  filterByValue,
  children,
}: {
  field: string;
  value: string;
  filterByValue: (field: string, value: string) => void;
  children: ReactNode;
}) {
  const t = useTranslations("telemetry");
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="group flex items-start gap-2">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copyText(`${field}: ${value}`)}>
          <Clipboard /> {t("copyParameterValue", { key: field })}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyText(value)}>
          <Clipboard /> {t("copyValue")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => filterByValue(field, value)}>
          <Filter /> {t("filterByValue")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CollectionControls({
  view,
  settings,
  onChanged,
}: {
  view: TelemetryView;
  settings: TelemetrySettingsView;
  onChanged: (settings: TelemetrySettingsView) => void;
}) {
  const t = useTranslations("telemetry");
  const [busy, setBusy] = useState(false);
  const save = async (consoleEnabled: boolean, analyticsEnabled: boolean) => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveTelemetrySettings: TelemetrySettingsView;
      }>(
        `mutation CollectionSettings($input: SaveTelemetrySettingsInput!, $origin: String) {
          saveTelemetrySettings(input: $input, requestOrigin: $origin) {
            localBaseUrlOverride remoteBaseUrlOverride consoleCollectionEnabled
            analyticsCollectionEnabled detectedLocalBaseUrl detectedRemoteBaseUrl
            effectiveLocalBaseUrl effectiveRemoteBaseUrl updatedAt
          }
        }`,
        {
          input: {
            consoleCollectionEnabled: consoleEnabled,
            analyticsCollectionEnabled: analyticsEnabled,
          },
          origin: window.location.origin,
        },
      );
      onChanged(data.saveTelemetrySettings);
    } finally {
      setBusy(false);
    }
  };
  const consoleOn = settings.consoleCollectionEnabled;
  const analyticsOn = settings.analyticsCollectionEnabled;
  const button = (label: string, active: boolean, onClick: () => void) => (
    <Button
      disabled={busy}
      onClick={onClick}
      size="sm"
      variant={active ? "default" : "outline"}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          active ? "bg-emerald-300" : "bg-muted-foreground",
        )}
      />
      {label} {active ? t("on") : t("off")}
    </Button>
  );
  if (view === "CONSOLE") {
    return button(
      t("consoleCollection"),
      consoleOn,
      () => void save(!consoleOn, analyticsOn),
    );
  }
  if (view === "ANALYTICS") {
    return button(
      t("analyticsCollection"),
      analyticsOn,
      () => void save(consoleOn, !analyticsOn),
    );
  }
  return (
    <div className="flex flex-wrap gap-1 rounded-lg border p-1">
      {button(t("allCollection"), consoleOn && analyticsOn, () => {
        const next = !(consoleOn && analyticsOn);
        void save(next, next);
      })}
      {button(
        t("consoleCollection"),
        consoleOn,
        () => void save(!consoleOn, analyticsOn),
      )}
      {button(
        t("analyticsCollection"),
        analyticsOn,
        () => void save(consoleOn, !analyticsOn),
      )}
    </div>
  );
}

function AdvancedFilterSheet({
  open,
  onOpenChange,
  view,
  fields,
  definition,
  onApplied,
  savedFilters,
  onConfiguration,
  onSaveViewSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: TelemetryView;
  fields: string[];
  definition: TelemetryFilterDefinition;
  onApplied: (definition: TelemetryFilterDefinition) => void;
  savedFilters: TelemetrySavedFilterView[];
  onConfiguration: React.Dispatch<React.SetStateAction<Configuration | null>>;
  onSaveViewSettings: (
    input: Partial<TelemetryViewSettingsView>,
  ) => Promise<void>;
}) {
  const t = useTranslations("telemetry");
  const [draft, setDraft] = useState(definition);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const update = (index: number, patch: Partial<TelemetryFilterCondition>) => {
    setLoadedId(null);
    setDraft((current) => ({
      ...current,
      conditions: current.conditions.map((condition, candidate) =>
        candidate === index ? { ...condition, ...patch } : condition,
      ),
    }));
  };
  const add = () => {
    setLoadedId(null);
    setDraft((current) => ({
      ...current,
      conditions: [
        ...current.conditions,
        {
          field: fields[0] ?? "message",
          operator: "CONTAINS",
          value: "",
          caseSensitive: false,
          sources: view === "UNIFIED" ? ["CONSOLE", "ANALYTICS"] : undefined,
        },
      ],
    }));
  };
  const save = async () => {
    setBusy(true);
    try {
      const data = await controlPlaneRequest<{
        saveTelemetryFilter: TelemetrySavedFilterView;
      }>(
        `mutation SaveTelemetryFilter($input: SaveTelemetryFilterInput!) {
          saveTelemetryFilter(input: $input) { id view name definition createdAt updatedAt }
        }`,
        { input: { id: editingId, view, name, definition: draft } },
      );
      onConfiguration((current) =>
        current
          ? {
              ...current,
              savedFilters: [
                ...current.savedFilters.filter(
                  (filter) => filter.id !== data.saveTelemetryFilter.id,
                ),
                data.saveTelemetryFilter,
              ].sort((left, right) => left.name.localeCompare(right.name)),
            }
          : current,
      );
      setName("");
      setEditingId(null);
      setLoadedId(data.saveTelemetryFilter.id);
    } finally {
      setBusy(false);
    }
  };
  const removeSaved = async (id: string) => {
    await controlPlaneRequest(
      `mutation DeleteTelemetryFilter($id: ID!) { deleteTelemetryFilter(id: $id) }`,
      { id },
    );
    onConfiguration((current) =>
      current
        ? {
            ...current,
            savedFilters: current.savedFilters.filter(
              (filter) => filter.id !== id,
            ),
          }
        : current,
    );
    if (editingId === id) {
      setEditingId(null);
      setName("");
    }
    if (loadedId === id) setLoadedId(null);
  };
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-[min(46rem,95vw)] overflow-y-auto sm:max-w-3xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{t("advancedFilters")}</SheetTitle>
          <SheetDescription>{t("advancedFiltersDescription")}</SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          <div className="flex items-center gap-3">
            <Label>{t("match")}</Label>
            <Select
              onValueChange={(value) => {
                setLoadedId(null);
                setDraft((current) => ({
                  ...current,
                  mode: value as "ALL" | "ANY",
                }));
              }}
              value={draft.mode}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("allConditions")}</SelectItem>
                <SelectItem value="ANY">{t("anyCondition")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3">
            {draft.conditions.map((condition, index) => {
              const needsValue = !["IS_EMPTY", "IS_NOT_EMPTY"].includes(
                condition.operator,
              );
              return (
                <Card className="gap-3 p-3" key={`${index}:${condition.field}`}>
                  <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                    <Select
                      onValueChange={(value) => update(index, { field: value })}
                      value={condition.field}
                    >
                      <SelectTrigger aria-label={t("filterField")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {fields.map((field) => (
                          <SelectItem key={field} value={field}>
                            {columnLabel(field, t)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      onValueChange={(value) =>
                        update(index, {
                          operator:
                            value as TelemetryFilterCondition["operator"],
                        })
                      }
                      value={condition.operator}
                    >
                      <SelectTrigger aria-label={t("operator")}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TELEMETRY_FILTER_OPERATORS.map((operator) => (
                          <SelectItem key={operator} value={operator}>
                            {t(`operators.${operator}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      aria-label={t("removeCondition")}
                      onClick={() => {
                        setLoadedId(null);
                        setDraft((current) => ({
                          ...current,
                          conditions: current.conditions.filter(
                            (_item, candidate) => candidate !== index,
                          ),
                        }));
                      }}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  {needsValue && (
                    <Input
                      aria-label={t("filterValue")}
                      onChange={(event) =>
                        update(index, { value: event.target.value })
                      }
                      placeholder={t("filterValue")}
                      value={condition.value ?? ""}
                    />
                  )}
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox
                        checked={condition.caseSensitive === true}
                        onCheckedChange={(value) =>
                          update(index, { caseSensitive: Boolean(value) })
                        }
                      />
                      {t("caseSensitive")}
                    </label>
                    {view === "UNIFIED" && (
                      <>
                        <span className="text-xs text-muted-foreground">
                          {t("appliesTo")}
                        </span>
                        {(["CONSOLE", "ANALYTICS"] as const).map((source) => (
                          <label
                            className="flex items-center gap-2 text-xs"
                            key={source}
                          >
                            <Checkbox
                              checked={(condition.sources ?? []).includes(
                                source,
                              )}
                              onCheckedChange={(checked) => {
                                const current = condition.sources ?? [];
                                if (!checked && current.length === 1) return;
                                update(index, {
                                  sources: checked
                                    ? [...current, source]
                                    : current.filter(
                                        (value) => value !== source,
                                      ),
                                });
                              }}
                            />
                            {source === "CONSOLE"
                              ? t("console")
                              : t("analytics")}
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                </Card>
              );
            })}
            <Button onClick={add} variant="outline">
              <Plus /> {t("addCondition")}
            </Button>
          </div>
          <section className="space-y-3 border-t pt-4">
            <h3 className="font-semibold">{t("savedFilters")}</h3>
            {savedFilters.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("noSavedFilters")}
              </p>
            ) : (
              savedFilters.map((filter) => (
                <div
                  className="flex items-center gap-2 rounded-lg border p-2"
                  key={filter.id}
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {filter.name}
                  </span>
                  <Button
                    onClick={() => {
                      setDraft(filter.definition);
                      setLoadedId(filter.id);
                      setEditingId(null);
                      setName("");
                    }}
                    size="sm"
                    variant="outline"
                  >
                    {t("load")}
                  </Button>
                  <Button
                    aria-label={t("editSavedFilter", { name: filter.name })}
                    onClick={() => {
                      setDraft(filter.definition);
                      setLoadedId(filter.id);
                      setEditingId(filter.id);
                      setName(filter.name);
                    }}
                    size="sm"
                    variant="ghost"
                  >
                    {t("edit")}
                  </Button>
                  <Button
                    aria-label={t("delete")}
                    onClick={() => void removeSaved(filter.id)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))
            )}
            <div className="flex gap-2">
              <Input
                aria-label={t("filterName")}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("filterName")}
                value={name}
              />
              <Button
                disabled={busy || !name.trim()}
                onClick={() => void save()}
              >
                <Plus /> {editingId ? t("updateFilter") : t("saveFilter")}
              </Button>
            </div>
          </section>
        </div>
        <SheetFooter className="border-t bg-muted/30">
          <Button
            onClick={() => {
              onApplied(draft);
              void onSaveViewSettings({ activeSavedFilterId: loadedId });
              onOpenChange(false);
            }}
          >
            {t("applyFilters")}
          </Button>
          <Button
            onClick={() => {
              setDraft({ mode: "ALL", conditions: [] });
              setLoadedId(null);
              setEditingId(null);
              setName("");
            }}
            variant="outline"
          >
            {t("clearFilters")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ColumnsDialog({
  open,
  onOpenChange,
  view,
  columns,
  allFields,
  configuration,
  onConfiguration,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: TelemetryView;
  columns: string[];
  allFields: string[];
  configuration: Configuration;
  onConfiguration: React.Dispatch<React.SetStateAction<Configuration | null>>;
  onSave: (settings: Partial<TelemetryViewSettingsView>) => Promise<void>;
}) {
  const t = useTranslations("telemetry");
  const [draft, setDraft] = useState(columns);
  const [presetName, setPresetName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(
    configuration.viewSettings.activeColumnPresetId,
  );
  const move = (index: number, direction: -1 | 1) => {
    setActivePresetId(null);
    setDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };
  const savePreset = async (preset?: TelemetryColumnPresetView) => {
    const data = await controlPlaneRequest<{
      saveTelemetryColumnPreset: TelemetryColumnPresetView;
    }>(
      `mutation SaveColumnPreset($input: SaveTelemetryColumnPresetInput!) {
        saveTelemetryColumnPreset(input: $input) { id view name columns isDefault createdAt updatedAt }
      }`,
      {
        input: {
          id: preset?.id ?? editingId,
          view,
          name: preset?.name ?? presetName,
          columns: preset ? preset.columns : draft,
          isDefault: preset ? true : makeDefault,
        },
      },
    );
    onConfiguration((current) =>
      current
        ? {
            ...current,
            presets: [
              ...current.presets
                .filter((item) => item.id !== data.saveTelemetryColumnPreset.id)
                .map((item) =>
                  data.saveTelemetryColumnPreset.isDefault
                    ? { ...item, isDefault: false }
                    : item,
                ),
              data.saveTelemetryColumnPreset,
            ].sort(
              (left, right) =>
                Number(right.isDefault) - Number(left.isDefault) ||
                left.name.localeCompare(right.name),
            ),
          }
        : current,
    );
    setPresetName("");
    setEditingId(null);
    setActivePresetId(data.saveTelemetryColumnPreset.id);
  };
  const removePreset = async (id: string) => {
    await controlPlaneRequest(
      `mutation DeleteColumnPreset($id: ID!) { deleteTelemetryColumnPreset(id: $id) }`,
      { id },
    );
    onConfiguration((current) =>
      current
        ? {
            ...current,
            presets: current.presets.filter((preset) => preset.id !== id),
          }
        : current,
    );
    if (editingId === id) {
      setEditingId(null);
      setPresetName("");
    }
    if (activePresetId === id) setActivePresetId(null);
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("manageColumns")}</DialogTitle>
          <DialogDescription>{t("manageColumnsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("availableColumns")}</h3>
            <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border p-2">
              {allFields.map((field) => {
                const index = draft.indexOf(field);
                return (
                  <div className="flex items-center gap-2" key={field}>
                    <Checkbox
                      checked={index >= 0}
                      onCheckedChange={(checked) => {
                        setActivePresetId(null);
                        setDraft((current) =>
                          checked
                            ? [...current, field]
                            : current.filter((item) => item !== field),
                        );
                      }}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-xs"
                      title={field}
                    >
                      {columnLabel(field, t)}
                    </span>
                    {index >= 0 && (
                      <>
                        <Button
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          disabled={index === draft.length - 1}
                          onClick={() => move(index, 1)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <ArrowDown />
                        </Button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            <Button
              onClick={() => {
                setDraft(DEFAULT_TELEMETRY_COLUMNS[view]);
                setActivePresetId(null);
              }}
              size="sm"
              variant="outline"
            >
              {t("resetColumns")}
            </Button>
          </section>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">{t("columnPresets")}</h3>
            <div className="space-y-1">
              {configuration.presets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("noColumnPresets")}
                </p>
              ) : (
                configuration.presets.map((preset) => (
                  <div
                    className="flex items-center gap-1 rounded-lg border p-2"
                    key={preset.id}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {preset.name}
                      {preset.isDefault ? ` · ${t("default")}` : ""}
                    </span>
                    <Button
                      onClick={() => {
                        setDraft(preset.columns);
                        setActivePresetId(preset.id);
                        setEditingId(null);
                        setPresetName("");
                      }}
                      size="sm"
                      variant="outline"
                    >
                      {t("load")}
                    </Button>
                    <Button
                      aria-label={t("editPreset", { name: preset.name })}
                      onClick={() => {
                        setDraft(preset.columns);
                        setActivePresetId(preset.id);
                        setEditingId(preset.id);
                        setPresetName(preset.name);
                        setMakeDefault(preset.isDefault);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {t("edit")}
                    </Button>
                    {!preset.isDefault && (
                      <Button
                        aria-label={t("setDefault")}
                        onClick={() => void savePreset(preset)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Paintbrush />
                      </Button>
                    )}
                    <Button
                      aria-label={t("delete")}
                      onClick={() => void removePreset(preset.id)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <Input
              aria-label={t("presetName")}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder={t("presetName")}
              value={presetName}
            />
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={makeDefault}
                onCheckedChange={(value) => setMakeDefault(Boolean(value))}
              />
              {t("setAsDefault")}
            </label>
            <Button
              disabled={!presetName.trim() || !draft.length}
              onClick={() => void savePreset()}
              size="sm"
            >
              <Plus /> {editingId ? t("updatePreset") : t("savePreset")}
            </Button>
            {editingId && (
              <Button
                onClick={() => {
                  setEditingId(null);
                  setPresetName("");
                  setMakeDefault(false);
                }}
                size="sm"
                variant="outline"
              >
                {t("saveAs")}
              </Button>
            )}
          </section>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              void onSave({
                columns: draft,
                activeColumnPresetId: activePresetId,
              });
              onOpenChange(false);
            }}
          >
            {t("applyColumns")}
          </Button>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: TelemetrySettingsView;
  onSaved: (settings: TelemetrySettingsView) => void;
}) {
  const t = useTranslations("telemetry");
  const [localOverride, setLocalOverride] = useState(
    Boolean(settings.localBaseUrlOverride),
  );
  const [remoteOverride, setRemoteOverride] = useState(
    Boolean(settings.remoteBaseUrlOverride),
  );
  const [local, setLocal] = useState(
    settings.localBaseUrlOverride ?? settings.detectedLocalBaseUrl,
  );
  const [remote, setRemote] = useState(
    settings.remoteBaseUrlOverride ?? settings.detectedRemoteBaseUrl,
  );
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const data = await controlPlaneRequest<{
        saveTelemetrySettings: TelemetrySettingsView;
      }>(
        `mutation SaveTelemetrySettings($input: SaveTelemetrySettingsInput!, $origin: String) {
          saveTelemetrySettings(input: $input, requestOrigin: $origin) {
            localBaseUrlOverride remoteBaseUrlOverride consoleCollectionEnabled analyticsCollectionEnabled
            detectedLocalBaseUrl detectedRemoteBaseUrl effectiveLocalBaseUrl effectiveRemoteBaseUrl updatedAt
          }
        }`,
        {
          input: {
            localBaseUrlOverride: localOverride ? local : null,
            remoteBaseUrlOverride: remoteOverride ? remote : null,
          },
          origin: window.location.origin,
        },
      );
      onSaved(data.saveTelemetrySettings);
      onOpenChange(false);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("telemetrySettings")}</DialogTitle>
          <DialogDescription>{t("settingsDescription")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-4">
          <UrlSetting
            checked={localOverride}
            detected={settings.detectedLocalBaseUrl}
            effective={localOverride ? local : settings.effectiveLocalBaseUrl}
            label={t("localBaseUrl")}
            onChecked={setLocalOverride}
            onValue={setLocal}
            value={local}
          />
          <UrlSetting
            checked={remoteOverride}
            detected={settings.detectedRemoteBaseUrl}
            effective={
              remoteOverride ? remote : settings.effectiveRemoteBaseUrl
            }
            label={t("remoteBaseUrl")}
            onChecked={setRemoteOverride}
            onValue={setRemote}
            value={remote}
          />
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3 text-xs">
            <Endpoint
              value={`${localOverride ? local : settings.detectedLocalBaseUrl}/api/telemetry/console-logs`}
              label={t("localConsoleEndpoint")}
            />
            <Endpoint
              value={`${localOverride ? local : settings.detectedLocalBaseUrl}/api/telemetry/analytics-events`}
              label={t("localAnalyticsEndpoint")}
            />
            <Endpoint
              value={`${remoteOverride ? remote : settings.detectedRemoteBaseUrl}/api/telemetry/console-logs`}
              label={t("remoteConsoleEndpoint")}
            />
            <Endpoint
              value={`${remoteOverride ? remote : settings.detectedRemoteBaseUrl}/api/telemetry/analytics-events`}
              label={t("remoteAnalyticsEndpoint")}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => void save()}>{t("saveSettings")}</Button>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UrlSetting({
  label,
  detected,
  effective,
  checked,
  value,
  onChecked,
  onValue,
}: {
  label: string;
  detected: string;
  effective: string;
  checked: boolean;
  value: string;
  onChecked: (checked: boolean) => void;
  onValue: (value: string) => void;
}) {
  const t = useTranslations("telemetry");
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onChecked(Boolean(value))}
          />
          {t("override")}
        </label>
      </div>
      <Input
        disabled={!checked}
        onChange={(event) => onValue(event.target.value)}
        value={checked ? value : detected}
      />
      <p className="text-xs text-muted-foreground">
        {t("detected", { value: detected })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("effective", { value: effective })}
      </p>
    </div>
  );
}

function Endpoint({ label, value }: { label: string; value: string }) {
  const t = useTranslations("telemetry");
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label}</p>
        <code className="break-all text-muted-foreground">{value}</code>
      </div>
      <Button
        aria-label={t("copyEndpoint", { label })}
        onClick={() => void copyText(value)}
        size="icon-sm"
        variant="ghost"
      >
        <Clipboard />
      </Button>
    </div>
  );
}

function SeparatorDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const t = useTranslations("telemetry");
  const [name, setName] = useState("");
  const add = async () => {
    await controlPlaneRequest(
      `mutation AddTelemetrySeparator($name: String) { addTelemetrySeparator(name: $name) { id } }`,
      { name: name.trim() || null },
    );
    setName("");
    onOpenChange(false);
    onAdded();
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addSeparator")}</DialogTitle>
          <DialogDescription>{t("addSeparatorDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="telemetry-separator-name">{t("optionalName")}</Label>
          <Input
            id="telemetry-separator-name"
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        <DialogFooter>
          <Button onClick={() => void add()}>
            <Plus /> {t("addSeparator")}
          </Button>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExportDialog({
  open,
  onOpenChange,
  view,
  query,
  columns,
  availableFields,
  selection,
  selectedCount,
  locale,
  timeFormat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: TelemetryView;
  query: TelemetryQueryInput;
  columns: string[];
  availableFields: string[];
  selection: TelemetrySelection | null;
  selectedCount: number;
  locale: string;
  timeFormat: "12" | "24";
}) {
  const t = useTranslations("telemetry");
  const [format, setFormat] = useState("CSV");
  const [fields, setFields] = useState(columns);
  const [busy, setBusy] = useState(false);
  const available = [
    ...new Set([...BASE_COLUMNS[view], ...availableFields, ...columns]),
  ];
  const run = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/telemetry/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          format,
          query,
          selection,
          fields,
          locale,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timeFormat,
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(body.error?.message || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        disposition.match(/filename="([^"]+)"/)?.[1] ??
        `observability.${format.toLocaleLowerCase()}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("exportTitle")}</DialogTitle>
          <DialogDescription>
            {selection
              ? t("exportSelectedDescription", { count: selectedCount })
              : t("exportAllDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("format")}</Label>
            <Select onValueChange={setFormat} value={format}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CSV">CSV</SelectItem>
                <SelectItem value="MARKDOWN">Markdown</SelectItem>
                <SelectItem value="PDF">PDF</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("exportFields")}</Label>
            <div className="grid max-h-64 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
              {available.map((field) => (
                <label
                  className="flex min-w-0 items-center gap-2 text-xs"
                  key={field}
                >
                  <Checkbox
                    checked={fields.includes(field)}
                    onCheckedChange={(checked) =>
                      setFields((current) =>
                        checked
                          ? [...current, field]
                          : current.filter((item) => item !== field),
                      )
                    }
                  />
                  <span className="truncate">{columnLabel(field, t)}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={busy || fields.length === 0}
            onClick={() => void run()}
          >
            {busy ? <Spinner /> : <Download />} {t("export")}
          </Button>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
