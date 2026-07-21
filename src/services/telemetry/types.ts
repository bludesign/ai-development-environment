export const TELEMETRY_VIEWS = ["CONSOLE", "ANALYTICS", "UNIFIED"] as const;
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number];

export const TELEMETRY_ENTRY_TYPES = [
  "CONSOLE",
  "ANALYTICS",
  "SEPARATOR",
] as const;
export type TelemetryEntryType = (typeof TELEMETRY_ENTRY_TYPES)[number];

export const TELEMETRY_SEARCH_MODES = ["TEXT", "GLOB", "REGEX"] as const;
export type TelemetrySearchMode = (typeof TELEMETRY_SEARCH_MODES)[number];

export const TELEMETRY_FILTER_OPERATORS = [
  "CONTAINS",
  "DOES_NOT_CONTAIN",
  "IS",
  "IS_NOT",
  "MATCHES_GLOB",
  "MATCHES_REGEX",
  "NO_REGEX_MATCH",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
] as const;
export type TelemetryFilterOperator =
  (typeof TELEMETRY_FILTER_OPERATORS)[number];

export type TelemetryJsonObject = Record<string, unknown>;

export type ConsoleLogInput = {
  message: string;
  time: string;
  level: string;
  category: string;
  buildId: string;
  sessionId: string;
  attributes: TelemetryJsonObject;
};

export type AnalyticsEventInput = {
  eventName: string;
  kind: string;
  screenName: string;
  time: string;
  defaultParameters: TelemetryJsonObject;
  additionalParameters: TelemetryJsonObject;
  buildId: string;
  sessionId: string;
};

export type TelemetryFilterCondition = {
  field: string;
  operator: TelemetryFilterOperator;
  value?: string | null;
  caseSensitive?: boolean;
  sources?: Array<"CONSOLE" | "ANALYTICS">;
};

export type TelemetryFilterDefinition = {
  mode: "ALL" | "ANY";
  conditions: TelemetryFilterCondition[];
};

export type TelemetryQueryInput = {
  view: TelemetryView;
  first?: number | null;
  after?: string | null;
  search?: string | null;
  searchMode?: TelemetrySearchMode | null;
  caseSensitive?: boolean | null;
  quickFilters?: Record<string, string[]> | null;
  advancedFilter?: TelemetryFilterDefinition | null;
};

export type TelemetrySelectionRange = {
  startTime?: string | null;
  endTime?: string | null;
  includeSeparators?: boolean | null;
};

export type TelemetrySelection = {
  ids?: string[] | null;
  excludedIds?: string[] | null;
  query?: TelemetryQueryInput | null;
  ranges?: TelemetrySelectionRange[] | null;
  includeSeparators?: boolean | null;
};

export type TelemetryEntryView = {
  id: string;
  entryType: TelemetryEntryType;
  clientTime: string;
  receivedAt: string;
  deviceIp: string | null;
  message: string | null;
  level: string | null;
  category: string | null;
  eventName: string | null;
  eventKind: string | null;
  screenName: string | null;
  buildId: string | null;
  sessionId: string | null;
  attributes: TelemetryJsonObject;
  defaultParameters: TelemetryJsonObject;
  additionalParameters: TelemetryJsonObject;
  highlightColor: string | null;
  separatorKind: string | null;
  separatorName: string | null;
};

export type TelemetryTimelinePage = {
  items: TelemetryEntryView[];
  nextCursor: string | null;
  matchingCount: number;
  totalCount: number;
};

export type TelemetrySinceSeparatorPage = TelemetryTimelinePage & {
  separator: TelemetryEntryView | null;
};

export type TelemetrySeparatorPage = {
  items: TelemetryEntryView[];
  nextCursor: string | null;
};

export type TelemetryFacets = Record<string, string[]>;

export type TelemetrySettingsView = {
  localBaseUrlOverride: string | null;
  remoteBaseUrlOverride: string | null;
  consoleCollectionEnabled: boolean;
  analyticsCollectionEnabled: boolean;
  detectedLocalBaseUrl: string;
  detectedRemoteBaseUrl: string;
  effectiveLocalBaseUrl: string;
  effectiveRemoteBaseUrl: string;
  updatedAt: string;
};

export type TelemetryBuildSettings = {
  localBaseUrl: string;
  remoteBaseUrl: string;
  selectedBaseUrl: string;
  consoleLogsUrl: string;
  analyticsEventsUrl: string;
  consoleCollectionEnabled: boolean;
  analyticsCollectionEnabled: boolean;
};

export const DEFAULT_TELEMETRY_COLUMNS: Record<TelemetryView, string[]> = {
  CONSOLE: ["time", "level", "category", "message", "buildId", "sessionId"],
  ANALYTICS: [
    "time",
    "eventKind",
    "eventName",
    "screenName",
    "parameters",
    "buildId",
    "sessionId",
  ],
  UNIFIED: ["time", "source", "levelKind", "detail", "buildId", "sessionId"],
};

export type TelemetryColumnPresetView = {
  id: string;
  view: TelemetryView;
  name: string;
  columns: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TelemetrySavedFilterView = {
  id: string;
  view: TelemetryView;
  name: string;
  definition: TelemetryFilterDefinition;
  createdAt: string;
  updatedAt: string;
};

export type TelemetryViewSettingsView = {
  view: TelemetryView;
  columns: string[];
  timeFormat: "12" | "24";
  activeColumnPresetId: string | null;
  activeSavedFilterId: string | null;
};

export const TELEMETRY_COLORS = [
  "gray",
  "stone",
  "red",
  "rose",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
] as const;
