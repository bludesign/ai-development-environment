import "server-only";

import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  TELEMETRY_CHANGED_TOPIC,
  TELEMETRY_SETTINGS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import { getEnrollmentServerOrigins } from "@/server/enrollment-server-origins";

import {
  fieldsForFacet,
  matchesTelemetryQuery,
  sourcesForView,
  stableJson,
  telemetrySearchText,
  validateTelemetryQuery,
} from "./matching";
import {
  DEFAULT_TELEMETRY_COLUMNS,
  TELEMETRY_COLORS,
  TELEMETRY_VIEWS,
  type AnalyticsEventInput,
  type ConsoleLogInput,
  type TelemetryBuildSettings,
  type TelemetryColumnPresetView,
  type TelemetryEntryType,
  type TelemetryEntryView,
  type TelemetryFacets,
  type TelemetryFilterDefinition,
  type TelemetryJsonObject,
  type TelemetryQueryInput,
  type TelemetrySavedFilterView,
  type TelemetrySeparatorPage,
  type TelemetrySelection,
  type TelemetrySelectionRange,
  type TelemetrySettingsView,
  type TelemetrySinceSeparatorPage,
  type TelemetryTimelinePage,
  type TelemetryView,
  type TelemetryViewSettingsView,
} from "./types";

const SETTINGS_ID = "default";
const SCAN_SIZE = 1_000;
const DEFAULT_FIRST = 200;
const MAX_FIRST = 500;

type RawEntry = {
  id: string;
  entryType: string;
  clientTime: Date;
  receivedAt: Date;
  deviceIp: string | null;
  message: string | null;
  level: string | null;
  category: string | null;
  eventName: string | null;
  eventKind: string | null;
  screenName: string | null;
  buildId: string | null;
  sessionId: string | null;
  attributesJson: string;
  defaultParametersJson: string;
  additionalParametersJson: string;
  highlightColor: string | null;
  separatorKind: string | null;
  separatorName: string | null;
};

type DetectionInput = {
  requestOrigin?: string | null;
  localOrigins?: string[];
  publicBaseUrl?: string | null;
};

type Cursor = { clientTime: string; receivedAt: string; id: string };

function parseObject(value: string): TelemetryJsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TelemetryJsonObject)
      : {};
  } catch {
    return {};
  }
}

function viewEntry(entry: RawEntry): TelemetryEntryView {
  return {
    id: entry.id,
    entryType: entry.entryType as TelemetryEntryType,
    clientTime: entry.clientTime.toISOString(),
    receivedAt: entry.receivedAt.toISOString(),
    deviceIp: entry.deviceIp,
    message: entry.message,
    level: entry.level,
    category: entry.category,
    eventName: entry.eventName,
    eventKind: entry.eventKind,
    screenName: entry.screenName,
    buildId: entry.buildId,
    sessionId: entry.sessionId,
    attributes: parseObject(entry.attributesJson),
    defaultParameters: parseObject(entry.defaultParametersJson),
    additionalParameters: parseObject(entry.additionalParametersJson),
    highlightColor: entry.highlightColor,
    separatorKind: entry.separatorKind,
    separatorName: entry.separatorName,
  };
}

function requireView(value: string): TelemetryView {
  if (!TELEMETRY_VIEWS.includes(value as TelemetryView)) {
    throw new Error("Unknown telemetry view");
  }
  return value as TelemetryView;
}

function normalizeName(value: string): {
  name: string;
  normalizedName: string;
} {
  const name = value.trim();
  if (!name || name.length > 100)
    throw new Error("Name must contain 1-100 characters");
  return { name, normalizedName: name.toLocaleLowerCase() };
}

export function normalizeTelemetryOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Telemetry URL must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Telemetry URL must be an HTTP(S) origin without a path, credentials, query, or fragment",
    );
  }
  return url.origin;
}

function optionalOrigin(value: string | null | undefined): string | null {
  return value?.trim() ? normalizeTelemetryOrigin(value) : null;
}

function detectedOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function privateHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "::1" ||
    value.endsWith(".local") ||
    /^127\./.test(value) ||
    /^10\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  );
}

export function detectTelemetryOrigins(input: DetectionInput = {}): {
  local: string;
  remote: string;
} {
  const request = detectedOrigin(input.requestOrigin);
  const locals = (input.localOrigins ?? getEnrollmentServerOrigins()).flatMap(
    (value) => {
      try {
        return [normalizeTelemetryOrigin(value)];
      } catch {
        return [];
      }
    },
  );
  const configured = detectedOrigin(
    input.publicBaseUrl ?? process.env.PUBLIC_BASE_URL,
  );
  const requestIsPrivate = request
    ? privateHostname(new URL(request).hostname)
    : false;
  const local =
    request && requestIsPrivate
      ? request
      : (locals[0] ?? request ?? "http://127.0.0.1:3000");
  const remote = configured ?? request ?? local;
  return { local, remote };
}

function cursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Cursor).clientTime === "string" &&
      typeof (parsed as Cursor).receivedAt === "string" &&
      typeof (parsed as Cursor).id === "string" &&
      Number.isFinite(Date.parse((parsed as Cursor).clientTime)) &&
      Number.isFinite(Date.parse((parsed as Cursor).receivedAt))
    ) {
      return parsed as Cursor;
    }
  } catch {
    // Mapped to a stable validation error below.
  }
  throw new Error("Invalid telemetry cursor");
}

