"use client";

import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowLeft,
  Copy,
  Download,
  GripVertical,
  Plus,
  Save,
  Send,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";

import {
  ConfigFieldsEditor,
  RawConfigEditor,
} from "./config-fields/config-fields-editor";
import { hasConfigDescriptor } from "./config-fields/descriptors";
import { WorkflowInputsEditor } from "./workflow-inputs-editor";
import {
  workflowFlowElements,
  workflowNodeTypes,
  type WorkflowFlowNode,
} from "./workflow-graph";
import {
  emptyDefinition,
  type WorkflowCatalogEntry,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowNodeDefinition,
  type WorkflowSummary,
  type WorkflowTriggerCatalogEntry,
  type WorkflowTriggerDefinition,
} from "./types";

type Catalog = {
  schemaVersion: number;
  globalConcurrency: number;
  steps: WorkflowCatalogEntry[];
  triggers: WorkflowTriggerCatalogEntry[];
};

const CATALOG_QUERY = `
  query WorkflowEditorCatalog($id: ID!) {
    workflowCatalog {
      schemaVersion globalConcurrency
      steps { kind category label description execution configSchema capabilityFlags requiredPaths providedPaths mutatesExternal mutatesWorktree }
      triggers { kind category label configSchema capabilityFlags seedPaths }
    }
    workflow(id: $id) {
      id name description draftDefinition activeVersionId enabled overlapPolicy maxConcurrentRuns archivedAt
      versionCount runCount createdAt updatedAt
    }
  }
`;

function clientId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function groupByCategory<T extends { category: string }>(entries: T[]) {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
  }
  return groups;
}

function defaultNode(
  entry: WorkflowCatalogEntry,
  position: { x: number; y: number },
): WorkflowNodeDefinition {
  return {
    id: clientId("node"),
    kind: entry.kind,
    name: entry.label,
    position,
    config: {},
    requiredPaths: [],
    providedPaths: [],
    retry: { maxAttempts: 1, strategy: "EXPONENTIAL", delaySeconds: 5 },
    failurePolicy: "FAIL",
  };
}

