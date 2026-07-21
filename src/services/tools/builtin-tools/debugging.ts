import * as z from "zod/v4";

import type { PushNotificationsService } from "@/services/push-notifications";
import type {
  TelemetryFilterDefinition,
  TelemetryQueryInput,
  TelemetryService,
  TelemetryView,
} from "@/services/telemetry";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolDefinition,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { createPushNotificationToolGroup } from "./push-notifications";

const TelemetryEntrySchema = z.object({
  id: z.string(),
  entryType: z.enum(["CONSOLE", "ANALYTICS", "SEPARATOR"]),
  clientTime: z.string(),
  receivedAt: z.string(),
  deviceIp: z.string().nullable(),
  message: z.string().nullable(),
  level: z.string().nullable(),
  category: z.string().nullable(),
  eventName: z.string().nullable(),
  eventKind: z.string().nullable(),
  screenName: z.string().nullable(),
  buildId: z.string().nullable(),
  sessionId: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  defaultParameters: z.record(z.string(), z.unknown()),
  additionalParameters: z.record(z.string(), z.unknown()),
  highlightColor: z.string().nullable(),
  separatorKind: z.string().nullable(),
  separatorName: z.string().nullable(),
});
const TimelinePageSchema = z.object({
  items: z.array(TelemetryEntrySchema),
  nextCursor: z.string().nullable(),
  matchingCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});
const SinceSeparatorPageSchema = TimelinePageSchema.extend({
  separator: TelemetryEntrySchema.nullable(),
});
const PageInputSchema = z.object({
  first: z.number().int().min(1).max(500).default(200),
  after: z.string().nullable().default(null),
});
const FilterConditionSchema = z.object({
  field: z.string().min(1),
  operator: z.enum([
    "CONTAINS",
    "DOES_NOT_CONTAIN",
    "IS",
    "IS_NOT",
    "MATCHES_GLOB",
    "MATCHES_REGEX",
    "NO_REGEX_MATCH",
    "IS_EMPTY",
    "IS_NOT_EMPTY",
  ]),
  value: z.string().nullable().optional(),
  caseSensitive: z.boolean().default(false),
  sources: z.array(z.enum(["CONSOLE", "ANALYTICS"])).optional(),
});
const AdvancedFilterSchema = z.object({
  mode: z.enum(["ALL", "ANY"]),
  conditions: z.array(FilterConditionSchema).min(1).max(100),
});
const FilterFields = {
  search: z.string().min(1).nullable().optional(),
  searchMode: z.enum(["TEXT", "GLOB", "REGEX"]).default("TEXT"),
  caseSensitive: z.boolean().default(false),
  quickFilters: z
    .record(z.string(), z.array(z.string()).max(500))
    .nullable()
    .optional(),
  advancedFilter: AdvancedFilterSchema.nullable().optional(),
};
const SearchInputSchema = PageInputSchema.extend(FilterFields).refine(
  hasFilter,
  { message: "At least one telemetry search filter is required" },
);
const SinceInputSchema = PageInputSchema.extend(FilterFields);
const MatchingClearSchema = z
  .object({ scope: z.literal("MATCHING"), ...FilterFields })
  .refine(hasFilter, {
    message: "At least one telemetry search filter is required",
  });
const ClearInputSchema = z.union([
  z.object({
    scope: z.literal("IDS"),
    ids: z.array(z.string().min(1)).min(1).max(1_000),
  }),
  MatchingClearSchema,
  z.object({
    scope: z.literal("ALL"),
    includeSeparators: z.boolean().default(false),
  }),
  z.object({
    scope: z.literal("BEFORE_LATEST_SEPARATOR"),
    includeSeparators: z.boolean().default(false),
  }),
]);

function hasFilter(value: {
  search?: string | null;
  quickFilters?: Record<string, string[]> | null;
  advancedFilter?: { conditions: unknown[] } | null;
}) {
  return Boolean(
    value.search ||
    Object.values(value.quickFilters ?? {}).some((items) => items.length) ||
    value.advancedFilter?.conditions.length,
  );
}

function query(
  view: TelemetryView,
  input: z.output<typeof PageInputSchema> & {
    search?: string | null;
    searchMode?: "TEXT" | "GLOB" | "REGEX";
    caseSensitive?: boolean;
    quickFilters?: Record<string, string[]> | null;
    advancedFilter?: z.output<typeof AdvancedFilterSchema> | null;
  },
): TelemetryQueryInput {
  return {
    view,
    first: input.first,
    after: input.after,
    search: input.search,
    searchMode: input.searchMode ?? "TEXT",
    caseSensitive: input.caseSensitive ?? false,
    quickFilters: input.quickFilters,
    advancedFilter: input.advancedFilter as TelemetryFilterDefinition | null,
  };
}

