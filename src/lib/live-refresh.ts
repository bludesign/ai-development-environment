/** Where a live view learns whether anyone can currently see it. */
export type PageVisibility = {
  isHidden(): boolean;
  /** Calls the listener each time the page comes back into view. */
  onVisible(listener: () => void): () => void;
};

/** `focus` and `visibilitychange` both fire on one return to the tab. */
const RETURN_DEDUPE_MS = 1_000;

/**
 * A tab return can fire `visibilitychange` and `focus` in either order. A window
 * can also regain focus without a visibility change. A hide or blur starts a
 * separate return, even inside the deduplication window.
 */
export function onPageVisible(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof window === "undefined")
    return () => undefined;
  let lastReturn: { type: string; time: number } | null = null;
  const clearPair = () => {
    lastReturn = null;
  };
  const returned = ({ type }: Event) => {
    if (document.visibilityState === "hidden") {
      clearPair();
      return;
    }
    const time = Date.now();
    if (
      lastReturn &&
      lastReturn.type !== type &&
      time - lastReturn.time < RETURN_DEDUPE_MS
    ) {
      clearPair();
      return;
    }
    lastReturn = { type, time };
    listener();
  };
  document.addEventListener("visibilitychange", returned);
  window.addEventListener("focus", returned);
  window.addEventListener("blur", clearPair);
  return () => {
    document.removeEventListener("visibilitychange", returned);
    window.removeEventListener("focus", returned);
    window.removeEventListener("blur", clearPair);
  };
}

export const browserPageVisibility: PageVisibility = {
  isHidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  onVisible: onPageVisible,
};

export type LiveRefreshOptions = {
  /**
   * Minimum spacing between refreshes. The first invalidation after a quiet
   * spell refreshes at once; a burst then costs one trailing refresh.
   */
  minIntervalMs?: number;
  /** Reconcile this long after the last refresh, while visible. Omit for none. */
  pollMs?: number;
  visibility?: PageVisibility;
};

export type LiveRefresh = {
  /** A change event arrived. Throttled, and deferred while the page is hidden. */
  invalidate(): void;
  dispose(): void;
};

/**
 * Background refresh policy for a view kept current by events and a fallback
 * poll. Nothing is read while the page is hidden; one refresh runs on return
 * if an event or a poll was skipped. Reads the user asks for should call the
 * refresh directly and are never delayed by this.
 */
export function createLiveRefresh(
  refresh: () => unknown,
  {
    minIntervalMs = 3_000,
    pollMs,
    visibility = browserPageVisibility,
  }: LiveRefreshOptions = {},
): LiveRefresh {
  let disposed = false;
  let missed = false;
  let lastRunAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;

  const armPoll = () => {
    if (poll !== null) clearTimeout(poll);
    poll = null;
    if (pollMs === undefined || disposed) return;
    poll = setTimeout(() => {
      poll = null;
      // Re-armed by the refresh this starts, or on return if it was skipped.
      invalidate();
    }, pollMs);
  };

  const run = () => {
    if (trailing !== null) clearTimeout(trailing);
    trailing = null;
    lastRunAt = Date.now();
    armPoll();
    try {
      const result = refresh();
      // Views report their own read failures; a background refresh has no
      // caller to hand a rejection to.
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      /* As above. */
    }
  };

  function invalidate() {
    if (disposed) return;
    if (visibility.isHidden()) {
      missed = true;
      return;
    }
    if (trailing !== null) return;
    const wait = lastRunAt + minIntervalMs - Date.now();
    if (wait <= 0) run();
    else
      trailing = setTimeout(() => {
        trailing = null;
        invalidate();
      }, wait);
  }

  const offVisible = visibility.onVisible(() => {
    if (disposed || !missed) return;
    missed = false;
    invalidate();
  });
  armPoll();

  return {
    invalidate,
    dispose() {
      disposed = true;
      if (trailing !== null) clearTimeout(trailing);
      if (poll !== null) clearTimeout(poll);
      trailing = null;
      poll = null;
      offVisible();
    },
  };
}