function olderThanCursorWhere(value: Cursor): Record<string, unknown> {
  const clientTime = new Date(value.clientTime);
  const receivedAt = new Date(value.receivedAt);
  return {
    OR: [
      { clientTime: { lt: clientTime } },
      { clientTime, receivedAt: { lt: receivedAt } },
      { clientTime, receivedAt, id: { lt: value.id } },
    ],
  };
}

function newerThanCursorWhere(value: Cursor): Record<string, unknown> {
  const clientTime = new Date(value.clientTime);
  const receivedAt = new Date(value.receivedAt);
  return {
    OR: [
      { clientTime: { gt: clientTime } },
      { clientTime, receivedAt: { gt: receivedAt } },
      { clientTime, receivedAt, id: { gt: value.id } },
    ],
  };
}

function encodeCursor(entry: TelemetryEntryView): string {
  return Buffer.from(
    JSON.stringify({
      clientTime: entry.clientTime,
      receivedAt: entry.receivedAt,
      id: entry.id,
    } satisfies Cursor),
  ).toString("base64url");
}

function olderThan(entry: TelemetryEntryView, value: Cursor): boolean {
  if (entry.clientTime !== value.clientTime)
    return entry.clientTime < value.clientTime;
  if (entry.receivedAt !== value.receivedAt)
    return entry.receivedAt < value.receivedAt;
  return entry.id < value.id;
}

function hasActiveFilters(input: TelemetryQueryInput): boolean {
  return Boolean(
    input.search ||
    Object.values(input.quickFilters ?? {}).some((values) => values.length) ||
    input.advancedFilter?.conditions.length,
  );
}

function sourceWhere(view: TelemetryView) {
  return { entryType: { in: sourcesForView(view) } };
}

const DATABASE_FIELDS: Record<string, { name: string; nullable: boolean }> = {
  source: { name: "entryType", nullable: false },
  deviceIp: { name: "deviceIp", nullable: true },
  message: { name: "message", nullable: true },
  level: { name: "level", nullable: true },
  category: { name: "category", nullable: true },
  eventName: { name: "eventName", nullable: true },
  eventKind: { name: "eventKind", nullable: true },
  screenName: { name: "screenName", nullable: true },
  buildId: { name: "buildId", nullable: true },
  sessionId: { name: "sessionId", nullable: true },
};

function databaseValueFilter(
  field: { name: string; nullable: boolean },
  values: string[],
): Record<string, unknown> | null {
  const unique = [...new Set(values)];
  const nonEmpty = unique.filter(Boolean);
  const alternatives: Record<string, unknown>[] = [];
  if (nonEmpty.length) {
    alternatives.push({ [field.name]: { in: nonEmpty } });
  }
  if (unique.includes("")) {
    alternatives.push({ [field.name]: "" });
    if (field.nullable) alternatives.push({ [field.name]: null });
  }
  if (alternatives.length === 0) return null;
  return alternatives.length === 1 ? alternatives[0]! : { OR: alternatives };
}

function databasePrefilter(
  input: TelemetryQueryInput,
): Record<string, unknown> | null {
  const conditions: Record<string, unknown>[] = [];
  if (
    input.search &&
    (input.searchMode ?? "TEXT") === "TEXT" &&
    input.caseSensitive === true
  ) {
    conditions.push({ searchText: { contains: input.search } });
  }
  for (const [name, values] of Object.entries(input.quickFilters ?? {})) {
    if (!values.length) continue;
    const field = DATABASE_FIELDS[name];
    if (!field) continue;
    const condition = databaseValueFilter(field, values);
    if (condition) conditions.push(condition);
  }
  if (input.advancedFilter?.mode === "ALL") {
    for (const condition of input.advancedFilter.conditions) {
      if (condition.sources?.length || condition.caseSensitive !== true)
        continue;
      const field = DATABASE_FIELDS[condition.field];
      const value = condition.value ?? "";
      if (!field || !value) continue;
      if (condition.operator === "IS") {
        conditions.push({ [field.name]: value });
      } else if (condition.operator === "CONTAINS") {
        conditions.push({ [field.name]: { contains: value } });
      }
    }
  }
  if (!conditions.length) return null;
  return conditions.length === 1 ? conditions[0]! : { AND: conditions };
}

function serializeColumns(columns: string[]): string {
  const clean = [
    ...new Set(columns.map((column) => column.trim()).filter(Boolean)),
  ];
  if (
    clean.length === 0 ||
    clean.length > 100 ||
    clean.some((column) => column.length > 512)
  ) {
    throw new Error("Columns must contain 1-100 valid column identifiers");
  }
  return JSON.stringify(clean);
}

function parseColumns(value: string, view: TelemetryView): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string") &&
      parsed.length
    ) {
      return parsed;
    }
  } catch {
    // Fall through to defaults.
  }
  return DEFAULT_TELEMETRY_COLUMNS[view];
}

export class TelemetryService {
  subscribe() {
    return agentEventBus.iterate<{ ids: string[]; reason: string }>(
      TELEMETRY_CHANGED_TOPIC,
    );
  }

  subscribeSettings() {
    return agentEventBus.iterate<{ updatedAt: string }>(
      TELEMETRY_SETTINGS_CHANGED_TOPIC,
    );
  }

  private publish(ids: string[], reason: string) {
    agentEventBus.publish(TELEMETRY_CHANGED_TOPIC, { ids, reason });
  }

