import type {
  AnalyticsEventInput,
  ConsoleLogInput,
  TelemetryJsonObject,
} from "./types";

export const TELEMETRY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const TELEMETRY_MAX_BATCH_SIZE = 500;
const MAX_FIELD_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 64 * 1024;
const MAX_DICTIONARY_BYTES = 512 * 1024;
const MAX_DICTIONARY_DEPTH = 10;
const MAX_DICTIONARY_PATHS = 500;

export class TelemetryValidationError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_PAYLOAD",
    readonly status = 400,
  ) {
    super(message);
  }
}

function objectValue(value: unknown, label: string): TelemetryJsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TelemetryValidationError(`${label} must be a JSON object`);
  }
  return value as TelemetryJsonObject;
}

function exactKeys(
  value: TelemetryJsonObject,
  expected: readonly string[],
  label: string,
  ignored: readonly string[] = [],
) {
  const unknown = Object.keys(value).filter(
    (key) => !expected.includes(key) && !ignored.includes(key),
  );
  if (unknown.length > 0) {
    throw new TelemetryValidationError(
      `${label} contains unknown field ${JSON.stringify(unknown[0])}`,
    );
  }
  const missing = expected.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new TelemetryValidationError(
      `${label} is missing required field ${JSON.stringify(missing[0])}`,
    );
  }
}

const SERVER_FIELDS = [
  "id",
  "entryType",
  "receivedAt",
  "deviceIp",
  "highlightColor",
  "separatorKind",
  "separatorName",
] as const;

function stringValue(
  value: unknown,
  label: string,
  maximum = MAX_FIELD_LENGTH,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TelemetryValidationError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new TelemetryValidationError(
      `${label} must not exceed ${maximum} characters`,
    );
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = stringValue(value, label);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    throw new TelemetryValidationError(
      `${label} must be an ISO-8601 timestamp with a UTC offset`,
    );
  }
  const time = Date.parse(text);
  if (!Number.isFinite(time)) {
    throw new TelemetryValidationError(`${label} is not a valid timestamp`);
  }
  return new Date(time).toISOString();
}

function validateJsonValue(
  value: unknown,
  label: string,
  depth: number,
  counter: { paths: number },
): void {
  if (depth > MAX_DICTIONARY_DEPTH) {
    throw new TelemetryValidationError(
      `${label} exceeds the maximum JSON depth of ${MAX_DICTIONARY_DEPTH}`,
    );
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TelemetryValidationError(`${label} must be a finite number`);
    }
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_FIELD_LENGTH) {
      throw new TelemetryValidationError(
        `${label} string values must not exceed ${MAX_FIELD_LENGTH} characters`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJsonValue(value[index], `${label}[${index}]`, depth + 1, counter);
    }
    return;
  }
  const object = objectValue(value, label);
  for (const [key, item] of Object.entries(object)) {
    if (key.length === 0 || key.length > MAX_FIELD_LENGTH) {
      throw new TelemetryValidationError(
        `${label} keys must contain 1-${MAX_FIELD_LENGTH} characters`,
      );
    }
    counter.paths += 1;
    if (counter.paths > MAX_DICTIONARY_PATHS) {
      throw new TelemetryValidationError(
        `${label} must not exceed ${MAX_DICTIONARY_PATHS} paths`,
      );
    }
    validateJsonValue(item, `${label}.${key}`, depth + 1, counter);
  }
}

function dictionary(value: unknown, label: string): TelemetryJsonObject {
  const object = objectValue(value, label);
  validateJsonValue(object, label, 0, { paths: 0 });
  const bytes = new TextEncoder().encode(JSON.stringify(object)).byteLength;
  if (bytes > MAX_DICTIONARY_BYTES) {
    throw new TelemetryValidationError(
      `${label} must not exceed ${MAX_DICTIONARY_BYTES} serialized bytes`,
    );
  }
  return object;
}

const CONSOLE_FIELDS = [
  "message",
  "time",
  "level",
  "category",
  "buildId",
  "sessionId",
  "attributes",
] as const;

const ANALYTICS_FIELDS = [
  "eventName",
  "kind",
  "screenName",
  "time",
  "defaultParameters",
  "additionalParameters",
  "buildId",
  "sessionId",
] as const;

export function parseConsoleLog(
  value: unknown,
  label = "console log",
): ConsoleLogInput {
  const object = objectValue(value, label);
  exactKeys(object, CONSOLE_FIELDS, label, SERVER_FIELDS);
  return {
    message: stringValue(
      object.message,
      `${label}.message`,
      MAX_MESSAGE_LENGTH,
    ),
    time: timestamp(object.time, `${label}.time`),
    level: stringValue(object.level, `${label}.level`),
    category: stringValue(object.category, `${label}.category`),
    buildId: stringValue(object.buildId, `${label}.buildId`),
    sessionId: stringValue(object.sessionId, `${label}.sessionId`),
    attributes: dictionary(object.attributes, `${label}.attributes`),
  };
}

export function parseAnalyticsEvent(
  value: unknown,
  label = "analytics event",
): AnalyticsEventInput {
  const object = objectValue(value, label);
  exactKeys(object, ANALYTICS_FIELDS, label, SERVER_FIELDS);
  return {
    eventName: stringValue(object.eventName, `${label}.eventName`),
    kind: stringValue(object.kind, `${label}.kind`),
    screenName: stringValue(object.screenName, `${label}.screenName`),
    time: timestamp(object.time, `${label}.time`),
    defaultParameters: dictionary(
      object.defaultParameters,
      `${label}.defaultParameters`,
    ),
    additionalParameters: dictionary(
      object.additionalParameters,
      `${label}.additionalParameters`,
    ),
    buildId: stringValue(object.buildId, `${label}.buildId`),
    sessionId: stringValue(object.sessionId, `${label}.sessionId`),
  };
}

export function parseIngestionBody<T>(
  value: unknown,
  parse: (item: unknown, label: string) => T,
): T[] {
  const isBatch =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "items");
  const raw = isBatch
    ? (() => {
        const object = objectValue(value, "request");
        exactKeys(object, ["items"], "request");
        if (!Array.isArray(object.items)) {
          throw new TelemetryValidationError("request.items must be an array");
        }
        return object.items;
      })()
    : [value];
  if (raw.length === 0 || raw.length > TELEMETRY_MAX_BATCH_SIZE) {
    throw new TelemetryValidationError(
      `request must contain 1-${TELEMETRY_MAX_BATCH_SIZE} items`,
    );
  }
  return raw.map((item, index) => parse(item, `items[${index}]`));
}
