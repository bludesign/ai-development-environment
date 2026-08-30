"use client";

import {
  Copy,
  ExternalLink,
  History,
  Library,
  MoreHorizontal,
  Plus,
  RadioTower,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import { SSE_ENDPOINT_FIELDS, SSE_ENDPOINTS_QUERY } from "./graphql";
import { ModeBadge, SsePageShell } from "./sse-shell";
import type { SseEndpoint, SseMode } from "./types";
import { useSseLiveReload } from "./use-sse-live-reload";

export function SseEndpointsPage() {
  const [endpoints, setEndpoints] = useState<SseEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteEndpoint, setDeleteEndpoint] = useState<SseEndpoint | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{ sseEndpoints: SseEndpoint[] }>(
        SSE_ENDPOINTS_QUERY,
      );
      setEndpoints(data.sseEndpoints);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("endpoints", () => void load());

  async function setMode(endpoint: SseEndpoint, mode: SseMode) {
    setBusyId(endpoint.id);
    try {
      await controlPlaneRequest(
        `mutation SetSseEndpointMode($id: ID!, $mode: SseEndpointMode!) {
          setSseEndpointMode(id: $id, mode: $mode) { ${SSE_ENDPOINT_FIELDS} }
        }`,
        { id: endpoint.id, mode },
      );
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyId(null);
    }
  }

  async function remove() {
    if (!deleteEndpoint) return;
    setBusyId(deleteEndpoint.id);
    try {
      await controlPlaneRequest(
        `mutation DeleteSseEndpoint($id: ID!) { deleteSseEndpoint(id: $id) }`,
        {
          id: deleteEndpoint.id,
        },
      );
      setDeleteEndpoint(null);
      await load();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SsePageShell
      action={
        <Button asChild>
          <Link href="/sse/new">
            <Plus /> Create endpoint
          </Link>
        </Button>
      }
      description="Create hosted Server-Sent Events URLs and route each new connection through a live forwarder, reusable mock, or interactive breakpoint."
      title="SSE endpoints"
    >
      <Alert>
        <ShieldAlert />
        <AlertDescription>
          Public URLs are opaque bearer secrets. Request, upstream, and response
          headers are retained without redaction, including cookies and tokens.
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Loading endpoints…
        </p>
      ) : endpoints.length === 0 ? (
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RadioTower />
            </EmptyMedia>
            <EmptyTitle>No SSE endpoints yet</EmptyTitle>
            <EmptyDescription>
              Create an endpoint to get a stable public URL. New endpoints start
              in Forward mode.
            </EmptyDescription>
          </EmptyHeader>
          <Button asChild>
            <Link href="/sse/new">
              <Plus /> Create endpoint
            </Link>
          </Button>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {endpoints.map((endpoint) => (
            <Card key={endpoint.id}>
              <CardHeader>
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{endpoint.name}</span>
                  <ModeBadge mode={endpoint.mode} />
                </CardTitle>
                <CardDescription className="line-clamp-2 min-h-10">
                  {endpoint.description || "No description"}
                </CardDescription>
                <CardAction>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Actions for ${endpoint.name}`}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          void navigator.clipboard.writeText(endpoint.publicUrl)
                        }
                      >
                        <Copy /> Copy public URL
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link href={`/sse/${endpoint.id}`}>
                          <ExternalLink /> Open endpoint
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteEndpoint(endpoint)}
                      >
                        <Trash2 /> Delete endpoint
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-4">
                <button
                  className="block w-full truncate rounded-lg border bg-muted/30 px-3 py-2 text-left font-mono text-xs hover:bg-muted"
                  onClick={() =>
                    void navigator.clipboard.writeText(endpoint.publicUrl)
                  }
                  title="Copy public URL"
                  type="button"
                >
                  {endpoint.publicUrl}
                </button>
                <div
                  className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
                  role="group"
                  aria-label={`Mode for ${endpoint.name}`}
                >
                  {(["FORWARD", "MOCK", "BREAKPOINT"] as const).map((mode) => (
                    <Button
                      disabled={
                        busyId === endpoint.id ||
                        (mode === "MOCK" && !endpoint.activeMockCompositionId)
                      }
                      key={mode}
                      onClick={() => void setMode(endpoint, mode)}
                      size="sm"
                      variant={endpoint.mode === mode ? "default" : "ghost"}
                    >
                      {mode === "FORWARD" ? (
                        <RadioTower />
                      ) : mode === "MOCK" ? (
                        <Library />
                      ) : (
                        <ShieldAlert />
                      )}
                      <span className="hidden 2xl:inline">
                        {mode
                          .toLocaleLowerCase()
                          .replace(/^./, (v) => v.toUpperCase())}
                      </span>
                    </Button>
                  ))}
                </div>
                <dl className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Forward URL</dt>
                    <dd className="mt-1 truncate font-mono">
                      {endpoint.forwardUrl}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Heartbeat</dt>
                    <dd className="mt-1">
                      {endpoint.heartbeatEnabled
                        ? `${endpoint.heartbeatIntervalMs / 1000}s`
                        : "Off"}
                    </dd>
                  </div>
                </dl>
              </CardContent>
              <CardFooter className="grid grid-cols-3 gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/sse/${endpoint.id}`}>
                    <ExternalLink /> Configure
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/sse/${endpoint.id}/mocks`}>
                    <Library /> Mocks
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/sse/history?endpointId=${endpoint.id}`}>
                    <History /> History
                  </Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
      <ConfirmationDialog
        actionLabel="Delete endpoint"
        cancelLabel="Cancel"
        description="The public URL will stop accepting new connections immediately. Existing streams finish from their startup snapshot and retained history keeps the endpoint name and token snapshot."
        onConfirm={remove}
        onOpenChange={(open) => !open && setDeleteEndpoint(null)}
        open={Boolean(deleteEndpoint)}
        title={`Delete ${deleteEndpoint?.name ?? "endpoint"}?`}
      />
    </SsePageShell>
  );
}
