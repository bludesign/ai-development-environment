"use client";

import { Clock3, Forward, Library, Send, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { SSE_BREAKPOINTS_QUERY, SSE_COMPOSITION_FIELDS } from "./graphql";
import { ModeBadge, SsePageShell } from "./sse-shell";
import type { SseBreakpoint, SseMockComposition } from "./types";
import { useSseLiveReload } from "./use-sse-live-reload";

export function SseBreakpointsPage() {
  const [breakpoints, setBreakpoints] = useState<SseBreakpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SseBreakpoint | null>(null);
  const [compositions, setCompositions] = useState<SseMockComposition[]>([]);
  const [compositionId, setCompositionId] = useState<string>("");
  const [adHoc, setAdHoc] = useState(
    '{\n  "name": "Breakpoint response",\n  "statusCode": 200,\n  "headers": [{ "name": "Content-Type", "value": "text/event-stream" }],\n  "blocks": []\n}\n',
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        sseBreakpoints: SseBreakpoint[];
      }>(SSE_BREAKPOINTS_QUERY);
      setBreakpoints(data.sseBreakpoints);
      setSelected((current) =>
        current
          ? (data.sseBreakpoints.find((item) => item.id === current.id) ?? null)
          : null,
      );
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("breakpoints", () => void load());

  async function selectBreakpoint(value: SseBreakpoint) {
    setSelected(value);
    setCompositionId("");
    try {
      const data = await controlPlaneRequest<{
        sseMockCompositions: SseMockComposition[];
      }>(
        `query SseBreakpointMocks($endpointId: ID!) { sseMockCompositions(endpointId: $endpointId) { ${SSE_COMPOSITION_FIELDS} } }`,
        { endpointId: value.endpointId },
      );
      setCompositions(data.sseMockCompositions);
      setCompositionId(data.sseMockCompositions[0]?.id ?? "");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  async function resolve(resolution: "FORWARD" | "SAVED_MOCK" | "AD_HOC") {
    if (!selected) return;
    setBusy(true);
    try {
      const input: Record<string, unknown> = {
        id: selected.id,
        version: selected.version,
        resolution,
      };
      if (resolution === "SAVED_MOCK") input.mockCompositionId = compositionId;
      if (resolution === "AD_HOC")
        input.adHocComposition = JSON.parse(adHoc) as unknown;
      await controlPlaneRequest(
        `mutation ResolveSseBreakpoint($input: SseBreakpointResolutionInput!) { resolveSseBreakpoint(input: $input) { id status version resolution resolvedAt } }`,
        { input },
      );
      setSelected(null);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SsePageShell
      badge={`${breakpoints.length} waiting`}
      description="Inspect paused requests and resolve each version exactly once by forwarding it, selecting a saved mock, or composing an ad hoc response."
      title="SSE breakpoints"
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Loading breakpoints…
        </p>
      ) : breakpoints.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <ShieldAlert className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">No requests are waiting</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Switch an endpoint to Breakpoint mode. Its next request will
              appear here for up to the configured timeout.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(400px,0.8fr)]">
          <div className="space-y-3">
            {breakpoints.map((item) => (
              <Card
                className="cursor-pointer transition-colors hover:bg-muted/20"
                key={item.id}
                onClick={() => void selectBreakpoint(item)}
              >
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span>{item.request.endpointName}</span>
                    <ModeBadge mode={item.request.mode} />
                  </CardTitle>
                  <CardDescription className="font-mono">
                    {item.request.method} {item.request.requestUrl}
                  </CardDescription>
                  <CardAction>
                    <Badge variant="outline">
                      <Clock3 /> {new Date(item.expiresAt).toLocaleTimeString()}
                    </Badge>
                  </CardAction>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Version</p>
                    <p>v{item.version}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Headers</p>
                    <p>{item.request.requestHeaders.length}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Body</p>
                    <p>{item.request.requestBody?.length ?? 0} bytes</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card className="self-start xl:sticky xl:top-4">
            <CardHeader>
              <CardTitle>Response editor</CardTitle>
              <CardDescription>
                {selected
                  ? `Resolve ${selected.request.endpointName} at version ${selected.version}. A stale concurrent decision returns a conflict.`
                  : "Select a waiting request."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {selected ? (
                <>
                  <div className="rounded-lg border bg-muted/30 p-3 text-xs">
                    <p className="font-mono font-medium">
                      {selected.request.method} {selected.request.requestUrl}
                    </p>
                    <pre className="mt-2 max-h-40 overflow-auto">
                      {selected.request.requestHeaders
                        .map((header) => `${header.name}: ${header.value}`)
                        .join("\n")}
                      \n\n{selected.request.requestBody}
                    </pre>
                  </div>
                  <Button
                    className="w-full"
                    disabled={busy}
                    onClick={() => void resolve("FORWARD")}
                  >
                    <Forward /> Forward now
                  </Button>
                  <div className="grid gap-2">
                    <Label>Saved composition</Label>
                    <div className="flex gap-2">
                      <Select
                        onValueChange={setCompositionId}
                        value={compositionId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose a mock" />
                        </SelectTrigger>
                        <SelectContent>
                          {compositions.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        disabled={busy || !compositionId}
                        onClick={() => void resolve("SAVED_MOCK")}
                        variant="outline"
                      >
                        <Library /> Send
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="adhoc-composition">
                      Ad hoc composition JSON
                    </Label>
                    <Textarea
                      className="min-h-72 font-mono text-xs"
                      id="adhoc-composition"
                      onChange={(event) => setAdHoc(event.target.value)}
                      spellCheck={false}
                      value={adHoc}
                    />
                    <Button
                      disabled={busy}
                      onClick={() => void resolve("AD_HOC")}
                      variant="outline"
                    >
                      <Send /> Send ad hoc response
                    </Button>
                  </div>
                </>
              ) : (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Select a breakpoint to inspect and resolve it.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </SsePageShell>
  );
}
