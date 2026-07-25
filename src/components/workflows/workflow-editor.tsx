"use client";

import {
  addEdge,
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useStore,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  ArrowLeft,
  Copy,
  Download,
  Eye,
  EyeOff,
  GripVertical,
  MousePointer2,
  MousePointer2Off,
  Plus,
  Search,
  Save,
  Send,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link, useRouter } from "@/i18n/navigation";
import { controlPlaneRequest } from "@/lib/control-plane-client";
import {
  computeWorkflowPathAvailability,
  resourceManualSeedPaths,
  type WorkflowPathLookup,
} from "@/lib/workflows/definition";
import {
  expandSessionPaths,
  type SessionFieldInfo,
} from "@/lib/workflows/session-schema";

import {
  ConfigFieldsEditor,
  RawConfigEditor,
} from "./config-fields/config-fields-editor";
import { hasConfigDescriptor } from "./config-fields/descriptors";
import {
  WorkflowFitLock,
  WorkflowFitLockButton,
  workflowFitLockPaneClass,
} from "./workflow-fit-lock";
import {
  MINIMAP_NODE_RADIUS,
  workflowFlowElements,
  WorkflowNodeActionsContext,
  workflowNodeTypes,
  type WorkflowFlowNode,
  type WorkflowNodeActions,
} from "./workflow-graph";
import { useWorkflowLabels } from "./workflow-labels";
import {
  emptyDefinition,
  type WorkflowCatalogEntry,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowHandleLayout,
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

/** Path lookup backed by the GraphQL catalog, for the reachability walk. */
function buildPathLookup(catalog: Catalog | null): WorkflowPathLookup {
  const steps = new Map(
    catalog?.steps.map((entry) => [entry.kind, entry]) ?? [],
  );
  const triggers = new Map(
    catalog?.triggers.map((entry) => [entry.kind, entry]) ?? [],
  );
  return {
    stepPaths: (kind) => {
      const entry = steps.get(kind as WorkflowCatalogEntry["kind"]);
      return {
        requiredPaths: entry?.requiredPaths ?? [],
        providedPaths: entry?.providedPaths ?? [],
      };
    },
    triggerSeedPaths: (kind) =>
      triggers.get(kind as WorkflowTriggerCatalogEntry["kind"])?.seedPaths ??
      [],
  };
}

/**
 * Concrete paths a node adds, for the "Adds to session data" display. Drops the
 * generic `steps.<id>.*` bookkeeping wildcard unless it is the node's only
 * output (e.g. TERMINAL_RUN), where its expansion is the meaningful result.
 */
function displayProvidedPaths(
  nodeId: string,
  provides: Map<string, string[]>,
): SessionFieldInfo[] {
  const all = provides.get(nodeId) ?? [];
  const domain = all.filter((path) => path !== `steps.${nodeId}.*`);
  return expandSessionPaths(domain.length ? domain : all);
}

function providesByNodeMap(
  availability: ReturnType<typeof computeWorkflowPathAvailability>,
): Map<string, string[]> {
  return new Map(
    [...availability.provides.keys()].map((nodeId) => [
      nodeId,
      displayProvidedPaths(nodeId, availability.provides).map(
        (info) => info.path,
      ),
    ]),
  );
}

/**
 * Whether a click came from a finger or a pen rather than a mouse. Clicks are
 * PointerEvents in every browser React Flow supports; anything else — an older
 * engine, a synthesized event — reads as a mouse, which only costs one extra
 * click on a device that had the precision for it anyway.
 */
function touchLike(event: ReactMouseEvent): boolean {
  const pointerType = (event.nativeEvent as Partial<PointerEvent>).pointerType;
  return pointerType !== undefined && pointerType !== "mouse";
}

/**
 * Replaces React Flow's own interactivity toggle, which draws a padlock all but
 * identical to the fit lock sitting right above it. A pointer says the same
 * thing about whether steps can be grabbed, without the second lock.
 */
function WorkflowInteractivityButton() {
  const t = useTranslations("workflows");
  const store = useStoreApi();
  const interactive = useStore(
    (state) =>
      state.nodesDraggable ||
      state.nodesConnectable ||
      state.elementsSelectable,
  );
  const label = interactive ? t("lockSteps") : t("unlockSteps");
  const icon = "fill-none!";
  return (
    <ControlButton
      aria-label={label}
      onClick={() =>
        store.setState({
          elementsSelectable: !interactive,
          nodesConnectable: !interactive,
          nodesDraggable: !interactive,
        })
      }
      title={label}
    >
      {interactive ? (
        <MousePointer2Off className={icon} />
      ) : (
        <MousePointer2 className={icon} />
      )}
    </ControlButton>
  );
}

/**
 * Toggles the session-data chips the editor adds under each step card, so the
 * canvas can be read the way it renders everywhere else. Styled as one more
 * button in React Flow's control stack, and named for the action it performs.
 */
function WorkflowSessionDataButton({
  onToggle,
  shown,
}: {
  onToggle: () => void;
  shown: boolean;
}) {
  const t = useTranslations("workflows");
  const label = shown ? t("hideSessionData") : t("showSessionData");
  // React Flow fills any svg in a control button; Lucide draws in strokes.
  const icon = "fill-none!";
  return (
    <ControlButton aria-label={label} onClick={onToggle} title={label}>
      {shown ? <EyeOff className={icon} /> : <Eye className={icon} />}
    </ControlButton>
  );
}

function WorkflowEditorInner({ workflowId }: { workflowId?: string | null }) {
  const t = useTranslations("workflows");
  const labels = useWorkflowLabels();
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
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteView, setPaletteView] = useState<"palette" | "outline">(
    "palette",
  );
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<WorkflowDiagnostic[]>([]);
  const [overlapPolicy, setOverlapPolicy] = useState("QUEUE");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  // Off by default: laying a workflow out means panning and zooming around a
  // canvas bigger than the pane, which a fit lock would fight.
  const [locked, setLocked] = useState(false);
  const [showSessionData, setShowSessionData] = useState(false);

  const categories = useMemo(
    () =>
      new Map(
        catalog?.steps.map(({ kind, category }) => [kind, category]) ?? [],
      ),
    [catalog],
  );

  const availability = useMemo(
    () => computeWorkflowPathAvailability(definition, buildPathLookup(catalog)),
    [catalog, definition],
  );

  const rebuildGraph = useCallback(
    (nextDefinition: WorkflowDefinition, nextDiagnostics = diagnostics) => {
      const elements = workflowFlowElements(nextDefinition, {
        diagnostics: nextDiagnostics,
        categories,
        provides: providesByNodeMap(
          computeWorkflowPathAvailability(
            nextDefinition,
            buildPathLookup(catalog),
          ),
        ),
      });
      setNodes(elements.nodes);
      setEdges(elements.edges);
    },
    [catalog, categories, diagnostics, setEdges, setNodes],
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
          provides: providesByNodeMap(
            computeWorkflowPathAvailability(
              next,
              buildPathLookup(data.workflowCatalog),
            ),
          ),
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

  // Whole-definition path list, used as the value-picker fallback for triggers
  // and unreachable steps where per-step availability isn't meaningful.
  const allSessionPaths = useMemo(() => {
    const paths = new Set<string>();
    const triggerCatalog = new Map(
      catalog?.triggers.map((entry) => [entry.kind, entry]) ?? [],
    );
    for (const trigger of definition.triggers) {
      for (const path of triggerCatalog.get(trigger.kind)?.seedPaths ?? [])
        paths.add(path);
      for (const path of resourceManualSeedPaths(trigger.kind, trigger.config))
        paths.add(path);
    }
    for (const provided of availability.provides.values()) {
      for (const path of provided) paths.add(path);
    }
    return [...paths];
  }, [availability, catalog, definition]);

  // Concrete session-path suggestions for the value picker, scoped to what is
  // reachable before the selected step (falling back to the whole definition).
  const sessionPaths = useMemo<SessionFieldInfo[]>(() => {
    const before = selectedNode
      ? availability.availableBefore.get(selectedNode.id)
      : undefined;
    return expandSessionPaths(before ?? allSessionPaths);
  }, [availability, allSessionPaths, selectedNode]);

  // Concrete keys the selected node contributes to session data (step outputs
  // or trigger seeds), for the read-only "Adds to session data" inspector list.
  const sessionAdditions = useMemo<SessionFieldInfo[]>(() => {
    if (selectedNode)
      return displayProvidedPaths(selectedNode.id, availability.provides);
    if (selectedTrigger) {
      const seeds = [
        ...(catalog?.triggers.find(
          (entry) => entry.kind === selectedTrigger.kind,
        )?.seedPaths ?? []),
        // RESOURCE_MANUAL seeds depend on the resource kind chosen in config.
        ...resourceManualSeedPaths(
          selectedTrigger.kind,
          selectedTrigger.config,
        ),
      ];
      return expandSessionPaths(seeds);
    }
    return [];
  }, [availability, catalog, selectedNode, selectedTrigger]);

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

  const duplicateItem = useCallback(
    (id: string | null) => {
      const source = definition.nodes.find((node) => node.id === id);
      if (!source) return;
      const copy = {
        ...structuredClone(source),
        id: clientId("node"),
        name: `${source.name ?? source.kind} copy`,
        position: { x: source.position.x + 36, y: source.position.y + 36 },
      };
      commitDefinition({ ...definition, nodes: [...definition.nodes, copy] });
      setSelectedId(copy.id);
    },
    [commitDefinition, definition],
  );

  const duplicateSelected = useCallback(
    () => duplicateItem(selectedId),
    [duplicateItem, selectedId],
  );

  const duplicateCanvasSelection = useCallback(() => {
    const canvasSelection =
      instance?.getNodes().find(({ selected }) => selected)?.id ?? null;
    duplicateItem(canvasSelection ?? selectedId);
  }, [duplicateItem, instance, selectedId]);

  const nodeActions = useMemo<WorkflowNodeActions>(
    () => ({
      onDelete: (id) => removeItems([id]),
      onDuplicate: (id) => duplicateItem(id),
      onEdit: (id) => {
        setSelectedEdgeId(null);
        setSelectedId(id);
      },
    }),
    [duplicateItem, removeItems],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, [contenteditable=true]")) return;
        event.preventDefault();
        duplicateCanvasSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [duplicateCanvasSelection]);

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

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChange(changes);
      const removedIds = new Set(
        changes.flatMap((change) =>
          change.type === "remove" ? [change.id] : [],
        ),
      );
      if (removedIds.size === 0) return;
      setDefinition((current) => ({
        ...current,
        edges: current.edges.filter(({ id }) => !removedIds.has(id)),
      }));
      setSelectedEdgeId((current) =>
        current && removedIds.has(current) ? null : current,
      );
    },
    [onEdgesChange],
  );

  const removeEdges = useCallback(
    (ids: string[]) => {
      const removedIds = new Set(ids);
      setEdges((current) => current.filter(({ id }) => !removedIds.has(id)));
      setDefinition((current) => ({
        ...current,
        edges: current.edges.filter(({ id }) => !removedIds.has(id)),
      }));
      setSelectedEdgeId((current) =>
        current && removedIds.has(current) ? null : current,
      );
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
  const filteredTriggers = useMemo(
    () =>
      catalog?.triggers.filter((entry) =>
        `${entry.label} ${entry.kind} ${entry.category}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ) ?? [],
    [catalog, search],
  );
  // Adding or removing a step re-fits a locked canvas; moving one does not.
  // Hiding the session-data chips resizes every card, so it re-fits too.
  const fitSignature = useMemo(
    () =>
      `${definition.triggers.map(({ id }) => id).join()}|${definition.nodes
        .map(({ id }) => id)
        .join()}|${definition.edges.map(({ id }) => id).join()}|${
        definition.editor.handleLayout ?? "SIDES"
      }|${showSessionData}`,
    [definition, showSessionData],
  );
  // The chips are an editing aid layered onto the same card the run and detail
  // views render, so they are dropped on the way to the canvas rather than left
  // out of the graph — the definition and its rebuilds stay untouched.
  const canvasNodes = useMemo(
    () =>
      showSessionData
        ? nodes
        : nodes.map((node) =>
            node.data.provides.length
              ? { ...node, data: { ...node.data, provides: [] } }
              : node,
          ),
    [nodes, showSessionData],
  );
  const stepGroups = useMemo(
    () => [...groupByCategory(filteredSteps)],
    [filteredSteps],
  );
  const triggerGroups = useMemo(
    () => [...groupByCategory(filteredTriggers)],
    [filteredTriggers],
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-52" />
          <Skeleton className="h-4 w-96" />
        </div>
        <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <Skeleton className="h-[min(78vh,860px)] min-h-[520px]" />
          <Skeleton className="h-[min(78vh,860px)] min-h-[520px]" />
        </div>
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild size="icon" variant="ghost">
                <Link
                  href={workflow ? `/workflows/${workflow.id}` : "/workflows"}
                  aria-label={t("back")}
                >
                  <ArrowLeft />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("back")}</TooltipContent>
          </Tooltip>
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
          <Button onClick={() => setSettingsOpen(true)} variant="outline">
            <Settings /> {t("settings")}
          </Button>
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
        <Card
          className="flex h-[min(78vh,860px)] min-h-[520px] flex-col gap-0 py-0"
          size="sm"
        >
          <Tabs
            className="flex min-h-0 flex-1 gap-0"
            onValueChange={(value) =>
              setPaletteView(value as "palette" | "outline")
            }
            value={paletteView}
          >
            <div className="border-b p-2">
              <TabsList className="w-full">
                <TabsTrigger value="palette">{t("steps")}</TabsTrigger>
                <TabsTrigger value="outline">{t("outline")}</TabsTrigger>
              </TabsList>
            </div>
            <CardContent className="flex min-h-0 flex-1 flex-col p-2">
              <TabsContent
                className="flex min-h-0 flex-1 flex-col gap-2"
                value="palette"
              >
                <InputGroup>
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                  <InputGroupInput
                    aria-label={t("searchSteps")}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("searchSteps")}
                    value={search}
                  />
                </InputGroup>
                {stepGroups.length || triggerGroups.length ? (
                  <ScrollArea className="-mr-2 min-h-0 flex-1">
                    <div className="space-y-3 pr-2 pb-1">
                      {stepGroups.map(([category, entries]) => (
                        <section key={`step:${category}`}>
                          <div className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                            {category}
                          </div>
                          <ItemGroup className="gap-1">
                            {entries.map((entry) => (
                              <Item
                                asChild
                                className="gap-1.5 px-1.5 py-1"
                                key={entry.kind}
                                size="xs"
                                variant="outline"
                              >
                                <button
                                  className="cursor-grab text-left"
                                  draggable
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
                                  <ItemMedia>
                                    <GripVertical className="size-3.5 text-muted-foreground" />
                                  </ItemMedia>
                                  <ItemContent className="min-w-0">
                                    <ItemTitle className="text-xs">
                                      {entry.label}
                                    </ItemTitle>
                                    <ItemDescription className="text-[10px]">
                                      {entry.execution}
                                    </ItemDescription>
                                  </ItemContent>
                                  {(entry.mutatesExternal ||
                                    entry.mutatesWorktree) && (
                                    <ItemActions>
                                      <Badge
                                        className="text-[9px]"
                                        variant="outline"
                                      >
                                        {t("mutates")}
                                      </Badge>
                                    </ItemActions>
                                  )}
                                </button>
                              </Item>
                            ))}
                          </ItemGroup>
                        </section>
                      ))}
                      {triggerGroups.map(([category, entries]) => (
                        <section key={`trigger:${category}`}>
                          <div className="px-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                            {t("triggers")} · {category}
                          </div>
                          <ItemGroup className="gap-1">
                            {entries.map((entry) => (
                              <Item
                                asChild
                                className="gap-1.5 px-1.5 py-1"
                                key={entry.kind}
                                size="xs"
                                variant="outline"
                              >
                                <button
                                  className="text-left"
                                  onClick={() => addTrigger(entry)}
                                  type="button"
                                >
                                  <ItemMedia>
                                    <Plus className="size-3.5 text-muted-foreground" />
                                  </ItemMedia>
                                  <ItemContent className="min-w-0">
                                    <ItemTitle className="text-xs">
                                      {entry.label}
                                    </ItemTitle>
                                    <ItemDescription className="text-[10px]">
                                      {labels.kind(entry.kind)}
                                    </ItemDescription>
                                  </ItemContent>
                                </button>
                              </Item>
                            ))}
                          </ItemGroup>
                        </section>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <Empty className="py-10">
                    <EmptyHeader>
                      <EmptyTitle>{t("noOptions")}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                )}
              </TabsContent>
              <TabsContent className="min-h-0" value="outline">
                <ScrollArea className="-mr-2 h-full">
                  <ItemGroup className="gap-1 pr-2 pb-1">
                    {[...definition.triggers, ...definition.nodes].map(
                      (entry) => (
                        <Item
                          asChild
                          className="px-1.5 py-1"
                          key={entry.id}
                          size="xs"
                          variant={
                            entry.id === selectedId ? "muted" : "outline"
                          }
                        >
                          <button
                            aria-current={entry.id === selectedId}
                            onClick={() => setSelectedId(entry.id)}
                            type="button"
                          >
                            <ItemContent>
                              <ItemTitle>
                                {entry.name ?? labels.kind(entry.kind)}
                              </ItemTitle>
                              <ItemDescription>
                                {labels.kind(entry.kind)}
                              </ItemDescription>
                            </ItemContent>
                          </button>
                        </Item>
                      ),
                    )}
                  </ItemGroup>
                </ScrollArea>
              </TabsContent>
            </CardContent>
          </Tabs>
        </Card>

        <div className="min-w-0 space-y-3">
          <div
            className="relative h-[min(78vh,860px)] min-h-[520px] overflow-hidden rounded-xl border bg-muted/20"
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
            {selectedEdgeId && (
              <Button
                className="absolute top-3 right-3 z-10 shadow-md"
                onClick={() => removeEdges([selectedEdgeId])}
                size="sm"
                variant="destructive"
              >
                <Trash2 /> {t("deleteConnection")}
              </Button>
            )}
            <WorkflowNodeActionsContext value={nodeActions}>
              <ReactFlow
                className={locked ? workflowFitLockPaneClass : undefined}
                colorMode="system"
                deleteKeyCode={["Backspace", "Delete"]}
                edges={edges}
                fitView
                nodeTypes={workflowNodeTypes}
                nodes={canvasNodes}
                onConnect={onConnect}
                onEdgeClick={(_event, edge) => {
                  setSelectedId(null);
                  setSelectedEdgeId(edge.id);
                }}
                onEdgesChange={handleEdgesChange}
                onInit={(value) =>
                  setInstance(value as unknown as ReactFlowInstance<Node, Edge>)
                }
                onNodeClick={(event, node) => {
                  setSelectedEdgeId(null);
                  // A single click only picks the card up for dragging; opening
                  // the inspector takes a double click, so laying out a workflow
                  // does not keep throwing the panel over the canvas. Touch has
                  // no such distinction — a double tap is a poor target and the
                  // panel covers the canvas anyway — so a tap opens it there.
                  if (touchLike(event)) setSelectedId(node.id);
                }}
                onNodeDoubleClick={(_event, node) => {
                  setSelectedEdgeId(null);
                  setSelectedId(node.id);
                }}
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
                onPaneClick={() => setSelectedEdgeId(null)}
                panOnDrag={!locked}
                preventScrolling={!locked}
                proOptions={{ hideAttribution: true }}
                /* Double click belongs to the step inspector here. React Flow's
                 own double-click zoom sits on the pane and fires for clicks
                 that bubble up from a card, so it would zoom on every open. */
                zoomOnDoubleClick={false}
                zoomOnPinch={!locked}
                zoomOnScroll={!locked}
              >
                <Background gap={20} size={1} />
                <Controls
                  className="overflow-hidden rounded-lg"
                  showFitView={!locked}
                  showInteractive={false}
                  showZoom={!locked}
                >
                  <WorkflowFitLockButton
                    locked={locked}
                    onToggle={() => setLocked((current) => !current)}
                  />
                  <WorkflowInteractivityButton />
                  <WorkflowSessionDataButton
                    onToggle={() => setShowSessionData((current) => !current)}
                    shown={showSessionData}
                  />
                </Controls>
                <WorkflowFitLock locked={locked} signature={fitSignature} />
                {!locked && (
                  <MiniMap
                    className="overflow-hidden rounded-xl border"
                    maskColor="transparent"
                    nodeBorderRadius={MINIMAP_NODE_RADIUS}
                    pannable
                    zoomable
                  />
                )}
              </ReactFlow>
            </WorkflowNodeActionsContext>
          </div>
          {diagnostics.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{t("diagnostics")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ItemGroup className="gap-2">
                  {diagnostics.map((diagnostic, index) => (
                    <Item
                      asChild
                      key={`${diagnostic.code}-${index}`}
                      size="sm"
                      variant="outline"
                    >
                      <button
                        className="text-left"
                        onClick={() =>
                          setSelectedId(
                            diagnostic.nodeId ?? diagnostic.triggerId,
                          )
                        }
                        type="button"
                      >
                        <ItemContent>
                          <ItemTitle>{diagnostic.message}</ItemTitle>
                        </ItemContent>
                        <ItemActions>
                          <Badge
                            variant={
                              diagnostic.severity === "ERROR"
                                ? "destructive"
                                : "outline"
                            }
                          >
                            {labels.diagnosticCode(diagnostic.code)}
                          </Badge>
                        </ItemActions>
                      </button>
                    </Item>
                  ))}
                </ItemGroup>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workflowSettings")}</DialogTitle>
            <DialogDescription>{t("editorDescription")}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3">
            <Field>
              <FieldLabel htmlFor="workflow-name">{t("name")}</FieldLabel>
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
            </Field>
            <Field>
              <FieldLabel htmlFor="workflow-description">
                {t("description")}
              </FieldLabel>
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
            </Field>
            <Field>
              <FieldLabel htmlFor="workflow-overlap-policy">
                {t("overlapPolicy")}
              </FieldLabel>
              <Select onValueChange={setOverlapPolicy} value={overlapPolicy}>
                <SelectTrigger className="w-full" id="workflow-overlap-policy">
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
            </Field>
            <Field>
              <FieldLabel htmlFor="workflow-handle-layout">
                {t("connectorLayout")}
              </FieldLabel>
              <Select
                onValueChange={(value) =>
                  commitDefinition({
                    ...definition,
                    editor: {
                      ...definition.editor,
                      handleLayout: value as WorkflowHandleLayout,
                    },
                  })
                }
                value={definition.editor.handleLayout ?? "SIDES"}
              >
                <SelectTrigger className="w-full" id="workflow-handle-layout">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SIDES">
                    {t("connectorLayouts.SIDES")}
                  </SelectItem>
                  <SelectItem value="TOP_BOTTOM">
                    {t("connectorLayouts.TOP_BOTTOM")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="workflow-concurrency">
                {t("maxConcurrentRuns")}
              </FieldLabel>
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
            </Field>
            <Button
              className="w-full"
              onClick={() => void validate()}
              variant="outline"
            >
              {t("validate")}
            </Button>
          </FieldGroup>
        </DialogContent>
      </Dialog>

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
                <SheetTitle>
                  {selected.name ?? labels.kind(selected.kind)}
                </SheetTitle>
                <SheetDescription>
                  {labels.kind(selected.kind)}
                </SheetDescription>
              </SheetHeader>
              <FieldGroup className="gap-4 px-4">
                <Field>
                  <FieldLabel htmlFor="node-name">{t("name")}</FieldLabel>
                  <Input
                    id="node-name"
                    onChange={(event) =>
                      updateSelected({ name: event.target.value })
                    }
                    value={selected.name ?? ""}
                  />
                </Field>
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
                  <Field key={selected.id}>
                    <FieldTitle>{t("configuration")}</FieldTitle>
                    <RawConfigEditor
                      config={selected.config}
                      defaultOpen
                      onChange={(config) => updateSelected({ config })}
                    />
                  </Field>
                )}
                <Field>
                  <FieldTitle>
                    {selectedNode ? t("addsToSession") : t("seedsSession")}
                  </FieldTitle>
                  {sessionAdditions.length > 0 ? (
                    <ItemGroup className="gap-1 rounded-lg border bg-muted/30 p-2">
                      {sessionAdditions.map((info) => (
                        <Item className="px-1 py-0" key={info.path} size="xs">
                          <ItemContent>
                            <ItemTitle>
                              <code className="text-[11px]">{info.path}</code>
                            </ItemTitle>
                            {info.description && (
                              <ItemDescription className="text-[10px]">
                                {info.description}
                              </ItemDescription>
                            )}
                          </ItemContent>
                        </Item>
                      ))}
                    </ItemGroup>
                  ) : (
                    <Empty className="py-6">
                      <EmptyHeader>
                        <EmptyTitle>{t("addsToSessionEmpty")}</EmptyTitle>
                      </EmptyHeader>
                    </Empty>
                  )}
                </Field>
                {selectedNode && (
                  <>
                    <Field>
                      <FieldLabel htmlFor="required-paths">
                        {t("requiredPaths")}
                      </FieldLabel>
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
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="provided-paths">
                        {t("providedPaths")}
                      </FieldLabel>
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
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field>
                        <FieldLabel htmlFor="retry-count">
                          {t("maxAttempts")}
                        </FieldLabel>
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
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="failure-policy">
                          {t("failurePolicy")}
                        </FieldLabel>
                        <Select
                          onValueChange={(value) =>
                            updateSelected({
                              failurePolicy: value as "FAIL" | "CONTINUE",
                            })
                          }
                          value={selectedNode.failurePolicy}
                        >
                          <SelectTrigger className="w-full" id="failure-policy">
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
                      </Field>
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
              </FieldGroup>
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
