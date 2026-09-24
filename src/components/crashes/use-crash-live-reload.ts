"use client";

import { useEffect, useRef } from "react";

import {
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

const DOCUMENTS = {
  crashes:
    "subscription CrashReportsLive { crashReportsChanged { reason ids } }",
  dsyms: "subscription DsymsLive { dsymsChanged { reason ids } }",
} as const;

/**
 * Reloads when crash reports or dSYMs change, coalescing bursts such as a
 * dSYM upload that re-symbolicates many crashes at once.
 */
export function useCrashLiveReload(
  channels: (keyof typeof DOCUMENTS)[],
  reload: () => void | Promise<unknown>,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  const key = channels.join(",");
  useEffect(() => {
    if (!enabled) return;
    const refresh = createRefreshCoalescer(() => reloadRef.current());
    const recover = () => void refresh.refresh().catch(() => undefined);
    const disposers = key
      .split(",")
      .filter(Boolean)
      .map((channel) =>
        controlPlaneSubscriptions().subscribe(
          { query: DOCUMENTS[channel as keyof typeof DOCUMENTS] },
          {
            next: recover,
            error: () => undefined,
            complete: () => undefined,
          },
        ),
      );
    const offRecovery = onControlPlaneRecovery(recover);
    return () => {
      for (const dispose of disposers) dispose();
      offRecovery();
      refresh.dispose();
    };
  }, [enabled, key]);
}