  notifyChange(ids: string[], reason: string) {
    this.publish(ids, reason);
  }

  private async rawSettings() {
    const prisma = await getPrismaClient();
    return prisma.telemetrySettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async settings(
    detection: DetectionInput = {},
  ): Promise<TelemetrySettingsView> {
    const [settings, detected] = await Promise.all([
      this.rawSettings(),
      Promise.resolve(detectTelemetryOrigins(detection)),
    ]);
    return {
      localBaseUrlOverride: settings.localBaseUrlOverride,
      remoteBaseUrlOverride: settings.remoteBaseUrlOverride,
      consoleCollectionEnabled: settings.consoleCollectionEnabled,
      analyticsCollectionEnabled: settings.analyticsCollectionEnabled,
      detectedLocalBaseUrl: detected.local,
      detectedRemoteBaseUrl: detected.remote,
      effectiveLocalBaseUrl: settings.localBaseUrlOverride ?? detected.local,
      effectiveRemoteBaseUrl: settings.remoteBaseUrlOverride ?? detected.remote,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async saveSettings(
    input: {
      localBaseUrlOverride?: string | null;
      remoteBaseUrlOverride?: string | null;
      consoleCollectionEnabled?: boolean | null;
      analyticsCollectionEnabled?: boolean | null;
    },
    detection: DetectionInput = {},
  ): Promise<TelemetrySettingsView> {
    const prisma = await getPrismaClient();
    const current = await this.rawSettings();
    const updated = await prisma.telemetrySettings.update({
      where: { id: SETTINGS_ID },
      data: {
        localBaseUrlOverride:
          input.localBaseUrlOverride === undefined
            ? current.localBaseUrlOverride
            : optionalOrigin(input.localBaseUrlOverride),
        remoteBaseUrlOverride:
          input.remoteBaseUrlOverride === undefined
            ? current.remoteBaseUrlOverride
            : optionalOrigin(input.remoteBaseUrlOverride),
        consoleCollectionEnabled:
          input.consoleCollectionEnabled ?? current.consoleCollectionEnabled,
        analyticsCollectionEnabled:
          input.analyticsCollectionEnabled ??
          current.analyticsCollectionEnabled,
      },
    });
    agentEventBus.publish(TELEMETRY_SETTINGS_CHANGED_TOPIC, {
      updatedAt: updated.updatedAt.toISOString(),
    });
    return this.settings(detection);
  }

  async buildSettings(
    destinationType: "SIMULATOR" | "PHYSICAL_DEVICE",
    detection: DetectionInput = {},
  ): Promise<TelemetryBuildSettings> {
    const settings = await this.settings(detection);
    const selectedBaseUrl =
      destinationType === "SIMULATOR"
        ? settings.effectiveLocalBaseUrl
        : settings.effectiveRemoteBaseUrl;
    return {
      localBaseUrl: settings.effectiveLocalBaseUrl,
      remoteBaseUrl: settings.effectiveRemoteBaseUrl,
      selectedBaseUrl,
      consoleLogsUrl: `${selectedBaseUrl}/api/telemetry/console-logs`,
      analyticsEventsUrl: `${selectedBaseUrl}/api/telemetry/analytics-events`,
      consoleCollectionEnabled: settings.consoleCollectionEnabled,
      analyticsCollectionEnabled: settings.analyticsCollectionEnabled,
    };
  }

  async ingestConsole(
    items: ConsoleLogInput[],
    deviceIp: string,
  ): Promise<{
    collected: boolean;
    items: Array<{ id: string; receivedAt: string; deviceIp: string }>;
  }> {
    const settings = await this.rawSettings();
    if (!settings.consoleCollectionEnabled)
      return { collected: false, items: [] };
    const prisma = await getPrismaClient();
    const receivedAt = new Date();
    const records = items.map((item) => {
      const id = randomUUID();
      const entry = {
        id,
        entryType: "CONSOLE" as const,
        clientTime: new Date(item.time),
        receivedAt,
        deviceIp,
        message: item.message,
        level: item.level,
        category: item.category,
        buildId: item.buildId,
        sessionId: item.sessionId,
        attributesJson: JSON.stringify(item.attributes),
        searchText: "",
      };
      const searchable = viewEntry({
        ...entry,
        eventName: null,
        eventKind: null,
        screenName: null,
        defaultParametersJson: "{}",
        additionalParametersJson: "{}",
        highlightColor: null,
        separatorKind: null,
        separatorName: null,
      });
      return { ...entry, searchText: telemetrySearchText(searchable) };
    });
    await prisma.telemetryEntry.createMany({ data: records });
    this.publish(
      records.map(({ id }) => id),
      "INGESTED",
    );
    return {
      collected: true,
      items: records.map(({ id }) => ({
        id,
        receivedAt: receivedAt.toISOString(),
        deviceIp,
      })),
    };
  }

  async ingestAnalytics(
    items: AnalyticsEventInput[],
    deviceIp: string,
  ): Promise<{
    collected: boolean;
    items: Array<{ id: string; receivedAt: string; deviceIp: string }>;
  }> {
    const settings = await this.rawSettings();
    if (!settings.analyticsCollectionEnabled)
      return { collected: false, items: [] };
    const prisma = await getPrismaClient();
    const receivedAt = new Date();
    const records = items.map((item) => {
      const id = randomUUID();
      const entry = {
        id,
        entryType: "ANALYTICS" as const,
        clientTime: new Date(item.time),
        receivedAt,
        deviceIp,
        eventName: item.eventName,
        eventKind: item.kind,
        screenName: item.screenName,
        buildId: item.buildId,
        sessionId: item.sessionId,
        defaultParametersJson: JSON.stringify(item.defaultParameters),
        additionalParametersJson: JSON.stringify(item.additionalParameters),
        searchText: "",
      };
      const searchable = viewEntry({
        ...entry,
        message: null,
        level: null,
        category: null,
        attributesJson: "{}",
        highlightColor: null,
        separatorKind: null,
        separatorName: null,
      });
      return { ...entry, searchText: telemetrySearchText(searchable) };
    });
    await prisma.telemetryEntry.createMany({ data: records });
    this.publish(
      records.map(({ id }) => id),
      "INGESTED",
    );
    return {
      collected: true,
      items: records.map(({ id }) => ({
        id,
        receivedAt: receivedAt.toISOString(),
        deviceIp,
      })),
    };
  }

  private async scan(
    where: Record<string, unknown>,
    visit: (
      entry: TelemetryEntryView,
    ) => void | boolean | Promise<void | boolean>,
    batchSize = SCAN_SIZE,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    let last: RawEntry | null = null;
    while (true) {
      const batch: RawEntry[] = await prisma.telemetryEntry.findMany({
        where: last
          ? {
              AND: [
                where,
                {
                  OR: [
                    { clientTime: { lt: last.clientTime } },
                    {
                      clientTime: last.clientTime,
                      receivedAt: { lt: last.receivedAt },
                    },
                    {
                      clientTime: last.clientTime,
                      receivedAt: last.receivedAt,
                      id: { lt: last.id },
                    },
                  ],
                },
              ],
            }
          : where,
        orderBy: [
          { clientTime: "desc" },
          { receivedAt: "desc" },
          { id: "desc" },
        ],
        take: batchSize,
      });
      for (const entry of batch) {
        if ((await visit(viewEntry(entry))) === false) return;
      }
      if (batch.length < batchSize) break;
      last = batch.at(-1)!;
    }
  }

  async timeline(input: TelemetryQueryInput): Promise<TelemetryTimelinePage> {
    const view = requireView(input.view);
    validateTelemetryQuery(input);
    const first = Math.min(
      MAX_FIRST,
      Math.max(1, input.first ?? DEFAULT_FIRST),
    );
    const after = cursor(input.after);
    const prisma = await getPrismaClient();
    const totalCount = await prisma.telemetryEntry.count({
      where: sourceWhere(view),
    });
    const filtersActive = hasActiveFilters(input);
    if (!filtersActive) {
      const items: TelemetryEntryView[] = [];
      let collected = 0;
      let hasMore = false;
      let lastEntry: TelemetryEntryView | null = null;
      let segmentHasCollectedEntry = false;
      const entryTypes = {
        entryType: { in: [...sourcesForView(view), "SEPARATOR"] },
      };
      await this.scan(
        after ? { AND: [entryTypes, olderThanCursorWhere(after)] } : entryTypes,
        (entry) => {
          if (entry.entryType === "SEPARATOR") {
            if (segmentHasCollectedEntry) items.push(entry);
            segmentHasCollectedEntry = false;
            return;
          }
          if (collected < first) {
            items.push(entry);
            collected += 1;
            lastEntry = entry;
            segmentHasCollectedEntry = true;
            return;
          }
          hasMore = true;
          return false;
        },
        Math.min(SCAN_SIZE, first + 1),
      );
      if (!lastEntry) {
        return {
          items: [],
          nextCursor: null,
          matchingCount: totalCount,
          totalCount,
        };
      }
      return {
        items,
        nextCursor: hasMore ? encodeCursor(lastEntry) : null,
        matchingCount: totalCount,
        totalCount,
      };
    }
    const items: TelemetryEntryView[] = [];
    let matchingCount = 0;
    let hasMore = false;
    let collected = 0;
    let lastEntry: TelemetryEntryView | null = null;
    let segmentHasCollectedEntry = false;
    let segmentHasOverflowEntry = false;
    const prefilter = databasePrefilter(input);
    await this.scan(
      prefilter
        ? {
            OR: [
              { entryType: "SEPARATOR" },
              { AND: [sourceWhere(view), prefilter] },
            ],
          }
        : { entryType: { in: [...sourcesForView(view), "SEPARATOR"] } },
      (entry) => {
        if (entry.entryType === "SEPARATOR") {
          const afterCursor = !after || olderThan(entry, after);
          if (
            afterCursor &&
            ((!filtersActive && !hasMore) ||
              (filtersActive &&
                segmentHasCollectedEntry &&
                !segmentHasOverflowEntry))
          ) {
            items.push(entry);
          }
          segmentHasCollectedEntry = false;
          segmentHasOverflowEntry = false;
          return;
        }
        if (!matchesTelemetryQuery(entry, input)) return;
        matchingCount += 1;
        if (after && !olderThan(entry, after)) return;
        if (collected < first) {
          items.push(entry);
          collected += 1;
          lastEntry = entry;
          segmentHasCollectedEntry = true;
        } else {
          hasMore = true;
          segmentHasOverflowEntry = true;
        }
      },
    );
    if (!lastEntry) {
      return { items: [], nextCursor: null, matchingCount, totalCount };
    }
    return {
      items,
      nextCursor: hasMore ? encodeCursor(lastEntry) : null,
      matchingCount,
      totalCount,
    };
  }

  async entries(ids: string[]): Promise<TelemetryEntryView[]> {
    const prisma = await getPrismaClient();
    const unique = [...new Set(ids)].slice(0, 1_000);
    const entries = await prisma.telemetryEntry.findMany({
      where: { id: { in: unique } },
    });
    return entries.map(viewEntry);
  }

  async entry(
    id: string,
    viewValue: string,
  ): Promise<TelemetryEntryView | null> {
    const view = requireView(viewValue);
    const entry = (await this.entries([id]))[0] ?? null;
    if (!entry) return null;
    if (
      entry.entryType === "SEPARATOR" ||
      !sourcesForView(view).includes(entry.entryType as "CONSOLE" | "ANALYTICS")
    ) {
      throw new Error(`Telemetry entry ${id} does not belong to ${view}`);
    }
    return entry;
  }

  async latestSeparator(): Promise<TelemetryEntryView | null> {
    const prisma = await getPrismaClient();
    const separator = await prisma.telemetryEntry.findFirst({
      where: { entryType: "SEPARATOR" },
      orderBy: [{ clientTime: "desc" }, { receivedAt: "desc" }, { id: "desc" }],
    });
    return separator ? viewEntry(separator) : null;
  }

  async separators(input: {
    first?: number | null;
    after?: string | null;
    kind?: string | null;
    name?: string | null;
    buildId?: string | null;
  }): Promise<TelemetrySeparatorPage> {
    const first = Math.min(MAX_FIRST, Math.max(1, input.first ?? 100));
    const after = cursor(input.after);
    const filters: Record<string, unknown>[] = [{ entryType: "SEPARATOR" }];
    if (input.kind?.trim()) {
      filters.push({ separatorKind: input.kind.trim() });
    }
    if (input.name?.trim()) {
      filters.push({ separatorName: { contains: input.name.trim() } });
    }
    if (input.buildId?.trim()) {
      filters.push({ buildId: input.buildId.trim() });
    }
    if (after) filters.push(olderThanCursorWhere(after));
    const prisma = await getPrismaClient();
    const rows = await prisma.telemetryEntry.findMany({
      where: { AND: filters } as never,
      orderBy: [{ clientTime: "desc" }, { receivedAt: "desc" }, { id: "desc" }],
      take: first + 1,
    });
    const hasMore = rows.length > first;
    const items = rows.slice(0, first).map(viewEntry);
    return {
      items,
      nextCursor: hasMore && items.length ? encodeCursor(items.at(-1)!) : null,
    };
  }

  async timelineSinceLatestSeparator(
    input: TelemetryQueryInput,
  ): Promise<TelemetrySinceSeparatorPage> {
    const view = requireView(input.view);
    validateTelemetryQuery(input);
    const first = Math.min(
      MAX_FIRST,
      Math.max(1, input.first ?? DEFAULT_FIRST),
    );
    const after = cursor(input.after);
    const separator = await this.latestSeparator();
    const boundary = separator
      ? {
          clientTime: separator.clientTime,
          receivedAt: separator.receivedAt,
          id: separator.id,
        }
      : null;
    const filtersActive = hasActiveFilters(input);
    const rangeWhere = boundary
      ? { AND: [sourceWhere(view), newerThanCursorWhere(boundary)] }
      : sourceWhere(view);
    if (!filtersActive) {
      const prisma = await getPrismaClient();
      const totalCount = await prisma.telemetryEntry.count({
        where: rangeWhere,
      });
      const items: TelemetryEntryView[] = [];
      let hasMore = false;
      let lastEntry: TelemetryEntryView | null = null;
      await this.scan(
        after ? { AND: [rangeWhere, olderThanCursorWhere(after)] } : rangeWhere,
        (entry) => {
          if (items.length < first) {
            items.push(entry);
            lastEntry = entry;
            return;
          }
          hasMore = true;
          return false;
        },
        Math.min(SCAN_SIZE, first + 1),
      );
      return {
        separator,
        items,
        nextCursor: hasMore && lastEntry ? encodeCursor(lastEntry) : null,
        matchingCount: totalCount,
        totalCount,
      };
    }
    const items: TelemetryEntryView[] = [];
    let matchingCount = 0;
    let totalCount = 0;
    let hasMore = false;
    let lastEntry: TelemetryEntryView | null = null;
    await this.scan(rangeWhere, (entry) => {
      totalCount += 1;
      if (!matchesTelemetryQuery(entry, input)) return;
      matchingCount += 1;
      if (after && !olderThan(entry, after)) return;
      if (items.length < first) {
        items.push(entry);
        lastEntry = entry;
      } else {
        hasMore = true;
      }
    });
    return {
      separator,
      items,
      nextCursor: hasMore && lastEntry ? encodeCursor(lastEntry) : null,
      matchingCount,
      totalCount,
    };
  }

  async facets(viewValue: string): Promise<TelemetryFacets> {
    const view = requireView(viewValue);
    const names =
      view === "CONSOLE"
        ? ["level", "category", "deviceIp", "buildId", "sessionId"]
        : view === "ANALYTICS"
          ? [
              "eventKind",
              "eventName",
              "screenName",
              "deviceIp",
              "buildId",
              "sessionId",
            ]
          : [
              "source",
              "level",
              "eventKind",
              "deviceIp",
              "buildId",
              "sessionId",
            ];
    const values = Object.fromEntries(
      names.map((name) => [name, new Set<string>()]),
    );
    await this.scan(sourceWhere(view), (entry) => {
      const fields = fieldsForFacet(entry);
      for (const name of names) {
        const value = fields[name];
        if (value !== null && value !== undefined && String(value) !== "")
          values[name]!.add(String(value));
      }
      if (view === "UNIFIED") values.source!.add(entry.entryType);
    });
    return Object.fromEntries(
      Object.entries(values).map(([name, entries]) => [
        name,
        [...entries].sort((a, b) => a.localeCompare(b)),
      ]),
    );
  }

  async fields(viewValue: string): Promise<string[]> {
    const view = requireView(viewValue);
    const fields = new Set<string>();
    await this.scan(sourceWhere(view), (entry) => {
      for (const field of Object.keys(fieldsForFacet(entry))) fields.add(field);
    });
    return [...fields].sort((left, right) => left.localeCompare(right));
  }

  async addSeparator(nameValue?: string | null): Promise<TelemetryEntryView> {
    const name = nameValue?.trim() || null;
    if (name && name.length > 100)
      throw new Error("Separator name must not exceed 100 characters");
    const prisma = await getPrismaClient();
    const entry = await prisma.telemetryEntry.create({
      data: {
        id: randomUUID(),
        entryType: "SEPARATOR",
        clientTime: new Date(),
        receivedAt: new Date(),
        separatorKind: "MANUAL",
        separatorName: name,
      },
    });
    this.publish([entry.id], "SEPARATOR_ADDED");
    return viewEntry(entry);
  }

  async addBuildSeparator(input: {
    buildId: string;
    name: string;
    clientTime?: Date;
  }): Promise<TelemetryEntryView> {
    const prisma = await getPrismaClient();
    const entry = await prisma.telemetryEntry.upsert({
      where: {
        separatorKind_buildId: {
          separatorKind: "BUILD",
          buildId: input.buildId,
        },
      },
      create: {
        id: randomUUID(),
        entryType: "SEPARATOR",
        clientTime: input.clientTime ?? new Date(),
        receivedAt: new Date(),
        separatorKind: "BUILD",
        separatorName: input.name.slice(0, 100),
        buildId: input.buildId,
      },
      update: {},
    });
    this.publish([entry.id], "BUILD_SEPARATOR_ADDED");
    return viewEntry(entry);
  }

  async highlight(
    id: string,
    color: string | null,
  ): Promise<TelemetryEntryView> {
    if (
      color !== null &&
      !TELEMETRY_COLORS.includes(color as (typeof TELEMETRY_COLORS)[number])
    ) {
      throw new Error("Unknown telemetry highlight color");
    }
    const prisma = await getPrismaClient();
    const current = await prisma.telemetryEntry.findUniqueOrThrow({
      where: { id },
    });
    if (current.entryType === "SEPARATOR")
      throw new Error("Separators cannot be highlighted");
    const entry = await prisma.telemetryEntry.update({
      where: { id },
      data: { highlightColor: color },
    });
    this.publish([id], "HIGHLIGHT_CHANGED");
    return viewEntry(entry);
  }

  private selectionRanges(selection: TelemetrySelection): Array<{
    start: number | null;
    end: number | null;
    includeSeparators: boolean;
  }> {
    const ranges = Array.isArray(selection.ranges)
      ? selection.ranges.slice(0, 500)
      : [];
    return ranges.map((range: TelemetrySelectionRange) => {
      if (!range || typeof range !== "object") {
        throw new Error("Invalid telemetry selection range");
      }
      const start = range.startTime ? Date.parse(range.startTime) : null;
      const end = range.endTime ? Date.parse(range.endTime) : null;
      if (
        (start !== null && !Number.isFinite(start)) ||
        (end !== null && !Number.isFinite(end)) ||
        (start !== null && end !== null && start >= end)
      ) {
        throw new Error("Invalid telemetry selection range");
      }
      return {
        start,
        end,
        includeSeparators: range.includeSeparators === true,
      };
    });
  }

  private async selectionIds(selection: TelemetrySelection): Promise<string[]> {
    const ids = new Set(
      (Array.isArray(selection.ids) ? selection.ids : [])
        .filter((id): id is string => typeof id === "string")
        .slice(0, 100_000),
    );
    const excluded = new Set(
      (Array.isArray(selection.excludedIds) ? selection.excludedIds : [])
        .filter((id): id is string => typeof id === "string")
        .slice(0, 100_000),
    );
    if (!selection.query) {
      for (const id of excluded) ids.delete(id);
      return [...ids];
    }
    if (typeof selection.query !== "object" || Array.isArray(selection.query)) {
      throw new Error("Invalid telemetry selection query");
    }
    requireView(selection.query.view);
    validateTelemetryQuery(selection.query);
    const ranges = this.selectionRanges(selection);
    await this.scan(
      selection.includeSeparators ||
        ranges.some((range) => range.includeSeparators)
        ? {
            entryType: {
              in: [...sourcesForView(selection.query.view), "SEPARATOR"],
            },
          }
        : sourceWhere(selection.query.view),
      (entry) => {
        const time = Date.parse(entry.clientTime);
        const matchingRanges = ranges.filter(
          (range) =>
            (range.start === null || time >= range.start) &&
            (range.end === null || time < range.end),
        );
        if (ranges.length > 0 && matchingRanges.length === 0) return;
        if (excluded.has(entry.id)) return;
        if (entry.entryType === "SEPARATOR") {
          if (
            selection.includeSeparators ||
            matchingRanges.some((range) => range.includeSeparators)
          ) {
            ids.add(entry.id);
          }
          return;
        }
        if (matchesTelemetryQuery(entry, selection.query!)) ids.add(entry.id);
      },
    );
    return [...ids];
  }

  async clearSelected(selection: TelemetrySelection): Promise<number> {
    const ids = await this.selectionIds(selection);
    if (!ids.length) return 0;
    const prisma = await getPrismaClient();
    let count = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
      const result = await prisma.telemetryEntry.deleteMany({
        where: { id: { in: ids.slice(offset, offset + 500) } },
      });
      count += result.count;
    }
    this.publish([], "CLEARED");
    return count;
  }

  async clearAll(
    viewValue: string,
    includeSeparators = false,
  ): Promise<number> {
    const view = requireView(viewValue);
    const prisma = await getPrismaClient();
    const result = await prisma.telemetryEntry.deleteMany({
      where: includeSeparators
        ? { entryType: { in: [...sourcesForView(view), "SEPARATOR"] } }
        : sourceWhere(view),
    });
    this.publish([], includeSeparators ? "CLEARED_WITH_SEPARATORS" : "CLEARED");
    return result.count;
  }

  async clearBeforeLatestSeparator(
    viewValue: string,
    includeSeparators = false,
  ): Promise<number> {
    const view = requireView(viewValue);
    const separator = await this.latestSeparator();
    if (!separator) return 0;
    const prisma = await getPrismaClient();
    const result = await prisma.telemetryEntry.deleteMany({
      where: {
        AND: [
          includeSeparators
            ? { entryType: { in: [...sourcesForView(view), "SEPARATOR"] } }
            : sourceWhere(view),
          olderThanCursorWhere({
            clientTime: separator.clientTime,
            receivedAt: separator.receivedAt,
            id: separator.id,
          }),
        ],
      } as never,
    });
    this.publish([], "CLEARED_BEFORE_SEPARATOR");
    return result.count;
  }

  async clearScoped(input: {
    view: TelemetryView;
    scope: "IDS" | "MATCHING" | "ALL" | "BEFORE_LATEST_SEPARATOR";
    ids?: string[] | null;
    query?: Omit<TelemetryQueryInput, "view" | "first" | "after"> | null;
    includeSeparators?: boolean | null;
  }): Promise<number> {
    const view = requireView(input.view);
    if (input.scope === "ALL") {
      return this.clearAll(view, Boolean(input.includeSeparators));
    }
    if (input.scope === "BEFORE_LATEST_SEPARATOR") {
      return this.clearBeforeLatestSeparator(
        view,
        Boolean(input.includeSeparators),
      );
    }
    if (input.scope === "MATCHING") {
      if (!input.query) throw new Error("A matching query is required");
      return this.clearSelected({ query: { ...input.query, view } });
    }
    const ids = [...new Set(input.ids ?? [])].slice(0, 1_000);
    if (!ids.length)
      throw new Error("At least one telemetry entry ID is required");
    const prisma = await getPrismaClient();
    const allowed = await prisma.telemetryEntry.findMany({
      where: {
        id: { in: ids },
        entryType: { in: [...sourcesForView(view), "SEPARATOR"] },
      },
      select: { id: true },
    });
    if (!allowed.length) return 0;
    const result = await prisma.telemetryEntry.deleteMany({
      where: { id: { in: allowed.map(({ id }) => id) } },
    });
    this.publish([], "CLEARED");
    return result.count;
  }

  async viewSettings(viewValue: string): Promise<TelemetryViewSettingsView> {
    const view = requireView(viewValue);
    const prisma = await getPrismaClient();
    const settings = await prisma.telemetryViewSettings.upsert({
      where: { view },
      create: {
        id: view,
        view,
        columnsJson: JSON.stringify(DEFAULT_TELEMETRY_COLUMNS[view]),
      },
      update: {},
    });
    return {
      view,
      columns: parseColumns(settings.columnsJson, view),
      timeFormat: settings.timeFormat === "24" ? "24" : "12",
      activeColumnPresetId: settings.activeColumnPresetId,
      activeSavedFilterId: settings.activeSavedFilterId,
    };
  }

  async saveViewSettings(input: {
    view: string;
    columns?: string[] | null;
    timeFormat?: string | null;
    activeColumnPresetId?: string | null;
    activeSavedFilterId?: string | null;
  }): Promise<TelemetryViewSettingsView> {
    const view = requireView(input.view);
    if (input.timeFormat && !["12", "24"].includes(input.timeFormat))
      throw new Error("Unknown time format");
    const current = await this.viewSettings(view);
    const prisma = await getPrismaClient();
    await prisma.telemetryViewSettings.upsert({
      where: { view },
      create: {
        id: view,
        view,
        columnsJson: serializeColumns(input.columns ?? current.columns),
        timeFormat: input.timeFormat ?? current.timeFormat,
        activeColumnPresetId: input.activeColumnPresetId ?? null,
        activeSavedFilterId: input.activeSavedFilterId ?? null,
      },
      update: {
        columnsJson: input.columns
          ? serializeColumns(input.columns)
          : undefined,
        timeFormat: input.timeFormat ?? undefined,
        activeColumnPresetId:
          input.activeColumnPresetId === undefined
            ? undefined
            : input.activeColumnPresetId,
        activeSavedFilterId:
          input.activeSavedFilterId === undefined
            ? undefined
            : input.activeSavedFilterId,
      },
    });
    return this.viewSettings(view);
  }

  async columnPresets(viewValue: string): Promise<TelemetryColumnPresetView[]> {
    const view = requireView(viewValue);
    const prisma = await getPrismaClient();
    const presets = await prisma.telemetryColumnPreset.findMany({
      where: { view },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    return presets.map((preset) => ({
      id: preset.id,
      view,
      name: preset.name,
      columns: parseColumns(preset.columnsJson, view),
      isDefault: preset.isDefault,
      createdAt: preset.createdAt.toISOString(),
      updatedAt: preset.updatedAt.toISOString(),
    }));
  }

  async saveColumnPreset(input: {
    id?: string | null;
    view: string;
    name: string;
    columns: string[];
    isDefault?: boolean | null;
  }): Promise<TelemetryColumnPresetView> {
    const view = requireView(input.view);
    const { name, normalizedName } = normalizeName(input.name);
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    await prisma.$transaction(async (transaction) => {
      if (input.isDefault) {
        await transaction.telemetryColumnPreset.updateMany({
          where: { view },
          data: { isDefault: false },
        });
      }
      await transaction.telemetryColumnPreset.upsert({
        where: { id },
        create: {
          id,
          view,
          name,
          normalizedName,
          columnsJson: serializeColumns(input.columns),
          isDefault: input.isDefault === true,
        },
        update: {
          name,
          normalizedName,
          columnsJson: serializeColumns(input.columns),
          isDefault: input.isDefault ?? undefined,
        },
      });
    });
    return (await this.columnPresets(view)).find((preset) => preset.id === id)!;
  }

  async deleteColumnPreset(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.telemetryViewSettings.updateMany({
      where: { activeColumnPresetId: id },
      data: { activeColumnPresetId: null },
    });
    return (
      (await prisma.telemetryColumnPreset.deleteMany({ where: { id } })).count >
      0
    );
  }

  async savedFilters(viewValue: string): Promise<TelemetrySavedFilterView[]> {
    const view = requireView(viewValue);
    const prisma = await getPrismaClient();
    const filters = await prisma.telemetrySavedFilter.findMany({
      where: { view },
      orderBy: { name: "asc" },
    });
    return filters.map((filter) => ({
      id: filter.id,
      view,
      name: filter.name,
      definition: JSON.parse(
        filter.definitionJson,
      ) as TelemetryFilterDefinition,
      createdAt: filter.createdAt.toISOString(),
      updatedAt: filter.updatedAt.toISOString(),
    }));
  }

  async saveFilter(input: {
    id?: string | null;
    view: string;
    name: string;
    definition: TelemetryFilterDefinition;
  }): Promise<TelemetrySavedFilterView> {
    const view = requireView(input.view);
    validateTelemetryQuery({ view, advancedFilter: input.definition });
    const { name, normalizedName } = normalizeName(input.name);
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    await prisma.telemetrySavedFilter.upsert({
      where: { id },
      create: {
        id,
        view,
        name,
        normalizedName,
        definitionJson: stableJson(input.definition),
      },
      update: {
        name,
        normalizedName,
        definitionJson: stableJson(input.definition),
      },
    });
    return (await this.savedFilters(view)).find((filter) => filter.id === id)!;
  }

  async deleteFilter(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.telemetryViewSettings.updateMany({
      where: { activeSavedFilterId: id },
      data: { activeSavedFilterId: null },
    });
    return (
      (await prisma.telemetrySavedFilter.deleteMany({ where: { id } })).count >
      0
    );
  }

  async exportEntries(input: {
    query: TelemetryQueryInput;
    ids?: string[] | null;
    selection?: TelemetrySelection | null;
  }): Promise<TelemetryEntryView[]> {
    validateTelemetryQuery(input.query);
    const selection =
      input.selection ?? (input.ids?.length ? { ids: input.ids } : null);
    if (selection) {
      const selected = new Set(await this.selectionIds(selection));
      const entries: TelemetryEntryView[] = [];
      const ids = [...selected];
      for (let offset = 0; offset < ids.length; offset += 500) {
        await this.scan(
          { id: { in: ids.slice(offset, offset + 500) } },
          (entry) => {
            entries.push(entry);
          },
        );
      }
      entries.sort((left, right) => {
        const time = right.clientTime.localeCompare(left.clientTime);
        if (time) return time;
        const received = right.receivedAt.localeCompare(left.receivedAt);
        return received || right.id.localeCompare(left.id);
      });
      return entries;
    }
    const entries: TelemetryEntryView[] = [];
    let segmentHasMatch = false;
    const filtersActive = hasActiveFilters(input.query);
    await this.scan(
      { entryType: { in: [...sourcesForView(input.query.view), "SEPARATOR"] } },
      (entry) => {
        if (entry.entryType === "SEPARATOR") {
          if (!filtersActive || segmentHasMatch) entries.push(entry);
          segmentHasMatch = false;
        } else if (matchesTelemetryQuery(entry, input.query)) {
          entries.push(entry);
          segmentHasMatch = true;
        }
      },
    );
    return entries;
  }
}