function viewTools(
  telemetry: TelemetryService,
  view: TelemetryView,
  names: {
    plural: string;
    singular: string;
    label: string;
  },
): BuiltInToolDefinition[] {
  return [
    defineTool({
      name: `get_${names.plural}`,
      title: `Get ${names.label}`,
      description: `Fetch the newest ${names.label.toLocaleLowerCase()} with cursor pagination.`,
      inputSchema: PageInputSchema,
      outputSchema: TimelinePageSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: (input) => telemetry.timeline(query(view, input)),
    }),
    defineTool({
      name: `get_${names.singular}`,
      title: `Get ${names.singular.replaceAll("_", " ")}`,
      description: `Fetch one ${names.label.toLocaleLowerCase()} item by ID.`,
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: z.object({ entry: TelemetryEntrySchema.nullable() }),
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async ({ id }) => ({ entry: await telemetry.entry(id, view) }),
    }),
    defineTool({
      name: `search_${names.plural}`,
      title: `Search ${names.label}`,
      description:
        "Search with text, glob, regex, quick facets, or advanced filter conditions.",
      inputSchema: SearchInputSchema,
      outputSchema: TimelinePageSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: (input) => telemetry.timeline(query(view, input)),
    }),
    defineTool({
      name: `get_${names.plural}_since_latest_separator`,
      title: `Get ${names.label} since latest separator`,
      description:
        "Fetch entries strictly newer than the latest global telemetry separator.",
      inputSchema: SinceInputSchema,
      outputSchema: SinceSeparatorPageSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      handler: (input) =>
        telemetry.timelineSinceLatestSeparator(query(view, input)),
    }),
    defineTool({
      name: `get_${names.singular}_search_metadata`,
      title: `Get ${names.label} search metadata`,
      description: "Get searchable fields and current facet values.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        fields: z.array(z.string()),
        facets: z.record(z.string(), z.array(z.string())),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async () => {
        const [fields, facets] = await Promise.all([
          telemetry.fields(view),
          telemetry.facets(view),
        ]);
        return { fields, facets };
      },
    }),
    defineTool({
      name: `clear_${names.plural}`,
      title: `Clear ${names.label}`,
      description:
        "Clear explicit IDs, matching entries, all entries, or entries before the latest separator.",
      inputSchema: ClearInputSchema,
      outputSchema: z.object({
        view: z.enum(["CONSOLE", "ANALYTICS", "UNIFIED"]),
        scope: z.enum(["IDS", "MATCHING", "ALL", "BEFORE_LATEST_SEPARATOR"]),
        deletedCount: z.number().int().nonnegative(),
      }),
      annotations: DESTRUCTIVE_ANNOTATIONS,
      handler: async (input) => {
        const filter = input.scope === "MATCHING" ? input : null;
        const deletedCount = await telemetry.clearScoped({
          view,
          scope: input.scope,
          ids: input.scope === "IDS" ? input.ids : null,
          includeSeparators:
            input.scope === "ALL" || input.scope === "BEFORE_LATEST_SEPARATOR"
              ? input.includeSeparators
              : false,
          query: filter
            ? {
                search: filter.search,
                searchMode: filter.searchMode,
                caseSensitive: filter.caseSensitive,
                quickFilters: filter.quickFilters,
                advancedFilter:
                  filter.advancedFilter as TelemetryFilterDefinition | null,
              }
            : null,
        });
        return { view, scope: input.scope, deletedCount };
      },
    }),
  ];
}

export function createDebuggingToolGroup(
  telemetry: TelemetryService,
  pushNotifications: PushNotificationsService,
): BuiltInToolGroup {
  const direct = viewTools(telemetry, "UNIFIED", {
    plural: "unified_events",
    singular: "unified_event",
    label: "Unified Events",
  });
  direct.push(
    defineTool({
      name: "get_telemetry_separators",
      title: "Get telemetry separators",
      description:
        "List global manual and build separators with optional filters.",
      inputSchema: z.object({
        first: z.number().int().min(1).max(500).default(100),
        after: z.string().nullable().default(null),
        kind: z.string().min(1).nullable().optional(),
        name: z.string().min(1).nullable().optional(),
        buildId: z.string().min(1).nullable().optional(),
      }),
      outputSchema: z.object({
        items: z.array(TelemetryEntrySchema),
        nextCursor: z.string().nullable(),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      handler: (input) => telemetry.separators(input),
    }),
    defineTool({
      name: "add_telemetry_separator",
      title: "Add telemetry separator",
      description: "Add a global manual separator to all telemetry views.",
      inputSchema: z.object({
        name: z.string().max(100).nullable().default(null),
      }),
      outputSchema: z.object({ separator: TelemetryEntrySchema }),
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: false },
      handler: async ({ name }) => ({
        separator: await telemetry.addSeparator(name),
      }),
    }),
    defineTool({
      name: "get_telemetry_settings",
      title: "Get telemetry settings",
      description:
        "Get telemetry collection state and effective ingestion URLs.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        settings: z.object({
          localBaseUrlOverride: z.string().nullable(),
          remoteBaseUrlOverride: z.string().nullable(),
          consoleCollectionEnabled: z.boolean(),
          analyticsCollectionEnabled: z.boolean(),
          detectedLocalBaseUrl: z.string(),
          detectedRemoteBaseUrl: z.string(),
          effectiveLocalBaseUrl: z.string(),
          effectiveRemoteBaseUrl: z.string(),
          updatedAt: z.string(),
        }),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      handler: async () => ({ settings: await telemetry.settings() }),
    }),
  );

  return {
    id: "builtin:debugging",
    name: "Debugging",
    tools: direct,
    children: [
      {
        id: "builtin:debugging:console-logs",
        name: "Console Logs",
        tools: viewTools(telemetry, "CONSOLE", {
          plural: "console_logs",
          singular: "console_log",
          label: "Console Logs",
        }),
        children: [],
      },
      {
        id: "builtin:debugging:analytics-events",
        name: "Analytics Events",
        tools: viewTools(telemetry, "ANALYTICS", {
          plural: "analytics_events",
          singular: "analytics_event",
          label: "Analytics Events",
        }),
        children: [],
      },
      createPushNotificationToolGroup(pushNotifications),
    ],
  };
}
