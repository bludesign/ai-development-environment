"use client";

import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
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

  const load = useCallback(async () => {
    try {
      const response = await controlPlaneRequest<{
        sseHistoryRequest: SseHistoryRequest | null;
      }>(SSE_HISTORY_DETAIL_QUERY, { id: requestId });
      setRequest(response.sseHistoryRequest);
      setError(
        response.sseHistoryRequest ? null : "This SSE stream was not found.",
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("history", () => void load());

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
        <SseStreamHistoryDetails request={request} />
      ) : null}
    </SsePageShell>
  );
}
