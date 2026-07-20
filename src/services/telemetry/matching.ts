import { RE2 } from "re2-wasm";

import {
  telemetryDisplay,
  telemetryFields,
  telemetrySearchText,
} from "./fields";
import {
  TELEMETRY_FILTER_OPERATORS,
  TELEMETRY_SEARCH_MODES,
  type TelemetryEntryView,
  type TelemetryFilterCondition,
  type TelemetryFilterDefinition,
  type TelemetryQueryInput,
  type TelemetrySearchMode,
  type TelemetryView,
} from "./types";

export {
  flattenTelemetryObject,
  stableJson,
  telemetryFields,
  telemetrySearchText,
} from "./fields";

const MAX_PATTERN_LENGTH = 1024;
const MAX_MATCHER_CACHE_SIZE = 100;
const matcherCache = new Map<string, (value: string) => boolean>();

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
  const cacheKey = `${mode}\u0000${caseSensitive ? "1" : "0"}\u0000${pattern}`;
  const cached = matcherCache.get(cacheKey);
  if (cached) return cached;
  let match: (value: string) => boolean;
  if (mode === "TEXT") {
    const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
    match = (value) =>
      (caseSensitive ? value : value.toLocaleLowerCase()).includes(needle);
  } else {
    const source = mode === "GLOB" ? `^${globSource(pattern)}$` : pattern;
    const flags = caseSensitive ? "su" : "isu";
    const regex =
      mode === "REGEX" ? new RE2(source, flags) : new RegExp(source, flags);
    match = (value) => regex.test(value);
  }
  matcherCache.set(cacheKey, match);
  if (matcherCache.size > MAX_MATCHER_CACHE_SIZE) {
    matcherCache.delete(matcherCache.keys().next().value!);
  }
  return match;
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
  const value = telemetryDisplay(raw);
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
    return selected.includes(telemetryDisplay(fields[field]));
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
