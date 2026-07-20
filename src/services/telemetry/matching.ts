import {
  TELEMETRY_FILTER_OPERATORS,
  TELEMETRY_SEARCH_MODES,
  type TelemetryEntryView,
  type TelemetryFilterCondition,
  type TelemetryFilterDefinition,
  type TelemetryJsonObject,
  type TelemetryQueryInput,
  type TelemetrySearchMode,
  type TelemetryView,
} from "./types";

const SAFE_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_PATTERN_LENGTH = 1024;

function stable(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableJson(value: unknown): string {
  return stable(value);
}

function segment(key: string): string {
  return SAFE_SEGMENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

export function flattenTelemetryObject(
  prefix: string,
  value: TelemetryJsonObject,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const visit = (path: string, item: unknown) => {
    if (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length === 0) output[path] = item;
      else
        for (const [key, nested] of entries)
          visit(`${path}${segment(key)}`, nested);
    } else {
      output[path] = item;
    }
  };
  for (const [key, item] of Object.entries(value))
    visit(`${prefix}${segment(key)}`, item);
  return output;
}

export function telemetryFields(
  entry: TelemetryEntryView,
): Record<string, unknown> {
  const parameters = {
    default: entry.defaultParameters,
    additional: entry.additionalParameters,
  };
  const fields: Record<string, unknown> = {
    source: entry.entryType,
    time: entry.clientTime,
    receivedAt: entry.receivedAt,
    deviceIp: entry.deviceIp,
    message: entry.message,
    level: entry.level,
    category: entry.category,
    eventName: entry.eventName,
    eventKind: entry.eventKind,
    levelKind: entry.level ?? entry.eventKind,
    screenName: entry.screenName,
    buildId: entry.buildId,
    sessionId: entry.sessionId,
    attributes: entry.attributes,
    defaultParameters: entry.defaultParameters,
    additionalParameters: entry.additionalParameters,
    parameters,
    detail:
      entry.entryType === "CONSOLE"
        ? entry.message
        : `${entry.eventName ?? ""}${entry.screenName ? ` (${entry.screenName})` : ""}`,
  };
  return {
    ...fields,
    ...flattenTelemetryObject("attributes", entry.attributes),
    ...flattenTelemetryObject("defaultParameters", entry.defaultParameters),
    ...flattenTelemetryObject(
      "additionalParameters",
      entry.additionalParameters,
    ),
  };
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return stableJson(value);
}

export function telemetrySearchText(entry: TelemetryEntryView): string {
  return Object.entries(telemetryFields(entry))
    .flatMap(([key, value]) => [key, display(value)])
    .join("\n");
}

function assertPattern(pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern must not exceed ${MAX_PATTERN_LENGTH} characters`);
  }
}

function globSource(pattern: string): string {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") output += ".*";
    else if (character === "?") output += ".";
    else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) throw new Error("Invalid glob pattern: missing ]");
      else {
        const body = pattern.slice(index + 1, end).replace(/^!/, "^");
        output += `[${body}]`;
        index = end;
      }
    } else output += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return output;
}

function matcher(
  mode: TelemetrySearchMode,
  pattern: string,
  caseSensitive: boolean,
): (value: string) => boolean {
  assertPattern(pattern);
  if (!TELEMETRY_SEARCH_MODES.includes(mode))
    throw new Error("Unknown search mode");
  if (mode === "TEXT") {
    const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
    return (value) =>
      (caseSensitive ? value : value.toLocaleLowerCase()).includes(needle);
  }
  const source = mode === "GLOB" ? `^${globSource(pattern)}$` : pattern;
  const regex = new RegExp(source, caseSensitive ? "su" : "isu");
  return (value) => regex.test(value);
}

function empty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0)
  );
}

function applies(
  condition: TelemetryFilterCondition,
  entry: TelemetryEntryView,
): boolean {
  if (!condition.sources?.length) return true;
  if (entry.entryType === "SEPARATOR") return false;
  return condition.sources.includes(entry.entryType);
}

function matchesCondition(
  entry: TelemetryEntryView,
  fields: Record<string, unknown>,
  condition: TelemetryFilterCondition,
): boolean {
  if (!TELEMETRY_FILTER_OPERATORS.includes(condition.operator)) {
    throw new Error("Unknown filter operator");
  }
  const raw = fields[condition.field];
  if (condition.operator === "IS_EMPTY") return empty(raw);
  if (condition.operator === "IS_NOT_EMPTY") return !empty(raw);
  const value = display(raw);
  const expected = condition.value ?? "";
  const sensitive = condition.caseSensitive === true;
  const actualComparison = sensitive ? value : value.toLocaleLowerCase();
  const expectedComparison = sensitive
    ? expected
    : expected.toLocaleLowerCase();
  if (condition.operator === "CONTAINS")
    return actualComparison.includes(expectedComparison);
  if (condition.operator === "DOES_NOT_CONTAIN")
    return !actualComparison.includes(expectedComparison);
  if (condition.operator === "IS")
    return actualComparison === expectedComparison;
  if (condition.operator === "IS_NOT")
    return actualComparison !== expectedComparison;
  if (condition.operator === "MATCHES_GLOB")
    return matcher("GLOB", expected, sensitive)(value);
  const regexMatch = matcher("REGEX", expected, sensitive)(value);
  return condition.operator === "MATCHES_REGEX" ? regexMatch : !regexMatch;
}

function matchesAdvanced(
  entry: TelemetryEntryView,
  definition: TelemetryFilterDefinition | null | undefined,
): boolean {
  if (!definition?.conditions.length) return true;
  const conditions = definition.conditions.filter((condition) =>
    applies(condition, entry),
  );
  if (conditions.length === 0) return true;
  const fields = telemetryFields(entry);
  const values = conditions.map((condition) =>
    matchesCondition(entry, fields, condition),
  );
  return definition.mode === "ANY"
    ? values.some(Boolean)
    : values.every(Boolean);
}

function matchesQuick(
  entry: TelemetryEntryView,
  quick: Record<string, string[]> | null | undefined,
): boolean {
  if (!quick) return true;
  const fields = telemetryFields(entry);
  return Object.entries(quick).every(([field, selected]) => {
    if (selected.length === 0) return true;
    return selected.includes(display(fields[field]));
  });
}

export function sourcesForView(
  view: TelemetryView,
): Array<"CONSOLE" | "ANALYTICS"> {
  if (view === "CONSOLE") return ["CONSOLE"];
  if (view === "ANALYTICS") return ["ANALYTICS"];
  return ["CONSOLE", "ANALYTICS"];
}

export function matchesTelemetryQuery(
  entry: TelemetryEntryView,
  query: TelemetryQueryInput,
): boolean {
  if (entry.entryType === "SEPARATOR") return false;
  if (!sourcesForView(query.view).includes(entry.entryType)) return false;
  if (query.search) {
    const match = matcher(
      query.searchMode ?? "TEXT",
      query.search,
      query.caseSensitive === true,
    );
    if (!match(telemetrySearchText(entry))) return false;
  }
  return (
    matchesQuick(entry, query.quickFilters) &&
    matchesAdvanced(entry, query.advancedFilter)
  );
}

export function validateTelemetryQuery(query: TelemetryQueryInput): void {
  if (query.search)
    matcher(
      query.searchMode ?? "TEXT",
      query.search,
      query.caseSensitive === true,
    );
  for (const condition of query.advancedFilter?.conditions ?? []) {
    if (
      ["MATCHES_GLOB", "MATCHES_REGEX", "NO_REGEX_MATCH"].includes(
        condition.operator,
      )
    ) {
      matcher(
        condition.operator === "MATCHES_GLOB" ? "GLOB" : "REGEX",
        condition.value ?? "",
        condition.caseSensitive === true,
      );
    }
  }
}

export function fieldsForFacet(
  entry: TelemetryEntryView,
): Record<string, unknown> {
  return telemetryFields(entry);
}
