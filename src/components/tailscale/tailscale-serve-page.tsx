"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Globe2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { WorkflowResourcePanel } from "@/components/workflows/workflow-resource-panel";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { createClientId } from "@/lib/browser-utils";
import {
  controlPlaneRequest,
  controlPlaneSubscriptions,
} from "@/lib/control-plane-client";
import { cn } from "@/lib/utils";

type Route = {
  protocol: "HTTP" | "HTTPS" | "TCP" | "TLS_TERMINATED_TCP";
  listenPort: number;
  mountPath: string;
  destination: {
    protocol: "HTTP" | "HTTPS" | "HTTPS_INSECURE" | "TCP";
    port: number;
    path: string;
  };
  funnel: boolean;
  appCapabilities: string[];
  proxyProtocol: "NONE" | "V1" | "V2";
};

type Agent = {
  id: string;
  name: string;
  hostname: string;
  lastSeenAt: string | null;
  disconnectedAt: string | null;
};

type AgentState = {
  agent: Agent;
  supported: boolean;
  dnsHostname: string | null;
  ipv4: string[];
  ipv6: string[];
  backendState: string;
  observedRoutes: Route[];
  lastInspectedAt: string | null;
  error: string | null;
};

type Assignment = {
  agent: Agent;
  desiredEnabled: boolean;
  observedEnabled: boolean;
  observedFingerprint: string | null;
  revision: number;
  status: string;
  lastJobId: string | null;
  lastError: string | null;
  lastObservedAt: string | null;
};

type Template = {
  id: string;
  name: string;
  route: Route;
  fingerprint: string;
  revision: number;
  lifecycle: "ACTIVE" | "DELETING";
  origin: "USER" | "IMPORTED";
  assignments: Assignment[];
  createdAt: string;
  updatedAt: string;
};

type Overview = {
  agents: AgentState[];
  templates: Template[];
  updatedAt: string;
};

type Operation = {
  id: string;
  kind: string;
  status: string;
  templateId: string | null;
  agents: Array<{
    agent: Agent;
    status: string;
    error: string | null;
    job: { id: string; status: string; error: string | null } | null;
  }>;
};

const ROUTE_FIELDS = `
  protocol listenPort mountPath funnel appCapabilities proxyProtocol
  destination { protocol port path }
`;
const AGENT_FIELDS = `id name hostname lastSeenAt disconnectedAt`;
const OPERATION_FIELDS = `
  id kind status templateId createdAt finishedAt updatedAt
  agents { agent { ${AGENT_FIELDS} } status error job { id status error } }
`;
const OVERVIEW_FIELDS = `
  updatedAt
  agents {
    agent { ${AGENT_FIELDS} }
    supported dnsHostname ipv4 ipv6 backendState lastInspectedAt error
    observedRoutes { ${ROUTE_FIELDS} }
  }
  templates {
    id name fingerprint revision lifecycle origin createdAt updatedAt
    route { ${ROUTE_FIELDS} }
    assignments {
      agent { ${AGENT_FIELDS} }
      desiredEnabled observedEnabled observedFingerprint revision status
      lastJobId lastError lastObservedAt
    }
  }
`;

type EditorState = {
  id: string | null;
  expectedRevision: number | null;
  name: string;
  protocol: Route["protocol"];
  listenPort: string;
  mountPath: string;
  destinationProtocol: Route["destination"]["protocol"];
  destinationPort: string;
  destinationPath: string;
  funnel: boolean;
  appCapabilities: string;
  proxyProtocol: Route["proxyProtocol"];
  assignments: Record<string, boolean>;
};

function emptyEditor(agents: AgentState[]): EditorState {
  return {
    id: null,
    expectedRevision: null,
    name: "",
    protocol: "HTTPS",
    listenPort: "443",
    mountPath: "/",
    destinationProtocol: "HTTP",
    destinationPort: "3000",
    destinationPath: "",
    funnel: false,
    appCapabilities: "",
    proxyProtocol: "NONE",
    assignments: Object.fromEntries(
      agents
        .filter(({ supported }) => supported)
        .map(({ agent }) => [agent.id, true]),
    ),
  };
}

function editorFor(template: Template): EditorState {
  return {
    id: template.id,
    expectedRevision: template.revision,
    name: template.name,
    protocol: template.route.protocol,
    listenPort: String(template.route.listenPort),
    mountPath: template.route.mountPath,
    destinationProtocol: template.route.destination.protocol,
    destinationPort: String(template.route.destination.port),
    destinationPath: template.route.destination.path,
    funnel: template.route.funnel,
    appCapabilities: template.route.appCapabilities.join(", "),
    proxyProtocol: template.route.proxyProtocol,
    assignments: Object.fromEntries(
      template.assignments.map(({ agent, desiredEnabled }) => [
        agent.id,
        desiredEnabled,
      ]),
    ),
  };
}

