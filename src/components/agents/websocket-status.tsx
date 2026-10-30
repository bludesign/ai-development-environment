"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { DateTime } from "@/components/common/date-time";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getBrowserWebSocketSnapshot,
  getServerWebSocketSnapshot,
  subscribeBrowserWebSocketStatus,
  UNKNOWN_WEBSOCKET_SNAPSHOT,
  type WebSocketSnapshot,
} from "@/lib/websocket-status";
import { cn } from "@/lib/utils";

export function BrowserWebSocketStatus() {
  const snapshot = useSyncExternalStore(
    subscribeBrowserWebSocketStatus,
    getBrowserWebSocketSnapshot,
    getServerWebSocketSnapshot,
  );
  return <WebSocketStatusBadge kind="browser" snapshot={snapshot} />;
}

export function WebSocketStatusBadge({
  kind,
  snapshot = UNKNOWN_WEBSOCKET_SNAPSHOT,
}: {
  kind: "agent" | "browser";
  snapshot?: WebSocketSnapshot;
}) {
  const t = useTranslations("webSocketStatus");
  const text = `${t(kind)}: ${t(snapshot.status.toLowerCase())}`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="relative z-10 max-w-full text-left"
            aria-label={text}
          >
            <Badge
              variant="outline"
              className={cn(
                "h-auto min-h-5 whitespace-normal",
                snapshot.status === "CONNECTED" &&
                  "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                snapshot.status === "DISCONNECTED" &&
                  "border-destructive/30 bg-destructive/10 text-destructive",
              )}
            >
              {text}
            </Badge>
          </button>
        </TooltipTrigger>
        <TooltipContent className="block space-y-2">
          <p>{t(`${kind}Description`)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {(
              [
                ["lastVerified", snapshot.lastVerifiedAt],
                ["lastChanged", snapshot.changedAt],
                ["connectedSince", snapshot.connectedAt],
                ["lastDisconnected", snapshot.disconnectedAt],
              ] as const
            ).map(([label, value]) => (
              <div className="contents" key={label}>
                <dt>{t(label)}</dt>
                <dd>
                  <DateTime value={value} fallback={t("never")} hover={false} />
                </dd>
              </div>
            ))}
          </dl>
          {snapshot.status === "UNKNOWN" && <p>{t("unknownDescription")}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
