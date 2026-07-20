import type { TelemetryEntryView, TelemetryJsonObject } from "./types";

const SAFE_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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

export function telemetryDisplay(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return stableJson(value);
}

export function telemetrySearchText(entry: TelemetryEntryView): string {
  return Object.entries(telemetryFields(entry))
    .flatMap(([key, value]) => [key, telemetryDisplay(value)])
    .join("\n");
}