function routeLabel(route: Route): string {
  const path = ["HTTP", "HTTPS"].includes(route.protocol)
    ? route.mountPath
    : "";
  return `${route.protocol.replaceAll("_", " ")} :${route.listenPort}${path}`;
}

function destinationLabel(route: Route): string {
  return `${route.destination.protocol.toLowerCase().replace("_", "+")}://127.0.0.1:${route.destination.port}${route.destination.path}`;
}

function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "SUCCEEDED" || status === "Running") return "default";
  if (["FAILED", "PARTIAL_FAILED", "TIMED_OUT"].includes(status))
    return "destructive";
  if (["QUEUING", "QUEUED", "RUNNING", "PENDING"].includes(status))
    return "secondary";
  return "outline";
}

export function TailscaleServePage() {
  const t = useTranslations("tailscale");
  const tc = useTranslations("common");
  const ts = useTranslations("status");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [confirmFunnel, setConfirmFunnel] = useState(false);
  const [deleteTemplate, setDeleteTemplate] = useState<Template | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await controlPlaneRequest<{
        tailscaleServeOverview: Overview;
      }>(
        `query TailscaleServeOverview { tailscaleServeOverview { ${OVERVIEW_FIELDS} } }`,
      );
      setOverview(data.tailscaleServeOverview);
      setError(null);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void load();
    }, 0);
    const unsubscribe = controlPlaneSubscriptions().subscribe<{
      tailscaleServeOverviewChanged: Overview;
    }>(
      {
        query: `subscription TailscaleServeOverviewChanged {
          tailscaleServeOverviewChanged { ${OVERVIEW_FIELDS} }
        }`,
      },
      {
        next: (value) => {
          if (value.data?.tailscaleServeOverviewChanged) {
            setOverview(value.data.tailscaleServeOverviewChanged);
          }
        },
        error: () => undefined,
        complete: () => undefined,
      },
    );
    return () => {
      window.clearTimeout(initialLoad);
      unsubscribe();
    };
  }, [load]);

  const run = useCallback(
    async (work: () => Promise<Operation>) => {
      setBusy(true);
      setError(null);
      try {
        const operation = await work();
        const failures = operation.agents.filter(
          ({ status }) => !["SUCCEEDED", "QUEUED", "RUNNING"].includes(status),
        );
        if (failures.length) {
          setError(
            failures
              .map(
                ({ agent, error: itemError }) =>
                  `${agent.name}: ${itemError ?? t("operationFailed")}`,
              )
              .join("\n"),
          );
        }
        await load();
        return operation;
      } catch (value) {
        setError(value instanceof Error ? value.message : String(value));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [load, t],
  );

  const inspect = () =>
    void run(async () => {
      const data = await controlPlaneRequest<{
        inspectTailscaleServe: Operation;
      }>(
        `mutation InspectTailscaleServe($requestId: ID!) {
          inspectTailscaleServe(agentIds: [], requestId: $requestId) { ${OPERATION_FIELDS} }
        }`,
        { requestId: createClientId() },
      );
      return data.inspectTailscaleServe;
    });

  const save = async () => {
    if (!editor) return;
    if (editor.funnel && !confirmFunnel) {
      setConfirmFunnel(true);
      return;
    }
    const assignments = Object.entries(editor.assignments).map(
      ([agentId, enabled]) => ({ agentId, enabled }),
    );
    await run(async () => {
      const data = await controlPlaneRequest<{
        upsertTailscaleServeTemplate: Operation;
      }>(
        `mutation UpsertTailscaleServeTemplate($input: TailscaleServeTemplateInput!, $requestId: ID!) {
          upsertTailscaleServeTemplate(input: $input, requestId: $requestId) { ${OPERATION_FIELDS} }
        }`,
        {
          requestId: createClientId(),
          input: {
            id: editor.id,
            expectedRevision: editor.expectedRevision,
            name: editor.name,
            protocol: editor.protocol,
            listenPort: Number(editor.listenPort),
            mountPath: editor.mountPath,
            destinationProtocol: editor.destinationProtocol,
            destinationPort: Number(editor.destinationPort),
            destinationPath: editor.destinationPath,
            funnel: editor.funnel,
            appCapabilities: editor.appCapabilities
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            proxyProtocol: editor.proxyProtocol,
            assignments,
          },
        },
      );
      return data.upsertTailscaleServeTemplate;
    });
    setEditor(null);
    setConfirmFunnel(false);
  };

  const toggle = (
    template: Template,
    assignment: Assignment,
    enabled: boolean,
  ) =>
    void run(async () => {
      const data = await controlPlaneRequest<{
        setTailscaleServeAgentEnabled: Operation;
      }>(
        `mutation SetTailscaleServeAgentEnabled($templateId: ID!, $agentId: ID!, $enabled: Boolean!, $expectedRevision: Int!, $requestId: ID!) {
          setTailscaleServeAgentEnabled(templateId: $templateId, agentId: $agentId, enabled: $enabled, expectedRevision: $expectedRevision, requestId: $requestId) { ${OPERATION_FIELDS} }
        }`,
        {
          templateId: template.id,
          agentId: assignment.agent.id,
          enabled,
          expectedRevision: template.revision,
          requestId: createClientId(),
        },
      );
      return data.setTailscaleServeAgentEnabled;
    });

  const remove = async () => {
    if (!deleteTemplate) return;
    const target = deleteTemplate;
    setDeleteTemplate(null);
    await run(async () => {
      const data = await controlPlaneRequest<{
        deleteTailscaleServeTemplate: Operation;
      }>(
        `mutation DeleteTailscaleServeTemplate($id: ID!, $expectedRevision: Int!, $requestId: ID!) {
          deleteTailscaleServeTemplate(id: $id, expectedRevision: $expectedRevision, requestId: $requestId) { ${OPERATION_FIELDS} }
        }`,
        {
          id: target.id,
          expectedRevision: target.revision,
          requestId: createClientId(),
        },
      );
      return data.deleteTailscaleServeTemplate;
    });
  };

  const supportedAgents = useMemo(
    () => overview?.agents.filter(({ supported }) => supported).length ?? 0,
    [overview],
  );

  if (loading) {
    return (
      <div className="flex min-h-72 items-center justify-center" role="status">
        <Spinner className="size-6" />
        <span className="sr-only">{t("loading")}</span>
      </div>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-primary">
            <Network className="size-4" aria-hidden="true" />
            {t("eyebrow")}
          </div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={inspect} disabled={busy}>
            <RefreshCw className={cn("size-4", busy && "animate-spin")} />
            {t("inspect")}
          </Button>
          <Button
            onClick={() => setEditor(emptyEditor(overview?.agents ?? []))}
            disabled={!supportedAgents || busy}
          >
            <Plus className="size-4" />
            {t("create")}
          </Button>
        </div>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription className="whitespace-pre-line">
            {error}
          </AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="tailscale-agents-title">
        <div className="mb-3 flex items-center justify-between">
          <h2
            id="tailscale-agents-title"
            className="font-heading text-xl font-semibold"
          >
            {t("agents")}
          </h2>
          <span className="text-sm text-muted-foreground">
            {t("supportedCount", {
              supported: supportedAgents,
              total: overview?.agents.length ?? 0,
            })}
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {overview?.agents.map((state) => (
            <Card key={state.agent.id} size="sm">
              <CardHeader>
                <CardTitle>{state.agent.name}</CardTitle>
                <CardDescription>{state.agent.hostname}</CardDescription>
                <CardAction className="flex flex-wrap justify-end gap-1">
                  <Badge
                    variant={
                      state.agent.disconnectedAt ? "destructive" : "outline"
                    }
                  >
                    {state.agent.disconnectedAt ? ts("offline") : ts("online")}
                  </Badge>
                  <Badge
                    variant={
                      state.supported
                        ? statusVariant(state.backendState)
                        : "outline"
                    }
                  >
                    {state.supported ? state.backendState : t("unsupported")}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("dnsHostname")}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">
                    {state.dnsHostname ?? t("notObserved")}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">
                      IPv4
                    </p>
                    <p className="mt-1 break-all font-mono text-xs">
                      {state.ipv4.join(", ") || "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">
                      IPv6
                    </p>
                    <p className="mt-1 break-all font-mono text-xs">
                      {state.ipv6.join(", ") || "—"}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {state.lastInspectedAt
                    ? t("inspectedAt", {
                        date: new Date(state.lastInspectedAt).toLocaleString(),
                      })
                    : t("neverInspected")}
                </p>
                {state.error && (
                  <p className="text-sm text-destructive">{state.error}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {editor && overview && (
        <TemplateEditor
          editor={editor}
          agents={overview.agents}
          busy={busy}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSave={() => void save()}
          t={t}
          tc={tc}
        />
      )}

      <section aria-labelledby="tailscale-templates-title">
        <h2
          id="tailscale-templates-title"
          className="mb-3 font-heading text-xl font-semibold"
        >
          {t("templates")}
        </h2>
        <div className="grid gap-4 xl:grid-cols-2">
          {overview?.templates.map((template) => (
            <Card key={template.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {template.name}
                  {template.route.funnel && (
                    <Badge variant="destructive">
                      <Globe2 className="size-3" /> Funnel
                    </Badge>
                  )}
                  {template.origin === "IMPORTED" && (
                    <Badge variant="outline">{t("imported")}</Badge>
                  )}
                </CardTitle>
                <CardDescription>
                  {routeLabel(template.route)} →{" "}
                  {destinationLabel(template.route)}
                </CardDescription>
                <CardAction className="flex gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("editNamed", { name: template.name })}
                    onClick={() => setEditor(editorFor(template))}
                    disabled={busy || template.lifecycle === "DELETING"}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("deleteNamed", { name: template.name })}
                    onClick={() => setDeleteTemplate(template)}
                    disabled={busy}
                  >
                    <Trash2 />
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent className="grid gap-4">
                {(template.route.appCapabilities.length > 0 ||
                  template.route.proxyProtocol !== "NONE") && (
                  <div className="flex flex-wrap gap-2 text-xs">
                    {template.route.appCapabilities.map((capability) => (
                      <Badge key={capability} variant="secondary">
                        {capability}
                      </Badge>
                    ))}
                    {template.route.proxyProtocol !== "NONE" && (
                      <Badge variant="secondary">
                        PROXY {template.route.proxyProtocol}
                      </Badge>
                    )}
                  </div>
                )}
                <div className="divide-y rounded-lg border">
                  {template.assignments.map((assignment) => (
                    <div
                      key={assignment.agent.id}
                      className="flex flex-wrap items-center gap-3 p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{assignment.agent.name}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant={statusVariant(assignment.status)}>
                            {assignment.status.replaceAll("_", " ")}
                          </Badge>
                          <span>
                            {assignment.observedEnabled
                              ? t("observedOn")
                              : t("observedOff")}
                          </span>
                        </div>
                        {assignment.lastError && (
                          <p className="mt-2 text-sm text-destructive">
                            {assignment.lastError}
                          </p>
                        )}
                      </div>
                      {assignment.lastError && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            toggle(
                              template,
                              assignment,
                              assignment.desiredEnabled,
                            )
                          }
                          disabled={busy}
                        >
                          <RotateCcw /> {t("retry")}
                        </Button>
                      )}
                      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                        <Checkbox
                          checked={assignment.desiredEnabled}
                          onCheckedChange={(value) =>
                            toggle(template, assignment, value === true)
                          }
                          disabled={busy || template.lifecycle === "DELETING"}
                          aria-label={t("toggleNamed", {
                            agent: assignment.agent.name,
                            template: template.name,
                          })}
                        />
                        {assignment.desiredEnabled ? t("on") : t("off")}
                      </label>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
          {!overview?.templates.length && (
            <Card className="xl:col-span-2">
              <CardContent className="py-10 text-center">
                <CheckCircle2 className="mx-auto size-8 text-muted-foreground" />
                <h3 className="mt-3 font-heading text-lg font-medium">
                  {t("emptyTitle")}
                </h3>
                <p className="mt-1 text-muted-foreground">
                  {t("emptyDescription")}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </section>

      <WorkflowResourcePanel
        resourceKind="TAILSCALE_SERVE_OPERATION"
        resourceId="overview"
        sessionData={{ tailscale: { overview } }}
      />

      <ConfirmationDialog
        open={confirmFunnel}
        onOpenChange={setConfirmFunnel}
        title={t("funnelConfirmTitle")}
        description={t("funnelConfirmDescription")}
        actionLabel={t("exposePublicly")}
        cancelLabel={tc("cancel")}
        onConfirm={() => {
          setConfirmFunnel(false);
          void save();
        }}
      />
      <ConfirmationDialog
        open={Boolean(deleteTemplate)}
        onOpenChange={(open) => !open && setDeleteTemplate(null)}
        title={t("deleteConfirmTitle")}
        description={t("deleteConfirmDescription")}
        actionLabel={t("delete")}
        cancelLabel={tc("cancel")}
        onConfirm={remove}
      />
    </main>
  );
}

function TemplateEditor({
  editor,
  agents,
  busy,
  onChange,
  onCancel,
  onSave,
  t,
  tc,
}: {
  editor: EditorState;
  agents: AgentState[];
  busy: boolean;
  onChange: (value: EditorState) => void;
  onCancel: () => void;
  onSave: () => void;
  t: ReturnType<typeof useTranslations<"tailscale">>;
  tc: ReturnType<typeof useTranslations<"common">>;
}) {
  const update = <K extends keyof EditorState>(key: K, value: EditorState[K]) =>
    onChange({ ...editor, [key]: value });
  const web = editor.protocol === "HTTP" || editor.protocol === "HTTPS";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {editor.id ? t("editTemplate") : t("createTemplate")}
        </CardTitle>
        <CardDescription>{t("editorDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Field label={t("name")}>
            <Input
              value={editor.name}
              onChange={(event) => update("name", event.target.value)}
              required
            />
          </Field>
          <Field label={t("protocol")}>
            <select
              className="h-8 rounded-lg border bg-background px-2 text-sm"
              value={editor.protocol}
              onChange={(event) => {
                const protocol = event.target.value as Route["protocol"];
                update("protocol", protocol);
                if (["TCP", "TLS_TERMINATED_TCP"].includes(protocol)) {
                  onChange({
                    ...editor,
                    protocol,
                    mountPath: "/",
                    destinationProtocol: "TCP",
                    destinationPath: "",
                    appCapabilities: "",
                  });
                }
              }}
            >
              {(["HTTP", "HTTPS", "TCP", "TLS_TERMINATED_TCP"] as const).map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </Field>
          <Field label={t("listenPort")}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={editor.listenPort}
              onChange={(event) => update("listenPort", event.target.value)}
              required
            />
          </Field>
          <Field label={t("mountPath")}>
            <Input
              value={editor.mountPath}
              onChange={(event) => update("mountPath", event.target.value)}
              disabled={!web}
            />
          </Field>
          <Field label={t("destinationProtocol")}>
            <select
              className="h-8 rounded-lg border bg-background px-2 text-sm"
              value={editor.destinationProtocol}
              onChange={(event) =>
                update(
                  "destinationProtocol",
                  event.target.value as Route["destination"]["protocol"],
                )
              }
              disabled={!web}
            >
              {(web ? ["HTTP", "HTTPS", "HTTPS_INSECURE"] : ["TCP"]).map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </Field>
          <Field label={t("destinationPort")}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={editor.destinationPort}
              onChange={(event) =>
                update("destinationPort", event.target.value)
              }
              required
            />
          </Field>
          <Field label={t("destinationPath")}>
            <Input
              value={editor.destinationPath}
              onChange={(event) =>
                update("destinationPath", event.target.value)
              }
              disabled={!web}
            />
          </Field>
          <Field label={t("proxyProtocol")}>
            <select
              className="h-8 rounded-lg border bg-background px-2 text-sm"
              value={editor.proxyProtocol}
              onChange={(event) =>
                update(
                  "proxyProtocol",
                  event.target.value as Route["proxyProtocol"],
                )
              }
              disabled={editor.protocol !== "TCP"}
            >
              {(["NONE", "V1", "V2"] as const).map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field label={t("appCapabilities")} className="md:col-span-2">
            <Input
              value={editor.appCapabilities}
              onChange={(event) =>
                update("appCapabilities", event.target.value)
              }
              placeholder="example.com/editor, example.com/viewer"
              disabled={!web || editor.funnel}
            />
          </Field>
          <label className="flex items-center gap-2 self-end rounded-lg border p-2 text-sm font-medium">
            <Checkbox
              checked={editor.funnel}
              onCheckedChange={(value) => update("funnel", value === true)}
              disabled={editor.protocol === "HTTP"}
            />
            <Globe2 className="size-4" /> {t("funnel")}
          </label>
        </div>
        <fieldset className="mt-5">
          <legend className="mb-2 text-sm font-medium">
            {t("assignAgents")}
          </legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((state) => (
              <label
                key={state.agent.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-3 text-sm",
                  !state.supported && "opacity-60",
                )}
              >
                <Checkbox
                  checked={editor.assignments[state.agent.id] ?? false}
                  onCheckedChange={(value) =>
                    update("assignments", {
                      ...editor.assignments,
                      [state.agent.id]: value === true,
                    })
                  }
                  disabled={!state.supported}
                />
                <span className="flex-1">{state.agent.name}</span>
                {!state.supported && (
                  <Badge variant="outline">{t("unsupported")}</Badge>
                )}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {tc("cancel")}
          </Button>
          <Button
            onClick={onSave}
            disabled={
              busy ||
              !editor.name.trim() ||
              !Object.keys(editor.assignments).length
            }
          >
            {t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
