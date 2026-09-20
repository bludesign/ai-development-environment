"use client";

import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import {
  createRefreshCoalescer,
  type RefreshCoalescer,
} from "@/lib/refresh-coalescer";
import { sequenceRanges } from "@/lib/sequence-ranges";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { SSE_HISTORY_DETAIL_QUERY } from "./graphql";
import { SseStreamHistoryDetails } from "./sse-history-page";
import { SsePageShell } from "./sse-shell";
import type { SseHistoryRequest } from "./types";
import { useSseLiveReload } from "./use-sse-live-reload";

function streamTitle(endpointName: string) {
  const normalizedName = endpointName.replace(/\s+stream$/i, " Stream");
  return /\sStream$/.test(normalizedName)
    ? normalizedName
    : `${normalizedName} Stream`;
}

export function SseStreamHistoryPage({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<SseHistoryRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentRequest = useRef<SseHistoryRequest | null>(null);
  const owner = useRef<RefreshCoalescer | null>(null);
  const olderController = useRef<AbortController | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const load = useCallback(
    () => owner.current?.refresh() ?? Promise.resolve(),
    [],
  );
  const fetchRequest = useCallback(
    async (signal: AbortSignal) => {
      const previous =
        currentRequest.current?.id === requestId
          ? currentRequest.current
          : null;
      let after = previous?.events?.[0]?.sequence;
      after = after === undefined ? undefined : after - 1;
      try {
        for (;;) {
          const events =
            currentRequest.current?.id === requestId
              ? (currentRequest.current.events ?? [])
              : [];
          const response = await controlPlaneRequest<{
            sseHistoryRequest: SseHistoryRequest | null;
          }>(
            SSE_HISTORY_DETAIL_QUERY,
            {
              id: requestId,
              first: previous ? 5000 : 200,
              latest: !previous,
              after: after ?? null,
              knownRanges: previous
                ? sequenceRanges(events.map((event) => event.sequence)).slice(
                    0,
                    100,
                  )
                : [],
            },
            { signal },
          );
          if (signal.aborted) return;
          const next = response.sseHistoryRequest;
          if (!next) {
            currentRequest.current = null;
            setRequest(null);
            setError("This SSE stream was not found.");
            return;
          }
          const batch = next.events ?? [];
          const retained =
            currentRequest.current?.id === requestId
              ? (currentRequest.current.events ?? [])
              : [];
          const merged = [
            ...new Map(
              [...retained, ...batch].map((event) => [event.id, event]),
            ).values(),
          ].sort((a, b) => a.sequence - b.sequence);
          currentRequest.current = { ...next, events: merged };
          setRequest(currentRequest.current);
          if (!previous) setHasOlder(merged.length < next.eventCount);
          setError(null);
          if (!previous || batch.length < 5000) break;
          const last = batch.at(-1)!.sequence;
          if (after !== undefined && last <= after) break;
          after = last;
        }
      } catch (failure) {
        if (!signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [requestId],
  );
  useEffect(() => {
    const refresh = createRefreshCoalescer(fetchRequest);
    owner.current = refresh;
    const timer = window.setTimeout(() => void refresh.refresh(), 0);
    return () => {
      window.clearTimeout(timer);
      refresh.dispose();
      olderController.current?.abort();
      olderController.current = null;
      if (owner.current === refresh) owner.current = null;
    };
  }, [fetchRequest]);
  useSseLiveReload("history", load, { id: requestId });
  const loadOlder = async () => {
    if (olderController.current) return;
    const controller = new AbortController();
    olderController.current = controller;
    setLoadingOlder(true);
    try {
      const response = await controlPlaneRequest<{
        sseHistoryRequest: SseHistoryRequest | null;
      }>(
        SSE_HISTORY_DETAIL_QUERY,
        {
          id: requestId,
          first: 200,
          before: currentRequest.current?.events?.[0]?.sequence ?? null,
        },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        !response.sseHistoryRequest ||
        currentRequest.current?.id !== requestId
      )
        return;
      const batch = response.sseHistoryRequest.events ?? [];
      const events = [
        ...new Map(
          [...batch, ...(currentRequest.current.events ?? [])].map((event) => [
            event.id,
            event,
          ]),
        ).values(),
      ].sort((a, b) => a.sequence - b.sequence);
      currentRequest.current = { ...currentRequest.current, events };
      setRequest(currentRequest.current);
      setHasOlder(
        batch.length === 200 &&
          events.length < currentRequest.current.eventCount,
      );
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
      if (olderController.current === controller)
        olderController.current = null;
    }
  };

  const title = request ? streamTitle(request.endpointName) : "SSE Stream";
  const description = request
    ? `${request.method} ${request.requestUrl}`
    : "Review one SSE connection and every retained source and emitted event.";

  return (
    <SsePageShell
      action={
        <Button asChild variant="outline">
          <Link href="/sse/history">
            <ArrowLeft /> Back to History
          </Link>
        </Button>
      }
      badge={request ? `${request.eventCount} Events` : undefined}
      description={description}
      title={title}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-6 text-muted-foreground">
            <Spinner /> Loading stream history…
          </CardContent>
        </Card>
      ) : request ? (
        <>
          {hasOlder ? (
            <Button
              disabled={loadingOlder}
              onClick={() => void loadOlder()}
              variant="outline"
            >
              {loadingOlder ? <Spinner /> : null} Load older events
            </Button>
          ) : null}
          <SseStreamHistoryDetails request={request} />
        </>
      ) : null}
    </SsePageShell>
  );
}
