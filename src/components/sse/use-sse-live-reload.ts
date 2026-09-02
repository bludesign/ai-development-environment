"use client";

import { useEffect } from "react";

import { controlPlaneSubscriptions } from "@/lib/control-plane-client";

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
  reload: () => void,
) {
  useEffect(() => {
    const dispose = controlPlaneSubscriptions().subscribe(
      { query: DOCUMENTS[channel] },
      {
        next: () => reload(),
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return dispose;
  }, [channel, reload]);
}
