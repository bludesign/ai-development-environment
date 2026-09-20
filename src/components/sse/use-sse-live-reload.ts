"use client";

import { useEffect, useRef } from "react";

import {
  controlPlaneSubscriptions,
  onControlPlaneRecovery,
} from "@/lib/control-plane-client";
import { createRefreshCoalescer } from "@/lib/refresh-coalescer";

const DOCUMENTS = {
  endpoints:
    "subscription SseEndpointsLive { sseEndpointsChanged { reason ids } }",
  storage: "subscription SseStorageLive { sseStorageChanged { reason ids } }",
  breakpoints:
    "subscription SseBreakpointsLive { sseBreakpointsChanged { reason ids } }",
  history: "subscription SseHistoryLive { sseHistoryChanged { reason ids } }",
} as const;

export function useSseLiveReload(
  channel: keyof typeof DOCUMENTS,
  reload: (change?: {
    ids?: string[];
    reason?: string;
  }) => void | Promise<unknown>,
  { enabled = true, id }: { enabled?: boolean; id?: string } = {},
) {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => {
    if (!enabled) return;
    const pendingReasons = new Set<string>();
    let pendingChange: { ids?: string[]; reason?: string } | undefined;
    const refresh = createRefreshCoalescer(() => {
      const change =
        pendingReasons.size === 1 && !pendingReasons.has("*")
          ? pendingChange
          : undefined;
      pendingReasons.clear();
      pendingChange = undefined;
      return reloadRef.current(change);
    });
    const recover = () => {
      void refresh.refresh().catch(() => undefined);
    };
    const dispose = controlPlaneSubscriptions().subscribe(
      { query: DOCUMENTS[channel] },
      {
        next: (value) => {
          const change = Object.values(value.data ?? {})[0] as
            { ids?: string[]; reason?: string } | undefined;
          if (id && change?.ids?.length && !change.ids.includes(id)) return;
          // Coalesced differing reasons require conservative metadata recovery.
          pendingReasons.add(change?.reason ?? "*");
          pendingChange = change;
          recover();
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    const offConnected = onControlPlaneRecovery(() => {
      pendingReasons.add("*");
      recover();
    });
    return () => {
      dispose();
      offConnected();
      refresh.dispose();
    };
  }, [channel, enabled, id]);
}
