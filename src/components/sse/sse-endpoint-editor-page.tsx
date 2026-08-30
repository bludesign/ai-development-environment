"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Braces,
  Check,
  Copy,
  FlaskConical,
  History,
  KeyRound,
  Library,
  Plus,
  RadioTower,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
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
import {
  Field as FormField,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import { formatEnumLabel } from "@/lib/enum-label";

import {
  SSE_COMPOSITION_FIELDS,
  SSE_ENDPOINT_DETAIL_QUERY,
  SSE_ENDPOINT_FIELDS,
  SSE_HISTORY_REQUEST_FIELDS,
} from "./graphql";
import { ModeBadge, SsePageShell } from "./sse-shell";
import type {
  SseBufferMode,
  SseEndpoint,
  SseHistoryRequest,
  SseMockComposition,
  SseMockTemplate,
  SseMode,
} from "./types";
import { useSseLiveReload } from "./use-sse-live-reload";

type EndpointDraft = Omit<
  SseEndpoint,
  | "id"
  | "token"
  | "publicUrl"
  | "activeMockComposition"
  | "createdAt"
  | "updatedAt"
>;
type DraftBlock = {
  key: string;
  kind: "EVENT" | "DELAY" | "SCRIPT";
  templateId?: string;
  delayMs?: number;
  script?: string;
};

const DEFAULT_DRAFT: EndpointDraft = {
  name: "",
  description: "",
  mode: "FORWARD",
  forwardUrl: "https://example.com/events",
  requestScript: "",
  responseScript: "",
  activeMockCompositionId: null,
  deliveryBufferMode: "STANDARD",
  historyBufferMode: "CONCATENATE",
  breakpointTimeoutMs: 300_000,
  heartbeatEnabled: true,
  heartbeatIntervalMs: 15_000,
  mockCompletion: "CLOSE",
  requestScriptTimeoutMs: 30_000,
  mockScriptTimeoutMs: 30_000,
  responseScriptTimeoutMs: 5_000,
  scriptMemoryLimitMb: 32,
  fetchTimeoutMs: 15_000,
  requestBodyLimitBytes: 2 * 1024 * 1024,
  eventDataLimitBytes: 512 * 1024,
  streamHistoryLimitBytes: 50 * 1024 * 1024,
  retentionDays: 30,
  retentionEventLimit: 100_000,
};

const BUFFER_MODE_OPTIONS: Array<{
  value: SseBufferMode;
  label: string;
  description: string;
}> = [
  {
    value: "STANDARD",
    label: "Standard",
    description:
      "Handle each complete SSE frame as it arrives. Multiple data lines inside one frame are joined with a newline.",
  },
  {
    value: "CONCATENATE",
    label: "Concatenate",
    description:
      "Combine consecutive unnamed data frames, treating an empty data line as a newline, until a named event or stream end.",
  },
  {
    value: "PRESERVE_FRAMES",
    label: "Preserve Frames",
    description:
      "Keep every unnamed SSE frame separate at its original frame boundary, including multiline data within that frame.",
  },
];

const REQUEST_SCRIPT_PLACEHOLDER = `// request is read-only; forward is mutable.
const token = request.headers.get("authorization");
await storage.set("last-auth-token", token);

forward.method = "POST";
forward.headers.set("authorization", token ?? "");
forward.headers.delete("x-remove-before-forwarding");
forward.body = JSON.stringify(request.body.json ?? request.body.text);

// You can mutate forward, return overrides, or do both.
return {
  url: "https://api.example.com/events",
  method: forward.method,
  headers: forward.headers,
  body: forward.body,
};`;

const RESPONSE_SCRIPT_PLACEHOLDER = `// phase is "headers" once, then "event" for every source event.
if (phase === "headers") {
  response.headers.set("x-stream-source", "aide");
  return { status: 200, headers: response.headers };
}

const count = await storage.increment("events-seen", 1);
console.log("event", event.event, count.value);

if (buffers.delivery.includes("\\n\\n")) {
  return {
    split: {
      target: "BOTH",
      offset: buffers.delivery.indexOf("\\n\\n"),
      separatorLength: 2,
    },
  };
}

// undefined passes through; null drops; an array fans out.
return { ...event, data: event.data.trim() };`;

function endpointDraft(endpoint: SseEndpoint): EndpointDraft {
  const {
    id: _id,
    token: _token,
    publicUrl: _publicUrl,
    activeMockComposition: _active,
    createdAt: _created,
    updatedAt: _updated,
    ...draft
  } = endpoint;
  return draft;
}

function inputFor(draft: EndpointDraft) {
  return {
    name: draft.name,
    description: draft.description,
    forwardUrl: draft.forwardUrl,
    mode: draft.mode,
    requestScript: draft.requestScript,
    responseScript: draft.responseScript,
    activeMockCompositionId: draft.activeMockCompositionId,
    deliveryBufferMode: draft.deliveryBufferMode,
    historyBufferMode: draft.historyBufferMode,
    breakpointTimeoutMs: draft.breakpointTimeoutMs,
    heartbeatEnabled: draft.heartbeatEnabled,
    heartbeatIntervalMs: draft.heartbeatIntervalMs,
    mockCompletion: draft.mockCompletion,
    requestScriptTimeoutMs: draft.requestScriptTimeoutMs,
    mockScriptTimeoutMs: draft.mockScriptTimeoutMs,
    responseScriptTimeoutMs: draft.responseScriptTimeoutMs,
    scriptMemoryLimitMb: draft.scriptMemoryLimitMb,
    fetchTimeoutMs: draft.fetchTimeoutMs,
    requestBodyLimitBytes: draft.requestBodyLimitBytes,
    eventDataLimitBytes: draft.eventDataLimitBytes,
    streamHistoryLimitBytes: draft.streamHistoryLimitBytes,
    retentionDays: draft.retentionDays,
    retentionEventLimit: draft.retentionEventLimit,
  };
}

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function SseEndpointEditorPage({
  endpointId,
  initialTab = "configuration",
}: {
  endpointId?: string;
  initialTab?: "configuration" | "scripts" | "mocks" | "history";
}) {
  const router = useRouter();
  const isNew = !endpointId;
  const [endpoint, setEndpoint] = useState<SseEndpoint | null>(null);
  const [draft, setDraft] = useState<EndpointDraft>(DEFAULT_DRAFT);
  const [templates, setTemplates] = useState<SseMockTemplate[]>([]);
  const [compositions, setCompositions] = useState<SseMockComposition[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!endpointId) return;
    try {
      const data = await controlPlaneRequest<{
        sseEndpoint: SseEndpoint | null;
        sseMockEventTemplates: SseMockTemplate[];
        sseMockCompositions: SseMockComposition[];
      }>(SSE_ENDPOINT_DETAIL_QUERY, { id: endpointId });
      if (!data.sseEndpoint) throw new Error("SSE endpoint not found");
      setEndpoint(data.sseEndpoint);
      setDraft(endpointDraft(data.sseEndpoint));
      setTemplates(data.sseMockEventTemplates);
      setCompositions(data.sseMockCompositions);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [endpointId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("endpoints", () => void load());

  const update = <K extends keyof EndpointDraft>(
    key: K,
    value: EndpointDraft[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const data = await controlPlaneRequest<{
          createSseEndpoint: SseEndpoint;
        }>(
          `mutation CreateSseEndpoint($input: SseEndpointInput!) {
            createSseEndpoint(input: $input) { ${SSE_ENDPOINT_FIELDS} }
          }`,
          { input: inputFor(draft) },
        );
        router.replace(`/sse/${data.createSseEndpoint.id}`);
      } else {
        const data = await controlPlaneRequest<{
          updateSseEndpoint: SseEndpoint;
        }>(
          `mutation UpdateSseEndpoint($id: ID!, $input: SseEndpointInput!) {
            updateSseEndpoint(id: $id, input: $input) { ${SSE_ENDPOINT_FIELDS} }
          }`,
          { id: endpointId, input: inputFor(draft) },
        );
        setEndpoint(data.updateSseEndpoint);
        setDraft(endpointDraft(data.updateSseEndpoint));
        setNotice("Endpoint settings saved.");
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  async function switchMode(mode: SseMode) {
    if (!endpointId) {
      update("mode", mode);
      return;
    }
    setSaving(true);
    try {
      const data = await controlPlaneRequest<{
        setSseEndpointMode: SseEndpoint;
      }>(
        `mutation SetSseMode($id: ID!, $mode: SseEndpointMode!) {
          setSseEndpointMode(id: $id, mode: $mode) { ${SSE_ENDPOINT_FIELDS} }
        }`,
        { id: endpointId, mode },
      );
      setEndpoint(data.setSseEndpointMode);
      setDraft(endpointDraft(data.setSseEndpointMode));
      setNotice(`New connections now use ${mode.toLocaleLowerCase()} mode.`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  async function rotateToken() {
    if (!endpointId) return;
    setSaving(true);
    try {
      const data = await controlPlaneRequest<{
        rotateSseEndpointToken: SseEndpoint;
      }>(
        `mutation RotateSseToken($id: ID!) { rotateSseEndpointToken(id: $id) { ${SSE_ENDPOINT_FIELDS} } }`,
        { id: endpointId },
      );
      setEndpoint(data.rotateSseEndpointToken);
      setDraft(endpointDraft(data.rotateSseEndpointToken));
      setNotice(
        "Public URL rotated. The previous URL no longer accepts new connections.",
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SsePageShell
        description="Loading endpoint configuration and mock library."
        title="SSE Endpoint"
      >
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Loading endpoint…
        </p>
      </SsePageShell>
    );
  }

  return (
    <SsePageShell
      action={
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/sse">
              <ArrowLeft /> Endpoints
            </Link>
          </Button>
          <Button
            disabled={saving || !draft.name.trim()}
            onClick={() => void save()}
          >
            <Save /> {saving ? "Saving…" : isNew ? "Create endpoint" : "Save"}
          </Button>
        </div>
      }
      badge={endpoint?.mode}
      description={
        isNew
          ? "Create a stable public SSE URL. It starts in Forward mode and can be switched at any time."
          : "Configure request routing, event transformation, mocks, buffering, limits, and endpoint-scoped history."
      }
      title={isNew ? "Create SSE Endpoint" : (endpoint?.name ?? "SSE Endpoint")}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert>
          <Check />
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {!isNew && endpoint ? (
        <PublicUrlCard endpoint={endpoint} onRotate={rotateToken} />
      ) : null}
      <ModeSwitcher
        activeMockCompositionId={draft.activeMockCompositionId}
        disabled={saving}
        mode={draft.mode}
        onChange={switchMode}
      />
      <Tabs defaultValue={initialTab}>
        <TabsList className="flex h-auto w-full justify-start overflow-x-auto">
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="scripts">
            <Braces /> Scripts
          </TabsTrigger>
          {!isNew ? (
            <TabsTrigger value="mocks">
              <Library /> Mocks
            </TabsTrigger>
          ) : null}
          {!isNew ? (
            <TabsTrigger value="history">
              <History /> History
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent className="mt-4" value="configuration">
          <ConfigurationEditor draft={draft} update={update} />
        </TabsContent>
        <TabsContent className="mt-4" value="scripts">
          <ScriptsEditor draft={draft} update={update} />
        </TabsContent>
        {!isNew && endpointId ? (
          <TabsContent className="mt-4" value="mocks">
            <MockBuilder
              activeCompositionId={draft.activeMockCompositionId}
              compositions={compositions}
              endpointId={endpointId}
              onChanged={load}
              templates={templates}
            />
          </TabsContent>
        ) : null}
        {!isNew && endpointId ? (
          <TabsContent className="mt-4" value="history">
            <EndpointHistory endpointId={endpointId} />
          </TabsContent>
        ) : null}
      </Tabs>
    </SsePageShell>
  );
}

function PublicUrlCard({
  endpoint,
  onRotate,
}: {
  endpoint: SseEndpoint;
  onRotate: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Public endpoint URL</CardTitle>
        <CardDescription>
          Accepts GET, POST, and wildcard CORS OPTIONS requests. Treat it like a
          bearer credential.
        </CardDescription>
        <CardAction>
          <ModeBadge mode={endpoint.mode} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 sm:flex-row">
        <code className="min-w-0 flex-1 truncate rounded-lg border bg-muted/40 px-3 py-2 text-xs">
          {endpoint.publicUrl}
        </code>
        <Button
          onClick={() => void navigator.clipboard.writeText(endpoint.publicUrl)}
          variant="outline"
        >
          <Copy /> Copy URL
        </Button>
        <Button onClick={() => setConfirm(true)} variant="outline">
          <KeyRound /> Rotate token
        </Button>
      </CardContent>
      <ConfirmationDialog
        actionLabel="Rotate token"
        cancelLabel="Cancel"
        description="The current URL will immediately stop accepting new connections. Existing streams continue from their startup snapshot."
        onConfirm={onRotate}
        onOpenChange={setConfirm}
        open={confirm}
        title="Rotate this public URL?"
      />
    </Card>
  );
}

function ModeSwitcher({
  mode,
  activeMockCompositionId,
  disabled,
  onChange,
}: {
  mode: SseMode;
  activeMockCompositionId: string | null;
  disabled: boolean;
  onChange: (mode: SseMode) => void | Promise<void>;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-0">
        <div>
          <p className="font-medium">Connection mode</p>
          <p className="text-xs text-muted-foreground">
            Changes apply only to new connections.
          </p>
        </div>
        <div
          className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
          role="group"
          aria-label="Endpoint mode"
        >
          {(["FORWARD", "MOCK", "BREAKPOINT"] as const).map((value) => (
            <Button
              disabled={
                disabled || (value === "MOCK" && !activeMockCompositionId)
              }
              key={value}
              onClick={() => void onChange(value)}
              size="sm"
              variant={mode === value ? "default" : "ghost"}
            >
              {value === "FORWARD" ? (
                <RadioTower />
              ) : value === "MOCK" ? (
                <Library />
              ) : (
                <ShieldAlert />
              )}
              {value[0]}
              {value.slice(1).toLowerCase()}
            </Button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConfigurationEditor({
  draft,
  update,
}: {
  draft: EndpointDraft;
  update: <K extends keyof EndpointDraft>(
    key: K,
    value: EndpointDraft[K],
  ) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Routing</CardTitle>
          <CardDescription>
            Request scripts can override this URL, method, body, and headers in
            Forward mode.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Field label="Name">
            <Input
              onChange={(e) => update("name", e.target.value)}
              placeholder="Customer activity stream"
              value={draft.name}
            />
          </Field>
          <Field label="Description">
            <Textarea
              onChange={(e) => update("description", e.target.value)}
              placeholder="Describe what this endpoint receives and where its events should go."
              rows={3}
              value={draft.description}
            />
          </Field>
          <Field label="Forward URL">
            <Input
              onChange={(e) => update("forwardUrl", e.target.value)}
              placeholder="https://api.example.com/events"
              type="url"
              value={draft.forwardUrl}
            />
          </Field>
          <BufferModeField
            defaultValue="STANDARD"
            description="Controls how unnamed source frames are grouped before events are delivered to the connected client."
            idPrefix="delivery-buffering"
            label="Delivery Buffering"
            onValueChange={(value) => update("deliveryBufferMode", value)}
            value={draft.deliveryBufferMode}
          />
          <BufferModeField
            defaultValue="CONCATENATE"
            description="Controls how unnamed source frames are grouped into logical history records. This does not change what the client receives."
            idPrefix="history-buffering"
            label="History Buffering"
            onValueChange={(value) => update("historyBufferMode", value)}
            value={draft.historyBufferMode}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Mock Completion"
              onValueChange={(value) =>
                update(
                  "mockCompletion",
                  value as EndpointDraft["mockCompletion"],
                )
              }
              value={draft.mockCompletion}
              values={["CLOSE", "HOLD", "LOOP"]}
            />
            <NumberField
              label="Breakpoint Timeout (ms)"
              value={draft.breakpointTimeoutMs}
              onChange={(value) => update("breakpointTimeoutMs", value)}
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="sse-heartbeat">Heartbeat comments</Label>
              <p className="text-xs text-muted-foreground">
                Excluded from history and workflow triggers.
              </p>
            </div>
            <Switch
              checked={draft.heartbeatEnabled}
              id="sse-heartbeat"
              onCheckedChange={(checked) => update("heartbeatEnabled", checked)}
            />
          </div>
          {draft.heartbeatEnabled ? (
            <NumberField
              label="Heartbeat Interval (ms)"
              value={draft.heartbeatIntervalMs}
              onChange={(value) => update("heartbeatIntervalMs", value)}
            />
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Safety and retention limits</CardTitle>
          <CardDescription>
            Streams stop retaining payloads after the history cap but continue
            delivering events.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Request script timeout (ms)"
            value={draft.requestScriptTimeoutMs}
            onChange={(value) => update("requestScriptTimeoutMs", value)}
          />
          <NumberField
            label="Mock script timeout (ms)"
            value={draft.mockScriptTimeoutMs}
            onChange={(value) => update("mockScriptTimeoutMs", value)}
          />
          <NumberField
            label="Event script timeout (ms)"
            value={draft.responseScriptTimeoutMs}
            onChange={(value) => update("responseScriptTimeoutMs", value)}
          />
          <NumberField
            label="Fetch timeout (ms)"
            value={draft.fetchTimeoutMs}
            onChange={(value) => update("fetchTimeoutMs", value)}
          />
          <NumberField
            label="QuickJS memory (MiB)"
            value={draft.scriptMemoryLimitMb}
            onChange={(value) => update("scriptMemoryLimitMb", value)}
          />
          <NumberField
            label="Request body limit (bytes)"
            value={draft.requestBodyLimitBytes}
            onChange={(value) => update("requestBodyLimitBytes", value)}
          />
          <NumberField
            label="Event data limit (bytes)"
            value={draft.eventDataLimitBytes}
            onChange={(value) => update("eventDataLimitBytes", value)}
          />
          <NumberField
            label="Stream history limit (bytes)"
            value={draft.streamHistoryLimitBytes}
            onChange={(value) => update("streamHistoryLimitBytes", value)}
          />
          <NumberField
            label="Retention days"
            value={draft.retentionDays}
            onChange={(value) => update("retentionDays", value)}
          />
          <NumberField
            label="Retention event records"
            value={draft.retentionEventLimit}
            onChange={(value) => update("retentionEventLimit", value)}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ScriptsEditor({
  draft,
  update,
}: {
  draft: EndpointDraft;
  update: <K extends keyof EndpointDraft>(
    key: K,
    value: EndpointDraft[K],
  ) => void;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ScriptCard
        description="Runs once before the endpoint chooses Forward, Mock, or Breakpoint behavior. Read the immutable request method, URL, headers, and body from request; change the mutable forward URL, method, body, or headers. Return a partial forwarding object, mutate forward directly, or do both. Mock mode keeps header, method, and body changes but ignores URL overrides."
        kind="request"
        label="Request script"
        onChange={(value) => update("requestScript", value)}
        placeholder={REQUEST_SCRIPT_PLACEHOLDER}
        source={draft.requestScript}
        timeoutMs={draft.requestScriptTimeoutMs}
      />
      <ScriptCard
        description="Runs once with phase set to headers before the response starts, then again with phase set to event for every forwarded or generated source event. Read request, endpoint, event, response, and the current delivery/history buffers. During the headers phase, mutate or return response status and headers. During the event phase, pass through, drop, replace, fan out, or split buffered data."
        kind="response"
        label="Response event script"
        onChange={(value) => update("responseScript", value)}
        placeholder={RESPONSE_SCRIPT_PLACEHOLDER}
        source={draft.responseScript}
        timeoutMs={draft.responseScriptTimeoutMs}
      />
      <ScriptRuntimeOverview />
    </div>
  );
}

function ScriptCard({
  label,
  description,
  kind,
  placeholder,
  source,
  timeoutMs,
  onChange,
}: {
  label: string;
  description: string;
  kind: "request" | "response";
  placeholder: string;
  source: string;
  timeoutMs: number;
  onChange: (source: string) => void;
}) {
  const [result, setResult] = useState<unknown>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  async function test() {
    setTesting(true);
    try {
      const data = await controlPlaneRequest<{ testSseScript: unknown }>(
        `mutation TestSseScript($input: SseScriptTestInput!) { testSseScript(input: $input) { result resultDefined context console storageWrites durationMs } }`,
        {
          input: {
            source,
            timeoutMs,
            context: scriptTestContext(kind),
          },
        },
      );
      setResult(data.testSseScript);
      setTestError(null);
    } catch (value) {
      setTestError(value instanceof Error ? value.message : String(value));
    } finally {
      setTesting(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Button
            disabled={testing}
            onClick={() => void test()}
            size="sm"
            variant="outline"
          >
            <FlaskConical /> {testing ? "Running…" : "Test"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          aria-label={label}
          className="min-h-96 font-mono text-xs"
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          value={source}
        />
        {testError ? (
          <Alert variant="destructive">
            <AlertDescription>{testError}</AlertDescription>
          </Alert>
        ) : null}
        {result !== null ? (
          <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
            {JSON.stringify(result, null, 2)}
          </pre>
        ) : null}
      </CardContent>
    </Card>
  );
}

function scriptTestContext(kind: "request" | "response") {
  const request = {
    id: "script-test",
    method: "POST",
    url: "https://example.test/api/public/sse/test-token",
    headers: [
      { name: "authorization", value: "Bearer example" },
      { name: "content-type", value: "application/json" },
    ],
    body: {
      text: '{"message":"Hello world"}',
      base64: "eyJtZXNzYWdlIjoiSGVsbG8gd29ybGQifQ==",
      json: { message: "Hello world" },
      byteLength: 25,
    },
  };
  const endpoint = {
    id: "endpoint-test",
    name: "Script test endpoint",
    mode: "FORWARD",
  };
  if (kind === "request") {
    return {
      phase: "request",
      endpoint,
      request,
      forward: {
        url: "https://api.example.com/events",
        method: "POST",
        headers: [
          { name: "authorization", value: "Bearer example" },
          { name: "x-remove-before-forwarding", value: "true" },
        ],
        body: request.body.text,
      },
      response: null,
      event: null,
      buffers: { delivery: "", history: "" },
    };
  }
  return {
    phase: "event",
    endpoint,
    request: {
      ...request,
      effective: {
        url: "https://api.example.com/events",
        method: "POST",
        headers: request.headers,
        body: request.body.text,
      },
    },
    response: {
      status: 200,
      headers: [{ name: "content-type", value: "text/event-stream" }],
    },
    event: {
      event: null,
      data: "Hello\n\nworld",
      id: "event-123",
      retry: null,
    },
    buffers: {
      delivery: "Hello\n\nworld",
      history: "Hello\n\nworld",
    },
  };
}

function ScriptRuntimeOverview() {
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>Script runtime and shared variables</CardTitle>
        <CardDescription>
          Every script is wrapped as asynchronous JavaScript, so you can use
          await directly. Test runs use copy-on-write storage and show proposed
          writes without changing live values.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <ScriptGuideSection title="Inputs and header controls">
          <p>
            <code>request</code> and its headers are read-only. Request scripts
            receive mutable <code>forward</code> and <code>forwarding</code>
            aliases. Response scripts receive <code>phase</code>, mutable{" "}
            <code>response</code>, the current <code>event</code>, and the{" "}
            <code>buffers.delivery</code> and <code>buffers.history</code> text.
          </p>
          <p>
            Header bags support <code>get</code>, <code>getAll</code>,{" "}
            <code>has</code>, <code>set</code>, <code>append</code>,{" "}
            <code>delete</code>, and <code>replace</code>. Response status and
            headers can only change during the headers phase.
          </p>
        </ScriptGuideSection>
        <ScriptGuideSection title="Return values">
          <p>
            A request script can return any combination of <code>url</code>,{" "}
            <code>method</code>, <code>headers</code>, and <code>body</code>. A
            response event script returns <code>undefined</code> to pass
            through,
            <code>null</code> or an empty list to drop, one event to replace, or
            an array of events to fan out.
          </p>
          <p>
            Return{" "}
            <code>{`{ split: { target, offset, separatorLength } }`}</code>
            to flush part of the Delivery, History, or Both buffer while keeping
            the remainder for later data.
          </p>
        </ScriptGuideSection>
        <ScriptGuideSection title="Global storage">
          <p>
            Local variables live for one invocation. To keep JSON values between
            requests and events, use the global <code>storage</code> object. Its
            keys are shared by every SSE endpoint, and <code>get</code> returns
            the stored value together with its monotonically increasing version.
          </p>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 text-xs">
            {`const current = await storage.get("session");
await storage.set("session", { token });
await storage.increment("event-count", 1);
await storage.compareAndSet("session", current?.version ?? null, nextValue);
await storage.update("session", (value) => ({ ...value, refreshed: true }));
await storage.delete("session");`}
          </pre>
        </ScriptGuideSection>
        <ScriptGuideSection title="Network and sandbox">
          <p>
            Use <code>fetch</code> for HTTP or HTTPS calls and await{" "}
            <code>text()</code> or <code>json()</code> on the response. Fetches
            use the endpoint timeout and can be used to turn an authorization
            header or stored token into generated event data.
          </p>
          <p>
            Scripts run in QuickJS with no imports, Node APIs, DOM, or
            filesystem access. Console output, duration, return values, errors,
            and proposed storage changes are included in test results.
          </p>
        </ScriptGuideSection>
      </CardContent>
    </Card>
  );
}

function ScriptGuideSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2 text-sm text-muted-foreground">
      <h3 className="font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function MockBuilder({
  endpointId,
  templates,
  compositions,
  activeCompositionId,
  onChanged,
}: {
  endpointId: string;
  templates: SseMockTemplate[];
  compositions: SseMockComposition[];
  activeCompositionId: string | null;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(
    templates[0]?.id ?? null,
  );
  const activeTemplate =
    templates.find((item) => item.id === templateId) ?? null;
  const [templateDraft, setTemplateDraft] = useState({
    name: "",
    eventName: "",
    data: "",
    eventId: "",
    retryMs: "",
  });
  const [compositionId, setCompositionId] = useState<string | null>(
    compositions[0]?.id ?? null,
  );
  const selected =
    compositions.find((item) => item.id === compositionId) ?? null;
  const [compositionName, setCompositionName] = useState("New mock");
  const [statusCode, setStatusCode] = useState(200);
  const [headers, setHeaders] = useState("Content-Type: text/event-stream");
  const [blocks, setBlocks] = useState<DraftBlock[]>([]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (activeTemplate)
        setTemplateDraft({
          name: activeTemplate.name,
          eventName: activeTemplate.eventName ?? "",
          data: activeTemplate.data,
          eventId: activeTemplate.eventId ?? "",
          retryMs: activeTemplate.retryMs?.toString() ?? "",
        });
      else
        setTemplateDraft({
          name: "",
          eventName: "",
          data: "",
          eventId: "",
          retryMs: "",
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTemplate]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!selected) {
        setCompositionName("New mock");
        setStatusCode(200);
        setHeaders("Content-Type: text/event-stream");
        setBlocks([]);
        return;
      }
      setCompositionName(selected.name);
      setStatusCode(selected.statusCode);
      setHeaders(
        selected.headers
          .map((header) => `${header.name}: ${header.value}`)
          .join("\n"),
      );
      setBlocks(
        selected.blocks.map((block) => ({
          key: block.id,
          kind: block.kind,
          templateId: block.template?.id ?? undefined,
          delayMs: block.delayMs ?? undefined,
          script: block.script ?? undefined,
        })),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selected]);

  const parsedHeaders = useMemo(
    () =>
      headers
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf(":");
          return {
            name: at < 0 ? line.trim() : line.slice(0, at).trim(),
            value: at < 0 ? "" : line.slice(at + 1).trim(),
          };
        }),
    [headers],
  );

  async function saveTemplate() {
    try {
      const data = await controlPlaneRequest<{
        saveSseMockEventTemplate: SseMockTemplate;
      }>(
        `mutation SaveSseTemplate($endpointId: ID!, $input: SseMockEventTemplateInput!) { saveSseMockEventTemplate(endpointId: $endpointId, input: $input) { id endpointId name eventName data eventId retryMs } }`,
        {
          endpointId,
          input: {
            id: templateId,
            name: templateDraft.name,
            eventName: templateDraft.eventName || null,
            data: templateDraft.data,
            eventId: templateDraft.eventId || null,
            retryMs: templateDraft.retryMs
              ? Number(templateDraft.retryMs)
              : null,
          },
        },
      );
      setTemplateId(data.saveSseMockEventTemplate.id);
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function deleteTemplate() {
    if (!templateId) return;
    try {
      await controlPlaneRequest(
        `mutation DeleteSseTemplate($id: ID!) { deleteSseMockEventTemplate(id: $id) }`,
        { id: templateId },
      );
      setTemplateId(null);
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function saveComposition(duplicate = false) {
    try {
      const data = await controlPlaneRequest<{
        saveSseMockComposition: SseMockComposition;
      }>(
        `mutation SaveSseComposition($endpointId: ID!, $id: ID, $input: SseMockCompositionInput!) { saveSseMockComposition(endpointId: $endpointId, id: $id, input: $input) { ${SSE_COMPOSITION_FIELDS} } }`,
        {
          endpointId,
          id: duplicate ? null : compositionId,
          input: {
            name: duplicate ? `${compositionName} copy` : compositionName,
            statusCode,
            headers: parsedHeaders,
            blocks: blocks.map(({ kind, templateId: id, delayMs, script }) => ({
              kind,
              templateId: id,
              delayMs,
              script,
            })),
          },
        },
      );
      setCompositionId(data.saveSseMockComposition.id);
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function activate() {
    if (!compositionId) return;
    try {
      await controlPlaneRequest(
        `mutation ActivateSseComposition($endpointId: ID!, $compositionId: ID) { activateSseMockComposition(endpointId: $endpointId, compositionId: $compositionId) { id activeMockCompositionId } }`,
        { endpointId, compositionId },
      );
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  async function deleteComposition() {
    if (!compositionId) return;
    try {
      await controlPlaneRequest(
        `mutation DeleteSseComposition($id: ID!) { deleteSseMockComposition(id: $id) }`,
        { id: compositionId },
      );
      setCompositionId(null);
      await onChanged();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }

  function addBlock(kind: DraftBlock["kind"]) {
    setBlocks((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        kind,
        templateId: kind === "EVENT" ? templates[0]?.id : undefined,
        delayMs: kind === "DELAY" ? 1_000 : undefined,
        script:
          kind === "SCRIPT"
            ? "return { data: 'Hello from a mock script' };"
            : undefined,
      },
    ]);
  }
  function changeBlock(index: number, patch: Partial<DraftBlock>) {
    setBlocks((current) =>
      current.map((block, at) =>
        at === index ? { ...block, ...patch } : block,
      ),
    );
  }
  function moveBlock(index: number, offset: -1 | 1) {
    setBlocks((current) => {
      const next = [...current];
      const target = index + offset;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[minmax(300px,0.7fr)_minmax(0,1.3fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Event template library</CardTitle>
            <CardDescription>
              Reusable event payloads scoped to this endpoint.
            </CardDescription>
            <CardAction>
              <Button
                onClick={() => setTemplateId(null)}
                size="sm"
                variant="outline"
              >
                <Plus /> New
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select
              onValueChange={(value) =>
                setTemplateId(value === "new" ? null : value)
              }
              value={templateId ?? "new"}
            >
              <SelectTrigger>
                <SelectValue placeholder="New template" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New template</SelectItem>
                {templates.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Field label="Template name">
              <Input
                onChange={(e) =>
                  setTemplateDraft((d) => ({ ...d, name: e.target.value }))
                }
                value={templateDraft.name}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Event name">
                <Input
                  onChange={(e) =>
                    setTemplateDraft((d) => ({
                      ...d,
                      eventName: e.target.value,
                    }))
                  }
                  placeholder="message"
                  value={templateDraft.eventName}
                />
              </Field>
              <Field label="Event ID">
                <Input
                  onChange={(e) =>
                    setTemplateDraft((d) => ({ ...d, eventId: e.target.value }))
                  }
                  value={templateDraft.eventId}
                />
              </Field>
            </div>
            <Field label="Data">
              <Textarea
                className="min-h-36 font-mono text-xs"
                onChange={(e) =>
                  setTemplateDraft((d) => ({ ...d, data: e.target.value }))
                }
                value={templateDraft.data}
              />
            </Field>
            <Field label="Retry (ms)">
              <Input
                min={0}
                onChange={(e) =>
                  setTemplateDraft((d) => ({ ...d, retryMs: e.target.value }))
                }
                type="number"
                value={templateDraft.retryMs}
              />
            </Field>
            <div className="flex gap-2">
              <Button
                disabled={!templateDraft.name.trim()}
                onClick={() => void saveTemplate()}
              >
                <Save /> Save template
              </Button>
              {templateId ? (
                <Button
                  onClick={() => void deleteTemplate()}
                  variant="destructive"
                >
                  <Trash2 /> Delete
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Mock composition builder</CardTitle>
            <CardDescription>
              Compose response headers with ordered Event Template, Delay, and
              Script blocks.
            </CardDescription>
            <CardAction>
              {compositionId === activeCompositionId ? (
                <Badge variant="success">
                  <Check /> Active
                </Badge>
              ) : null}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Select
                onValueChange={(value) =>
                  setCompositionId(value === "new" ? null : value)
                }
                value={compositionId ?? "new"}
              >
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">New composition</SelectItem>
                  {compositions.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => setCompositionId(null)}
                size="sm"
                variant="outline"
              >
                <Plus /> New
              </Button>
              {compositionId ? (
                <Button
                  onClick={() => void saveComposition(true)}
                  size="sm"
                  variant="outline"
                >
                  <Copy /> Duplicate
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
              <Field label="Composition name">
                <Input
                  onChange={(e) => setCompositionName(e.target.value)}
                  value={compositionName}
                />
              </Field>
              <NumberField
                label="Status"
                onChange={setStatusCode}
                value={statusCode}
              />
            </div>
            <Field label="Response headers (one per line)">
              <Textarea
                className="font-mono text-xs"
                onChange={(e) => setHeaders(e.target.value)}
                rows={3}
                value={headers}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>Ordered blocks</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!templates.length}
                  onClick={() => addBlock("EVENT")}
                  size="sm"
                  variant="outline"
                >
                  <Plus /> Event
                </Button>
                <Button
                  onClick={() => addBlock("DELAY")}
                  size="sm"
                  variant="outline"
                >
                  <Plus /> Delay
                </Button>
                <Button
                  onClick={() => addBlock("SCRIPT")}
                  size="sm"
                  variant="outline"
                >
                  <Plus /> Script
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              {blocks.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                  Add a block to build this response.
                </div>
              ) : (
                blocks.map((block, index) => (
                  <div
                    className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[auto_8rem_minmax(0,1fr)_auto]"
                    key={block.key}
                  >
                    <Badge className="self-start" variant="outline">
                      {index + 1}
                    </Badge>
                    <Select
                      onValueChange={(value) =>
                        changeBlock(index, {
                          kind: value as DraftBlock["kind"],
                        })
                      }
                      value={block.kind}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="EVENT">Event</SelectItem>
                        <SelectItem value="DELAY">Delay</SelectItem>
                        <SelectItem value="SCRIPT">Script</SelectItem>
                      </SelectContent>
                    </Select>
                    {block.kind === "EVENT" ? (
                      <Select
                        onValueChange={(templateIdValue) =>
                          changeBlock(index, { templateId: templateIdValue })
                        }
                        value={block.templateId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Choose template" />
                        </SelectTrigger>
                        <SelectContent>
                          {templates.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              {item.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : block.kind === "DELAY" ? (
                      <Input
                        aria-label="Delay milliseconds"
                        min={0}
                        onChange={(e) =>
                          changeBlock(index, {
                            delayMs: numberValue(e.target.value, 0),
                          })
                        }
                        type="number"
                        value={block.delayMs ?? 0}
                      />
                    ) : (
                      <Textarea
                        aria-label="Mock block script"
                        className="min-h-28 font-mono text-xs"
                        onChange={(e) =>
                          changeBlock(index, { script: e.target.value })
                        }
                        value={block.script ?? ""}
                      />
                    )}
                    <div className="flex gap-1">
                      <Button
                        aria-label="Move block up"
                        disabled={index === 0}
                        onClick={() => moveBlock(index, -1)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        aria-label="Move block down"
                        disabled={index === blocks.length - 1}
                        onClick={() => moveBlock(index, 1)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        aria-label="Remove block"
                        onClick={() =>
                          setBlocks((current) =>
                            current.filter((_, at) => at !== index),
                          )
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <X />
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!compositionName.trim() || !blocks.length}
                onClick={() => void saveComposition()}
              >
                <Save /> Save composition
              </Button>
              {compositionId ? (
                <Button
                  disabled={compositionId === activeCompositionId}
                  onClick={() => void activate()}
                  variant="outline"
                >
                  <Check /> Make active
                </Button>
              ) : null}
              {compositionId ? (
                <Button
                  onClick={() => void deleteComposition()}
                  variant="destructive"
                >
                  <Trash2 /> Delete
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function EndpointHistory({ endpointId }: { endpointId: string }) {
  const [history, setHistory] = useState<SseHistoryRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        sseHistory: { streams: SseHistoryRequest[] };
      }>(
        `query SseEndpointHistory($input: SseHistoryQueryInput!) { sseHistory(input: $input) { streams { ${SSE_HISTORY_REQUEST_FIELDS} } } }`,
        { input: { view: "STREAMS", endpointId, first: 20 } },
      );
      setHistory(data.sseHistory.streams);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  }, [endpointId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useSseLiveReload("history", () => void load());
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent streams</CardTitle>
        <CardDescription>
          Endpoint-filtered request and response history with unredacted
          headers.
        </CardDescription>
        <CardAction>
          <Button asChild variant="outline">
            <Link href={`/sse/history?endpointId=${endpointId}`}>
              <History /> Open full history
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {history.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No streams have reached this endpoint yet.
          </p>
        ) : (
          history.map((item) => (
            <div
              className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-lg border p-3 text-sm"
              key={item.id}
            >
              <ModeBadge mode={item.mode} />
              <div className="min-w-0">
                <p className="truncate font-mono text-xs">
                  {item.method} {item.requestUrl}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(item.startedAt).toLocaleString()}
                </p>
              </div>
              <Badge
                variant={
                  item.outcome === "COMPLETED"
                    ? "success"
                    : item.error
                      ? "destructive"
                      : "outline"
                }
              >
                {item.outcome ?? item.status}
              </Badge>
              <span className="tabular-nums">{item.eventCount} events</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <FormField>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </FormField>
  );
}

function BufferModeField({
  idPrefix,
  label,
  description,
  value,
  defaultValue,
  onValueChange,
}: {
  idPrefix: string;
  label: string;
  description: string;
  value: SseBufferMode;
  defaultValue: SseBufferMode;
  onValueChange: (value: SseBufferMode) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend>{label}</FieldLegend>
      <FieldDescription>{description}</FieldDescription>
      <RadioGroup
        className="grid gap-3 lg:grid-cols-3"
        onValueChange={(nextValue) => onValueChange(nextValue as SseBufferMode)}
        value={value}
      >
        {BUFFER_MODE_OPTIONS.map((option) => {
          const id = `${idPrefix}-${option.value.toLowerCase()}`;
          const selected = value === option.value;
          return (
            <FormField className="h-full" key={option.value}>
              <FieldLabel className="h-full w-full cursor-pointer" htmlFor={id}>
                <Card
                  className={
                    selected
                      ? "h-full border-primary bg-primary/5 py-0 ring-1 ring-primary/20"
                      : "h-full py-0 transition-colors hover:bg-muted/40"
                  }
                >
                  <CardContent className="flex items-start gap-3 p-4">
                    <RadioGroupItem
                      className="mt-0.5"
                      id={id}
                      value={option.value}
                    />
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">
                          {option.label}
                        </span>
                        {option.value === defaultValue ? (
                          <Badge variant="secondary">Default</Badge>
                        ) : null}
                      </div>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {option.description}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </FieldLabel>
            </FormField>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        onChange={(event) => onChange(numberValue(event.target.value, value))}
        type="number"
        value={value}
      />
    </Field>
  );
}
function SelectField({
  label,
  value,
  values,
  onValueChange,
}: {
  label: string;
  value: string;
  values: string[];
  onValueChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select onValueChange={onValueChange} value={value}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {formatEnumLabel(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
