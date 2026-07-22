"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A single app-wide clock for relative timestamps.
 *
 * One interval serves every subscriber, and each subscriber reads a `now` that
 * is quantized to the precision its own timestamp actually needs. Because
 * `useSyncExternalStore` bails out when the snapshot is unchanged, a table of
 * day-old rows re-renders at most hourly while a seconds-old row still ticks
 * once a second.
 */

const TICK_MS = 1_000;

const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let currentNow = Date.now();

function tick() {
  currentNow = Date.now();
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  if (timer === null) {
    currentNow = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Resolution a timestamp of this age needs, so older values settle down. */
function granularityFor(ageMs: number): number {
  const age = Math.abs(ageMs);
  if (age < 60_000) return 1_000;
  if (age < 3_600_000) return 30_000;
  if (age < 86_400_000) return 300_000;
  return 3_600_000;
}

/**
 * Returns a quantized `now`, or null before hydration completes.
 *
 * React reuses the server snapshot for the hydrating client render, so callers
 * that render an absolute value while this is null stay hydration-safe.
 */
export function useNow(timestampMs: number | null): number | null {
  const getSnapshot = useCallback(() => {
    if (timestampMs === null) return currentNow;
    const granularity = granularityFor(currentNow - timestampMs);
    return Math.floor(currentNow / granularity) * granularity;
  }, [timestampMs]);

  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
