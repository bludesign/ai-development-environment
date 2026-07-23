/**
 * Persistence for the plans/sessions filter dropdowns. The selection is stored
 * in a per-kind cookie so the server can render the same filters the user last
 * chose — reading it on the client instead would hydrate against the defaults
 * and flash an unfiltered list.
 */
export const RUN_FILTER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export type RunKind = "PLAN" | "SESSION";

export type RunFilterState = {
  archive: string;
  provider: string;
  origin: string;
};

export const DEFAULT_RUN_FILTERS: RunFilterState = {
  archive: "ACTIVE",
  provider: "ALL",
  origin: "ALL",
};

const ARCHIVE_VALUES = ["ACTIVE", "ARCHIVED", "ALL"];
const PROVIDER_VALUES = ["ALL", "CODEX", "CLAUDE", "OPENCODE"];
const ORIGIN_VALUES = ["ALL", "MANAGED", "IMPORTED"];

export function runFilterCookieName(kind: RunKind) {
  return `ade_run_filters_${kind.toLowerCase()}`;
}

function pick(allowed: string[], value: string | undefined, fallback: string) {
  return value && allowed.includes(value) ? value : fallback;
}

/** Tolerant of anything: an absent, stale, or hand-edited cookie falls back. */
export function parseRunFilters(value: string | undefined): RunFilterState {
  const [archive, provider, origin] = (value ?? "").split(".");
  return {
    archive: pick(ARCHIVE_VALUES, archive, DEFAULT_RUN_FILTERS.archive),
    provider: pick(PROVIDER_VALUES, provider, DEFAULT_RUN_FILTERS.provider),
    origin: pick(ORIGIN_VALUES, origin, DEFAULT_RUN_FILTERS.origin),
  };
}

export function serializeRunFilters(filters: RunFilterState) {
  return `${filters.archive}.${filters.provider}.${filters.origin}`;
}

export function writeRunFilterCookie(kind: RunKind, filters: RunFilterState) {
  if (typeof document === "undefined") return;
  document.cookie = `${runFilterCookieName(kind)}=${serializeRunFilters(filters)}; path=/; max-age=${RUN_FILTER_COOKIE_MAX_AGE}`;
}
