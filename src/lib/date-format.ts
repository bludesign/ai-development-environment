/**
 * Central date/time formatting for the whole app.
 *
 * Four kinds — `long`, `short`, `time`, `relative` — each honouring a 12/24-hour
 * choice (12 by default) and an optional UTC pin. Pure functions only, so this
 * module is usable from server code (telemetry export) as well as from the
 * `<DateTime>` component that wraps it for UI.
 */

export type DateInput = string | number | Date | null | undefined;

export type DateKind = "long" | "short" | "time" | "relative";

export type DateFormatOptions = {
  /** BCP 47 tag. Components pass `useLocale()`. */
  locale?: string;
  /** 12-hour clock. Defaults to true. */
  hour12?: boolean;
  /** Pin to UTC instead of the viewer's zone. Shorthand for `timeZone: "UTC"`. */
  utc?: boolean;
  /** Pin to a specific IANA zone. Ignored when `utc` is set. */
  timeZone?: string;
  /** Include the time component. `long`/`short` only, defaults to true. */
  showTime?: boolean;
  /** Reference point for `relative`. Defaults to `Date.now()`. */
  now?: number;
  /** Rendered when the value is missing or unparseable. */
  fallback?: string;
};

export const DATE_FALLBACK = "—";

const DEFAULT_LOCALE = "en";

/** Parses any accepted input, returning null when there is no usable date. */
export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// Constructing an Intl formatter is far more expensive than calling one, and
// these run per row on long tables. Cache by every option that affects output.
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function dateTimeFormatter(
  key: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const cached = dateTimeFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateTimeFormatters.set(key, formatter);
  return formatter;
}

function relativeFormatter(locale: string): Intl.RelativeTimeFormat {
  const cached = relativeFormatters.get(locale);
  if (cached) return cached;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  relativeFormatters.set(locale, formatter);
  return formatter;
}

/**
 * `hourCycle` rather than `hour12`: the boolean degrades silently on locales
 * whose default cycle is already 24-hour.
 */
function intlOptions(
  kind: Exclude<DateKind, "relative">,
  hour12: boolean,
  timeZone: string | undefined,
  showTime: boolean,
): Intl.DateTimeFormatOptions {
  const clock = {
    hourCycle: (hour12
      ? "h12"
      : "h23") as Intl.DateTimeFormatOptions["hourCycle"],
  };
  const zone = timeZone ? { timeZone } : {};

  if (kind === "time") {
    return { timeStyle: "medium", ...clock, ...zone };
  }

  const dateStyle = kind === "long" ? ("full" as const) : ("medium" as const);
  return showTime
    ? { dateStyle, timeStyle: "medium", ...clock, ...zone }
    : { dateStyle, ...zone };
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
];

/** "9 hours ago". Falls through to the largest unit that fits. */
export function formatRelativeTime(
  date: Date,
  locale: string,
  now: number,
): string {
  const seconds = Math.round((date.getTime() - now) / 1_000);
  const formatter = relativeFormatter(locale);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}

/**
 * The single formatting entry point.
 *
 * | kind     | showTime | example (en-US)                          |
 * | -------- | -------- | ---------------------------------------- |
 * | long     | true     | Wednesday, July 22, 2026 at 3:01:37 AM   |
 * | long     | false    | Wednesday, July 22, 2026                 |
 * | short    | true     | Jul 22, 2026, 3:01:37 AM                 |
 * | short    | false    | Jul 22, 2026                             |
 * | time     | —        | 3:01:37 AM                               |
 * | relative | —        | 9 hours ago                              |
 */
export function formatDateValue(
  value: DateInput,
  kind: DateKind = "short",
  options: DateFormatOptions = {},
): string {
  const date = toDate(value);
  if (!date) return options.fallback ?? DATE_FALLBACK;

  const locale = options.locale || DEFAULT_LOCALE;

  if (kind === "relative") {
    return formatRelativeTime(date, locale, options.now ?? Date.now());
  }

  const hour12 = options.hour12 ?? true;
  const timeZone = options.utc ? "UTC" : options.timeZone;
  const showTime = options.showTime ?? true;
  const key = `${locale}|${kind}|${hour12}|${timeZone ?? ""}|${showTime}`;

  return dateTimeFormatter(
    key,
    locale,
    intlOptions(kind, hour12, timeZone, showTime),
  ).format(date);
}

/**
 * 24-hour UTC time carrying milliseconds — "23:01:37.143".
 *
 * Built from explicit components because `fractionalSecondDigits` throws when
 * combined with `timeStyle`.
 */
export function formatUtcMillis(
  value: DateInput,
  locale: string = DEFAULT_LOCALE,
): string {
  const date = toDate(value);
  if (!date) return DATE_FALLBACK;
  return dateTimeFormatter(`${locale}|utc-millis`, locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
}