function WorkflowEditorInner({ workflowId }: { workflowId?: string | null }) {
  const t = useTranslations("workflows");
  const router = useRouter();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [workflow, setWorkflow] = useState<WorkflowSummary | null>(null);
  const [definition, setDefinition] = useState<WorkflowDefinition>(() =>
    emptyDefinition(),
  );
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [instance, setInstance] = useState<ReactFlowInstance<
    Node,
    Edge
  > | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<WorkflowDiagnostic[]>([]);
  const [overlapPolicy, setOverlapPolicy] = useState("QUEUE");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);

  const categories = useMemo(
    () =>
      new Map(
        catalog?.steps.map(({ kind, category }) => [kind, category]) ?? [],
      ),
    [catalog],
  );

  const rebuildGraph = useCallback(
    (nextDefinition: WorkflowDefinition, nextDiagnostics = diagnostics) => {
      const elements = workflowFlowElements(nextDefinition, {
        diagnostics: nextDiagnostics,
        categories,
      });
      setNodes(elements.nodes);
      setEdges(elements.edges);
    },
    [categories, diagnostics, setEdges, setNodes],
  );

  useEffect(() => {
    let cancelled = false;
    void controlPlaneRequest<{
      workflowCatalog: Catalog;
      workflow: WorkflowSummary | null;
    }>(CATALOG_QUERY, { id: workflowId ?? "__new__" })
      .then((data) => {
        if (cancelled) return;
        const next = data.workflow?.draftDefinition ?? emptyDefinition();
        setCatalog(data.workflowCatalog);
        setWorkflow(data.workflow);
        setDefinition(next);
        setOverlapPolicy(data.workflow?.overlapPolicy ?? "QUEUE");
        setMaxConcurrentRuns(data.workflow?.maxConcurrentRuns ?? 1);
        const categoryMap = new Map(
          data.workflowCatalog.steps.map(({ kind, category }) => [
            kind,
            category,
          ]),
        );
        const elements = workflowFlowElements(next, {
          categories: categoryMap,
        });
        setNodes(elements.nodes);
        setEdges(elements.edges);
      })
      .catch((value) =>
        setError(value instanceof Error ? value.message : String(value)),
      )
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [setEdges, setNodes, workflowId]);

  const selectedNode =
    definition.nodes.find(({ id }) => id === selectedId) ?? null;
  const selectedTrigger =
    definition.triggers.find(({ id }) => id === selectedId) ?? null;
  const selected = selectedNode ?? selectedTrigger;

  const sessionPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const input of definition.inputs) {
      if (input.path) paths.add(input.path);
    }
    const triggerCatalog = new Map(
      catalog?.triggers.map((entry) => [entry.kind, entry]) ?? [],
    );
    for (const trigger of definition.triggers) {
      for (const path of triggerCatalog.get(trigger.kind)?.seedPaths ?? []) {
        paths.add(path);
      }
    }
    const stepCatalog = new Map(
      catalog?.steps.map((entry) => [entry.kind, entry]) ?? [],
    );
    for (const node of definition.nodes) {
      for (const path of stepCatalog.get(node.kind)?.providedPaths ?? []) {
        paths.add(path);
      }
      for (const path of node.providedPaths) paths.add(path);
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }, [catalog, definition]);

  const commitDefinition = useCallback(
    (next: WorkflowDefinition) => {
      setDefinition(next);
      rebuildGraph(next);
    },
    [rebuildGraph],
  );

  const addStep = useCallback(
    (entry: WorkflowCatalogEntry, position?: { x: number; y: number }) => {
      const offset = definition.nodes.length * 32;
      const node = defaultNode(
        entry,
        position ?? { x: 320 + offset, y: 120 + offset },
      );
      const next = { ...definition, nodes: [...definition.nodes, node] };
      commitDefinition(next);
      setSelectedId(node.id);
    },
    [commitDefinition, definition],
  );

  const addTrigger = useCallback(
    (entry: WorkflowTriggerCatalogEntry) => {
      const trigger: WorkflowTriggerDefinition = {
        id: clientId("trigger"),
        kind: entry.kind,
        name: entry.label,
        position: { x: 0, y: 100 + definition.triggers.length * 140 },
        config: {},
      };
      const next = {
        ...definition,
        triggers: [...definition.triggers, trigger],
      };
      commitDefinition(next);
      setSelectedId(trigger.id);
    },
    [commitDefinition, definition],
  );

  const removeItems = useCallback(
    (ids: string[]) => {
      const removed = new Set(ids);
      const next = {
        ...definition,
        nodes: definition.nodes.filter(({ id }) => !removed.has(id)),
        triggers: definition.triggers.filter(({ id }) => !removed.has(id)),
        edges: definition.edges.filter(
          ({ source, target }) => !removed.has(source) && !removed.has(target),
        ),
      };
      commitDefinition(next);
      if (selectedId && removed.has(selectedId)) setSelectedId(null);
    },
    [commitDefinition, definition, selectedId],
  );

  const duplicateSelected = useCallback(() => {
    const source = definition.nodes.find(({ id }) => id === selectedId);
    if (!source) return;
    const copy = {
      ...structuredClone(source),
      id: clientId("node"),
      name: `${source.name ?? source.kind} copy`,
      position: { x: source.position.x + 36, y: source.position.y + 36 },
    };
    commitDefinition({ ...definition, nodes: [...definition.nodes, copy] });
    setSelectedId(copy.id);
  }, [commitDefinition, definition, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, [contenteditable=true]")) return;
        event.preventDefault();
        duplicateSelected();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateSelected]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const edge = {
        id: clientId("edge"),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? "success",
        targetHandle: connection.targetHandle ?? "input",
      };
      setEdges((current) => addEdge<Edge>(edge, current));
      setDefinition((current) => ({
        ...current,
        edges: [...current.edges, edge],
      }));
    },
    [setEdges],
  );

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = definition;
      if (workflow) {
        const data = await controlPlaneRequest<{
          saveWorkflowDraft: WorkflowSummary;
        }>(
          `mutation SaveWorkflow($input: SaveWorkflowDraftInput!) {
            saveWorkflowDraft(input: $input) {
              id name description draftDefinition activeVersionId enabled overlapPolicy maxConcurrentRuns archivedAt
              versionCount runCount createdAt updatedAt
            }
          }`,
          {
            input: {
              id: workflow.id,
              definition: next,
              overlapPolicy,
              maxConcurrentRuns,
            },
          },
        );
        setWorkflow(data.saveWorkflowDraft);
        setDefinition(data.saveWorkflowDraft.draftDefinition);
        setNotice(t("saved"));
      } else {
        const data = await controlPlaneRequest<{
          createWorkflow: WorkflowSummary;
        }>(
          `mutation CreateWorkflow($input: CreateWorkflowInput!) {
            createWorkflow(input: $input) {
              id name description draftDefinition activeVersionId enabled overlapPolicy maxConcurrentRuns archivedAt
              versionCount runCount createdAt updatedAt
            }
          }`,
          {
            input: {
              name: next.name,
              description: next.description,
              definition: next,
              overlapPolicy,
              maxConcurrentRuns,
            },
          },
        );
        setWorkflow(data.createWorkflow);
        setDefinition(data.createWorkflow.draftDefinition);
        setNotice(t("saved"));
        router.replace(`/workflows/${data.createWorkflow.id}/edit`);
      }
      return true;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const validate = async () => {
    if (!workflow) {
      await save();
      return;
    }
    try {
      const data = await controlPlaneRequest<{
        validateWorkflowDraft: {
          valid: boolean;
          diagnostics: WorkflowDiagnostic[];
        };
      }>(
        `query ValidateWorkflow($id: ID!) {
          validateWorkflowDraft(id: $id) { valid diagnostics { severity code message nodeId triggerId path } }
        }`,
        { id: workflow.id },
      );
      setDiagnostics(data.validateWorkflowDraft.diagnostics);
      rebuildGraph(definition, data.validateWorkflowDraft.diagnostics);
      setNotice(
        data.validateWorkflowDraft.valid
          ? t("validationPassed")
          : t("validationFailed"),
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const publish = async () => {
    if (!workflow) {
      setError(t("saveBeforePublish"));
      return;
    }
    setSaving(true);
    try {
      if (!(await save())) return;
      await controlPlaneRequest(
        `mutation PublishWorkflow($id: ID!) { publishWorkflow(id: $id) { id version contentHash } }`,
        { id: workflow.id },
      );
      setNotice(t("published"));
      router.push(`/workflows/${workflow.id}`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  };

  const duplicateWorkflow = async () => {
    try {
      const data = await controlPlaneRequest<{
        createWorkflow: { id: string };
      }>(
        `mutation DuplicateWorkflow($input: CreateWorkflowInput!) { createWorkflow(input: $input) { id } }`,
        {
          input: {
            name: `${definition.name} copy`,
            description: definition.description,
            definition: { ...definition, name: `${definition.name} copy` },
            overlapPolicy,
            maxConcurrentRuns,
          },
        },
      );
      router.push(`/workflows/${data.createWorkflow.id}/edit`);
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const exportDefinition = async () => {
    try {
      const value = workflow
        ? (
            await controlPlaneRequest<{ exportWorkflow: unknown }>(
              `query ExportWorkflow($id: ID!) { exportWorkflow(id: $id) }`,
              { id: workflow.id },
            )
          ).exportWorkflow
        : {
            format: "aide.workflow.export",
            schemaVersion: 1,
            workflow: {
              name: definition.name,
              description: definition.description,
              overlapPolicy,
              maxConcurrentRuns,
              definition,
            },
          };
      downloadJson(
        value,
        `${definition.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.workflow.json`,
      );
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const importFile = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text()) as Record<string, unknown>;
      const imported =
        payload.format === "aide.workflow.export" &&
        payload.workflow &&
        typeof payload.workflow === "object"
          ? (payload.workflow as { definition?: WorkflowDefinition }).definition
          : payload;
      if (!imported || typeof imported !== "object")
        throw new Error(t("invalidImport"));
      const next = imported as WorkflowDefinition;
      setDefinition(next);
      rebuildGraph(next);
      setNotice(t("importLoaded"));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  const updateSelected = (
    patch: Partial<WorkflowNodeDefinition & WorkflowTriggerDefinition>,
  ) => {
    const next = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === selectedId
          ? ({ ...node, ...patch } as WorkflowNodeDefinition)
          : node,
      ),
      triggers: definition.triggers.map((trigger) =>
        trigger.id === selectedId
          ? ({ ...trigger, ...patch } as WorkflowTriggerDefinition)
          : trigger,
      ),
    };
    commitDefinition(next);
  };

  const filteredSteps = useMemo(
    () =>
      catalog?.steps.filter((entry) =>
        `${entry.label} ${entry.kind} ${entry.category}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ) ?? [],
    [catalog, search],
  );

  if (loading) {
    return (
      <div className="flex min-h-80 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!catalog)
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Button asChild size="icon" variant="ghost">
            <Link
              href={workflow ? `/workflows/${workflow.id}` : "/workflows"}
              aria-label={t("back")}
            >
              <ArrowLeft />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("editor")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("editorDescription")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }}
            ref={fileRef}
            type="file"
          />
          <Button onClick={() => fileRef.current?.click()} variant="outline">
            <Upload /> {t("import")}
          </Button>
          <Button onClick={() => void exportDefinition()} variant="outline">
            <Download /> {t("export")}
          </Button>
          {workflow && (
            <Button onClick={() => void duplicateWorkflow()} variant="outline">
              <Copy /> {t("duplicate")}
            </Button>
          )}
          <Button
            disabled={saving}
            onClick={() => void save()}
            variant="outline"
          >
            {saving ? <Spinner /> : <Save />} {t("saveDraft")}
          </Button>
          <Button disabled={saving} onClick={() => void publish()}>
            <Send /> {t("publish")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("workflowSettings")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="workflow-name">{t("name")}</Label>
                <Input
                  id="workflow-name"
                  onChange={(event) =>
                    setDefinition((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  value={definition.name}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-description">{t("description")}</Label>
                <Textarea
                  id="workflow-description"
                  onChange={(event) =>
                    setDefinition((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  value={definition.description}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("overlapPolicy")}</Label>
                <Select onValueChange={setOverlapPolicy} value={overlapPolicy}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="QUEUE">{t("overlap.QUEUE")}</SelectItem>
                    <SelectItem value="CONCURRENT">
                      {t("overlap.CONCURRENT")}
                    </SelectItem>
                    <SelectItem value="COALESCE_LATEST">
                      {t("overlap.COALESCE_LATEST")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-concurrency">
                  {t("maxConcurrentRuns")}
                </Label>
                <Input
                  id="workflow-concurrency"
                  max={32}
                  min={1}
                  onChange={(event) =>
                    setMaxConcurrentRuns(Number(event.target.value))
                  }
                  type="number"
                  value={maxConcurrentRuns}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("typedInputs")}</Label>
                <WorkflowInputsEditor
                  onChange={(inputs) =>
                    setDefinition((current) => ({ ...current, inputs }))
                  }
                  value={definition.inputs}
                />
              </div>
              <Button
                className="w-full"
                onClick={() => void validate()}
                variant="outline"
              >
                {t("validate")}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("palette")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                aria-label={t("searchSteps")}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchSteps")}
                value={search}
              />
              <div className="max-h-[48vh] space-y-4 overflow-y-auto pr-1">
                {[...groupByCategory(filteredSteps)].map(
                  ([category, entries]) => (
                    <div key={category}>
                      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                        {category}
                      </p>
                      <div className="space-y-1">
                        {entries.map((entry) => (
                          <button
                            className="flex w-full cursor-grab items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-left text-xs hover:bg-muted"
                            draggable
                            key={entry.kind}
                            onClick={() => addStep(entry)}
                            onDragStart={(event) => {
                              event.dataTransfer.setData(
                                "application/aide-workflow-step",
                                entry.kind,
                              );
                              event.dataTransfer.effectAllowed = "copy";
                            }}
                            type="button"
                          >
                            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-medium">
                                {entry.label}
                              </span>
                              <span className="block truncate text-[10px] text-muted-foreground">
                                {entry.execution}
                              </span>
                            </span>
                            {(entry.mutatesExternal ||
                              entry.mutatesWorktree) && (
                              <Badge className="text-[9px]" variant="outline">
                                {t("mutates")}
                              </Badge>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  ),
                )}
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    {t("triggers")}
                  </p>
                  <div className="space-y-1">
                    {catalog.triggers.map((entry) => (
                      <Button
                        className="w-full justify-start"
                        key={entry.kind}
                        onClick={() => addTrigger(entry)}
                        size="sm"
                        variant="outline"
                      >
                        <Plus /> {entry.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="min-w-0 space-y-3">
          <div
            className="h-[min(78vh,860px)] min-h-[520px] overflow-hidden rounded-xl border bg-muted/20"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const kind = event.dataTransfer.getData(
                "application/aide-workflow-step",
              );
              const entry = catalog.steps.find(
                (candidate) => candidate.kind === kind,
              );
              if (!entry || !instance) return;
              addStep(
                entry,
                instance.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                }),
              );
            }}
            ref={wrapperRef}
          >
            <ReactFlow
              deleteKeyCode={["Backspace", "Delete"]}
              edges={edges}
              fitView
              nodeTypes={workflowNodeTypes}
              nodes={nodes}
              onConnect={onConnect}
              onEdgesChange={onEdgesChange}
              onInit={(value) =>
                setInstance(value as unknown as ReactFlowInstance<Node, Edge>)
              }
              onNodeClick={(_event, node) => setSelectedId(node.id)}
              onNodeDragStop={(_event, node) => {
                setDefinition((current) => ({
                  ...current,
                  nodes: current.nodes.map((entry) =>
                    entry.id === node.id
                      ? { ...entry, position: node.position }
                      : entry,
                  ),
                  triggers: current.triggers.map((entry) =>
                    entry.id === node.id
                      ? { ...entry, position: node.position }
                      : entry,
                  ),
                }));
              }}
              onNodesChange={onNodesChange}
              onNodesDelete={(removed) =>
                removeItems(removed.map(({ id }) => id))
              }
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={20} size={1} />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("outlineFallback")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2" role="list">
                {[...definition.triggers, ...definition.nodes].map((entry) => (
                  <Button
                    aria-current={entry.id === selectedId}
                    key={entry.id}
                    onClick={() => setSelectedId(entry.id)}
                    role="listitem"
                    size="sm"
                    variant={entry.id === selectedId ? "default" : "outline"}
                  >
                    {entry.name ?? entry.kind}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
          {diagnostics.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t("diagnostics")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {diagnostics.map((diagnostic, index) => (
                  <button
                    className="block w-full rounded-lg border p-2 text-left text-sm hover:bg-muted"
                    key={`${diagnostic.code}-${index}`}
                    onClick={() =>
                      setSelectedId(diagnostic.nodeId ?? diagnostic.triggerId)
                    }
                    type="button"
                  >
                    <Badge
                      variant={
                        diagnostic.severity === "ERROR"
                          ? "destructive"
                          : "outline"
                      }
                    >
                      {diagnostic.code}
                    </Badge>
                    <span className="ml-2">{diagnostic.message}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Sheet
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        open={Boolean(selected)}
      >
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.name ?? selected.kind}</SheetTitle>
                <SheetDescription>{selected.kind}</SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4">
                <div className="space-y-1.5">
                  <Label htmlFor="node-name">{t("name")}</Label>
                  <Input
                    id="node-name"
                    onChange={(event) =>
                      updateSelected({ name: event.target.value })
                    }
                    value={selected.name ?? ""}
                  />
                </div>
                {hasConfigDescriptor(
                  selected.kind,
                  selectedNode ? "step" : "trigger",
                ) ? (
                  <ConfigFieldsEditor
                    config={selected.config}
                    key={selected.id}
                    kind={selected.kind}
                    onChange={(config) => updateSelected({ config })}
                    scope={selectedNode ? "step" : "trigger"}
                    sessionPaths={sessionPaths}
                  />
                ) : (
                  <div className="space-y-1.5" key={selected.id}>
                    <Label>{t("configuration")}</Label>
                    <RawConfigEditor
                      config={selected.config}
                      defaultOpen
                      onChange={(config) => updateSelected({ config })}
                    />
                  </div>
                )}
                {selectedNode && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="required-paths">
                        {t("requiredPaths")}
                      </Label>
                      <Input
                        id="required-paths"
                        onChange={(event) =>
                          updateSelected({
                            requiredPaths: event.target.value
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          })
                        }
                        value={selectedNode.requiredPaths.join(", ")}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="provided-paths">
                        {t("providedPaths")}
                      </Label>
                      <Input
                        id="provided-paths"
                        onChange={(event) =>
                          updateSelected({
                            providedPaths: event.target.value
                              .split(",")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          })
                        }
                        value={selectedNode.providedPaths.join(", ")}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor="retry-count">{t("maxAttempts")}</Label>
                        <Input
                          id="retry-count"
                          max={20}
                          min={1}
                          onChange={(event) =>
                            updateSelected({
                              retry: {
                                ...selectedNode.retry,
                                maxAttempts: Number(event.target.value),
                              },
                            })
                          }
                          type="number"
                          value={selectedNode.retry.maxAttempts}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("failurePolicy")}</Label>
                        <Select
                          onValueChange={(value) =>
                            updateSelected({
                              failurePolicy: value as "FAIL" | "CONTINUE",
                            })
                          }
                          value={selectedNode.failurePolicy}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="FAIL">
                              {t("failure.FAIL")}
                            </SelectItem>
                            <SelectItem value="CONTINUE">
                              {t("failure.CONTINUE")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {catalog.steps.find(
                      ({ kind }) => kind === selectedNode.kind,
                    )?.mutatesExternal && (
                      <Alert variant="destructive">
                        <AlertDescription>
                          {t("idempotencyWarning")}
                        </AlertDescription>
                      </Alert>
                    )}
                  </>
                )}
              </div>
              <SheetFooter>
                {selectedNode && (
                  <Button onClick={duplicateSelected} variant="outline">
                    <Copy /> {t("duplicateNode")}
                  </Button>
                )}
                <Button
                  onClick={() => removeItems([selected.id])}
                  variant="destructive"
                >
                  <Trash2 /> {t("deleteNode")}
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function WorkflowEditor(props: { workflowId?: string | null }) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
