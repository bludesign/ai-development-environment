/**
 * Deterministic-ish time helpers for the mock seed. Everything is anchored to a single
 * `NOW` captured when the seed starts, so relative labels ("2 days ago") stay consistent
 * within a run and freshly-seeded agents remain inside their online window.
 */
export const NOW = new Date();

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

export function fromNow(ms: number): Date {
  return new Date(NOW.getTime() + ms);
}

export const secondsAgo = (n: number): Date => ago(n * 1_000);
export const minutesAgo = (n: number): Date => ago(n * MINUTE_MS);
export const hoursAgo = (n: number): Date => ago(n * HOUR_MS);
export const daysAgo = (n: number): Date => ago(n * DAY_MS);

/**
 * A fixed wall-clock time on a past day: `atTime(1, 14, 30)` is 2:30 PM local yesterday.
 * Unlike `minutesAgo`, the rendered clock label does not drift with when the seed ran, so
 * rows land on predictable day groups at predictable times.
 */
export function atTime(
  daysBack: number,
  hour: number,
  minute = 0,
  second = 0,
): Date {
  const day = ago(daysBack * DAY_MS);
  day.setHours(hour, minute, second, 0);
  return day;
}

/** Local `YYYY-MM-DD` for a day offset, the period format ccusage reports use. */
export function dayKey(daysBack: number): string {
  const day = ago(daysBack * DAY_MS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

export const minutesFromNow = (n: number): Date => fromNow(n * MINUTE_MS);
export const hoursFromNow = (n: number): Date => fromNow(n * HOUR_MS);
export const daysFromNow = (n: number): Date => fromNow(n * DAY_MS);
