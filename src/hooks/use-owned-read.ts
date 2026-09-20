"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";

/** Own one initial/manual/live read for the mounted callback scope. Callers
 * forward the signal and check it before committing state or displaying errors. */
export function useOwnedRead(
  callback: (signal: AbortSignal) => Promise<unknown>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const ownerRef = useRef<RefreshCoalescer | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const owner = createRefreshCoalescer(callback);
    ownerRef.current = owner;
    const timer = window.setTimeout(
      () => void owner.refreshIfIdle().catch(() => undefined),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      owner.dispose();
      if (ownerRef.current === owner) ownerRef.current = null;
    };
  }, [callback, enabled]);
  return useCallback(
    () => ownerRef.current?.refresh() ?? Promise.resolve(),
    [],
  );
}
