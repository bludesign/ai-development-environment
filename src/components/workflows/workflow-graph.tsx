"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  useStoreApi,
  type Dimensions,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import {
  Copy,
  ExternalLink,
  History,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import {
  isChoiceTriggerKind,
  workflowStaticSourceHandles,
  workflowTriggerChoices,
} from "@/lib/workflows/definition";
import type { WorkflowResourceDestination } from "@/lib/workflows/resources";

import {
  WorkflowFitLock,
  WorkflowFitLockButton,
  workflowFitLockPaneClass,
} from "./workflow-fit-lock";
import { workflowCategory, WorkflowCategoryIcon } from "./workflow-icons";
import { useWorkflowLabels } from "./workflow-labels";
import {
  WORKFLOW_REUSED_PHASE,
  type WorkflowAttempt,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowHandleLayout,
} from "./types";
import {
  basicLayoutTranslateExtent,
  basicWorkflowLayout,
} from "./basic-layout";

/** One source connector on a card, in the order it is laid out along the edge. */
type WorkflowSourceHandle = { id: string; label: string };

type WorkflowNodeData = {
  label: string;
  kind: string;
  category: string;
  trigger: boolean;
  handles: WorkflowSourceHandle[];
  handleLayout: WorkflowHandleLayout;
  status: string | null;
  phase: string | null;
  attemptLabel: string | null;
  /**
   * The step was carried over from an earlier generation rather than executed
   * in this one. A replay writes a row for every step of the graph, so without
   * this the whole graph claims the generation the replay created.
   */
  reused: boolean;
  diagnostics: WorkflowDiagnostic[];
  provides: string[];
  currentPage: boolean;
  destination: WorkflowResourceDestination | null;
  navigationEnabled: boolean;
};

const MAX_PROVIDES_CHIPS = 3;

/**
 * Corner radius of a step in the minimap. Measured in graph units rather than
 * pixels, so it is sized against the ~208-unit-wide cards it stands in for.
 */
export const MINIMAP_NODE_RADIUS = 12;

export type WorkflowFlowNode = Node<WorkflowNodeData, "workflow">;

/**
 * What a card's right-click menu can do to the step behind it. The read-only
 * graphs leave this unset, and their cards render without a menu.
 */
export type WorkflowNodeActions = {
  onDelete: (id: string) => void;
  /** Not offered on triggers, which the editor does not copy. */
  onDuplicate: (id: string) => void;
  onEdit: (id: string) => void;
};

export const WorkflowNodeActionsContext =
  createContext<WorkflowNodeActions | null>(null);

const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
  "SUPERSEDED",
]);

export function workflowStatusVariant(status: string) {
  if (status === "FAILED" || status === "BLOCKED")
    return "destructive" as const;
  if (status === "SUCCEEDED") return "success" as const;
  return "outline" as const;
}

function statusClass(status: string | null, diagnostic: boolean): string {
  if (diagnostic) return "border-destructive ring-2 ring-destructive/20";
  if (status === "FAILED" || status === "BLOCKED") return "border-destructive";
  if (status === "RUNNING") return "border-blue-500 ring-2 ring-blue-500/20";
  if (status === "WAITING") return "border-amber-500 ring-2 ring-amber-500/20";
  if (status === "SUCCEEDED") return "border-emerald-500/70";
  if (status === "SKIPPED" || status === "SUPERSEDED") return "opacity-55";
  return "border-border";
}

/**
 * The connectors a card offers, which depend on config as well as kind: a
 * choice trigger has one output per option it declares, so the graph reads
 * config rather than assuming the success/failure pair every other card has.
 */
export function workflowSourceHandles(
  kind: string,
  config: unknown = {},
): WorkflowSourceHandle[] {
  if (isChoiceTriggerKind(kind)) {
    return workflowTriggerChoices(config).map(({ key, label }) => ({
      id: key,
      label,
    }));
  }
  return workflowStaticSourceHandles(kind).map((id) => ({ id, label: id }));
}

function WorkflowCard({ data, id, selected }: NodeProps<WorkflowFlowNode>) {
  const labels = useWorkflowLabels();
  const t = useTranslations("workflows");
  const actions = useContext(WorkflowNodeActionsContext);
  const store = useStoreApi();
  const handles = data.handles;
  const vertical = data.handleLayout === "TOP_BOTTOM";
  // A choice trigger's outputs are user-named, so they are drawn as labelled
  // rows with the connector on each row rather than as anonymous dots. Only the
  // side layout can do that — a top/bottom card keeps its connectors on the
  // bottom edge, with the same labels listed above them in the same order.
  const choiceTrigger = data.trigger && isChoiceTriggerKind(data.kind);
  const inlineChoiceHandles = choiceTrigger && !vertical;
  const card = (
    <div
      className={cn(
        "relative min-w-52 rounded-xl border bg-card p-3 text-card-foreground shadow-sm",
        statusClass(data.status, data.diagnostics.length > 0),
        selected && "ring-2 ring-primary/35",
        data.currentPage &&
          "bg-primary/5 outline-2 outline-offset-2 outline-primary/70",
        data.navigationEnabled && data.destination && "cursor-pointer",
      )}
      title={
        data.navigationEnabled && data.destination
          ? t("openLinkedResource")
          : undefined
      }
    >
      {!data.trigger && (
        <Handle
          className="size-3! border-2! border-background! bg-muted-foreground!"
          id="input"
          position={vertical ? Position.Top : Position.Left}
          type="target"
        />
      )}
      <div className="flex items-start gap-2">
        <div className="mt-0.5 rounded-md bg-muted p-1.5">
          <WorkflowCategoryIcon
            category={data.category}
            className="size-3.5"
            trigger={data.trigger}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{data.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {data.category} · {labels.kind(data.kind)}
          </p>
        </div>
        {data.navigationEnabled && data.destination && (
          <span
            aria-hidden="true"
            className="rounded-md bg-primary/10 p-1 text-primary"
          >
            <ExternalLink className="size-3.5" />
          </span>
        )}
      </div>
      {(data.status || data.attemptLabel || data.reused) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {data.status && (
            <Badge
              className={cn("text-[10px]", data.reused && "opacity-60")}
              variant={workflowStatusVariant(data.status)}
            >
              {labels.status(data.status)}
            </Badge>
          )}
          {data.reused && (
            <span
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
              title={t("reusedStepDescription")}
            >
              <History className="size-3" /> {t("reusedStep")}
            </span>
          )}
          {data.attemptLabel && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <RotateCcw className="size-3" /> {data.attemptLabel}
            </span>
          )}
        </div>
      )}
      {data.diagnostics.length > 0 && (
        <p className="mt-2 max-w-56 text-[10px] leading-snug text-destructive">
          {data.diagnostics[0]!.message}
        </p>
      )}
      {data.provides.length > 0 && (
        <div className="mt-2 flex max-w-56 flex-wrap gap-1">
          {data.provides.slice(0, MAX_PROVIDES_CHIPS).map((path) => (
            <span
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
              key={path}
            >
              {path}
            </span>
          ))}
          {data.provides.length > MAX_PROVIDES_CHIPS && (
            <span className="px-1 py-0.5 text-[9px] text-muted-foreground">
              +{data.provides.length - MAX_PROVIDES_CHIPS}
            </span>
          )}
        </div>
      )}
      {choiceTrigger && (
        <div className="mt-2 space-y-1">
          {handles.map((handle) => (
            <div
              className="relative rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground"
              key={handle.id}
            >
              <span className="block truncate">{handle.label}</span>
              {inlineChoiceHandles && (
                <Handle
                  className="size-3! border-2! border-background! bg-primary!"
                  id={handle.id}
                  position={Position.Right}
                  /* The row sits inside the card's p-3, so pushing the
                     connector out by that padding lands it on the card edge
                     where every other card's connectors sit. */
                  style={{ right: -12 }}
                  title={handle.label}
                  type="source"
                />
              )}
            </div>
          ))}
        </div>
      )}
      {!inlineChoiceHandles &&
        handles.map((handle, index) => (
          <Handle
            className={cn(
              "size-3! border-2! border-background!",
              handle.id === "failure" || handle.id === "catch"
                ? "bg-destructive!"
                : "bg-primary!",
            )}
            id={handle.id}
            key={handle.id}
            position={vertical ? Position.Bottom : Position.Right}
            /* The outcomes share one edge of the card, so they are spread
               evenly along it — down the side, or across the bottom. */
            style={
              vertical
                ? { left: `${((index + 1) / (handles.length + 1)) * 100}%` }
                : { top: `${((index + 1) / (handles.length + 1)) * 100}%` }
            }
            title={handle.label}
            type="source"
          />
        ))}
    </div>
  );
  if (!actions) return card;
  return (
    // Right-clicking a card selects it the way left-clicking does — the menu
    // acts on this step, so it has to be the one wearing the ring. React Flow
    // only selects on a left click, so the open does it through the same store
    // call that click path uses.
    <ContextMenu
      onOpenChange={(open) => {
        if (open) store.getState().addSelectedNodes([id]);
      }}
    >
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.onEdit(id)}>
          <Pencil /> {t("edit")}
        </ContextMenuItem>
        {!data.trigger && (
          <ContextMenuItem onSelect={() => actions.onDuplicate(id)}>
            <Copy /> {t("duplicateNode")}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => actions.onDelete(id)}
          variant="destructive"
        >
          <Trash2 /> {t("deleteNode")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const workflowNodeTypes = { workflow: WorkflowCard };

export function workflowConstrainViewportAxis(
  position: number,
  viewportSize: number,
  zoom: number,
  extent: [number, number],
): number {
  const lower = viewportSize - extent[1] * zoom;
  const upper = -extent[0] * zoom;
  if (lower > upper) return (lower + upper) / 2;
  return Math.min(upper, Math.max(lower, position));
}

export function workflowBasicHorizontalWheelDelta(
  event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "shiftKey">,
  pageWidth: number,
): number | null {
  const horizontalIntent =
    event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (!horizontalIntent) return null;
  const rawDelta =
    event.shiftKey && Math.abs(event.deltaY) >= Math.abs(event.deltaX)
      ? event.deltaY
      : event.deltaX;
  const normalization =
    event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? pageWidth : 1;
  return rawDelta * normalization;
}

function WorkflowBasicHorizontalWheel({
  containerRef,
  enabled,
  extent,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  extent: [[number, number], [number, number]] | undefined;
}) {
  const { getViewport, setViewport } = useReactFlow<WorkflowFlowNode, Edge>();
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    const onWheel = (event: WheelEvent) => {
      const delta = workflowBasicHorizontalWheelDelta(
        event,
        container.clientWidth,
      );
      // A normal vertical wheel gesture belongs to the page. Only a native
      // horizontal gesture (or Shift+wheel) is captured for the graph.
      if (delta === null || delta === 0) return;
      event.preventDefault();
      const viewport = getViewport();
      const nextX = extent
        ? workflowConstrainViewportAxis(
            viewport.x - delta * 0.5,
            container.clientWidth,
            viewport.zoom,
            [extent[0][0], extent[1][0]],
          )
        : viewport.x - delta * 0.5;
      void setViewport({ ...viewport, x: nextX });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [containerRef, enabled, extent, getViewport, setViewport]);
  return null;
}

/**
 * Fits a derived layout without centering clipped overflow. Wide workflows
 * start at their first rank and pan to the right; narrow workflows start at
 * the top and let the page carry the vertical overflow.
 */
function WorkflowBasicViewport({
  direction,
  signature,
}: {
  direction: "HORIZONTAL" | "VERTICAL";
  signature: string;
}) {
  const { getNodes, getNodesBounds, setViewport } = useReactFlow<
    WorkflowFlowNode,
    Edge
  >();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const initialized = useStore((state) => state.nodesInitialized);
  useEffect(() => {
    if (!initialized || !width || !height) return;
    const bounds = getNodesBounds(getNodes());
    if (!bounds.width || !bounds.height) return;
    const padding = 24;
    const fit = Math.min(
      1,
      Math.max(0, width - padding * 2) / bounds.width,
      direction === "HORIZONTAL"
        ? Math.max(0, height - padding * 2) / bounds.height
        : 1,
    );
    const zoom = Math.max(0.8, fit);
    const x =
      direction === "HORIZONTAL"
        ? padding - bounds.x * zoom
        : (width - bounds.width * zoom) / 2 - bounds.x * zoom;
    const y =
      direction === "HORIZONTAL"
        ? (height - bounds.height * zoom) / 2 - bounds.y * zoom
        : padding - bounds.y * zoom;
    void setViewport({ x, y, zoom });
  }, [
    direction,
    getNodes,
    getNodesBounds,
    height,
    initialized,
    setViewport,
    signature,
    width,
  ]);
  return null;
}

function latestAttempts(attempts: WorkflowAttempt[], generation?: number) {
  const latest = new Map<string, WorkflowAttempt>();
  for (const attempt of attempts) {
    if (generation !== undefined && attempt.generation !== generation) continue;
    const key = `${attempt.nodeId}:${attempt.iterationKey}`;
    const current = latest.get(key);
    if (!current || current.attempt < attempt.attempt) latest.set(key, attempt);
  }
  return latest;
}

export function workflowFlowElements(
  definition: WorkflowDefinition,
  options: {
    attempts?: WorkflowAttempt[];
    generation?: number;
    diagnostics?: WorkflowDiagnostic[];
    categories?: Map<string, string>;
    provides?: Map<string, string[]>;
    currentPageNodeIds?: ReadonlySet<string>;
    destinations?: ReadonlyMap<string, WorkflowResourceDestination>;
    navigationEnabled?: boolean;
    handleLayout?: WorkflowHandleLayout;
    selectedNodeId?: string | null;
  } = {},
): { nodes: WorkflowFlowNode[]; edges: Edge[] } {
  const attempts = latestAttempts(options.attempts ?? [], options.generation);
  const iterations = new Map<string, WorkflowAttempt[]>();
  for (const attempt of attempts.values()) {
    const values = iterations.get(attempt.nodeId) ?? [];
    values.push(attempt);
    iterations.set(attempt.nodeId, values);
  }
  const diagnostics = options.diagnostics ?? [];
  const handleLayout =
    options.handleLayout ?? definition.editor.handleLayout ?? "SIDES";
  const nodes: WorkflowFlowNode[] = [
    ...definition.triggers.map((trigger) => ({
      id: trigger.id,
      selected: trigger.id === options.selectedNodeId,
      type: "workflow" as const,
      position: trigger.position,
      data: {
        label: trigger.name ?? trigger.kind,
        kind: trigger.kind,
        category: workflowCategory(trigger.kind, true),
        trigger: true,
        handles: workflowSourceHandles(trigger.kind, trigger.config),
        handleLayout,
        status: null,
        phase: null,
        attemptLabel: null,
        reused: false,
        diagnostics: diagnostics.filter(
          ({ triggerId }) => triggerId === trigger.id,
        ),
        provides: options.provides?.get(trigger.id) ?? [],
        currentPage: options.currentPageNodeIds?.has(trigger.id) ?? false,
        destination: options.destinations?.get(trigger.id) ?? null,
        navigationEnabled: options.navigationEnabled ?? false,
      },
    })),
    ...definition.nodes.map((node) => {
      const values = iterations.get(node.id) ?? [];
      const base =
        values.find(({ iterationKey }) => !iterationKey) ?? values.at(-1);
      const retryCount = base ? Math.max(0, base.attempt) : 0;
      const iterationCount = values.filter(
        ({ iterationKey }) => iterationKey,
      ).length;
      const reused = base?.phase === WORKFLOW_REUSED_PHASE;
      const labelParts = [
        retryCount
          ? `${retryCount} retr${retryCount === 1 ? "y" : "ies"}`
          : null,
        iterationCount ? `${iterationCount} iterations` : null,
        base && !reused && options.generation && options.generation > 0
          ? `Generation ${base.generation}`
          : null,
      ].filter(Boolean);
      return {
        id: node.id,
        selected: node.id === options.selectedNodeId,
        type: "workflow" as const,
        position: node.position,
        data: {
          label: node.name ?? node.kind,
          kind: node.kind,
          category:
            options.categories?.get(node.kind) ??
            workflowCategory(node.kind, false),
          trigger: false,
          handles: workflowSourceHandles(node.kind, node.config),
          handleLayout,
          status: base?.status ?? null,
          phase: base?.phase ?? null,
          attemptLabel: labelParts.length ? labelParts.join(" · ") : null,
          reused,
          diagnostics: diagnostics.filter(({ nodeId }) => nodeId === node.id),
          provides: options.provides?.get(node.id) ?? [],
          currentPage: options.currentPageNodeIds?.has(node.id) ?? false,
          destination: options.destinations?.get(node.id) ?? null,
          navigationEnabled: options.navigationEnabled ?? false,
        },
      };
    }),
  ];
  const edges: Edge[] = definition.edges.map((edge) => {
    const sourceAttempt = attempts.get(`${edge.source}:`);
    const inactive = sourceAttempt?.status === "SKIPPED";
    const failed = sourceAttempt?.status === "FAILED";
    return {
      ...edge,
      animated:
        sourceAttempt?.status === "RUNNING" ||
        sourceAttempt?.status === "WAITING",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        opacity: inactive ? 0.3 : 1,
        stroke: failed ? "var(--destructive)" : undefined,
      },
    };
  });
  return { nodes, edges };
}

export function WorkflowGraph({
  definition,
  attempts = [],
  generation,
  diagnostics = [],
  categories,
  compact = false,
  currentPageNodeIds,
  destinations,
  onNodeClick,
  selectedNodeId,
}: {
  definition: WorkflowDefinition;
  attempts?: WorkflowAttempt[];
  generation?: number;
  diagnostics?: WorkflowDiagnostic[];
  categories?: Map<string, string>;
  compact?: boolean;
  currentPageNodeIds?: ReadonlySet<string>;
  destinations?: ReadonlyMap<string, WorkflowResourceDestination>;
  selectedNodeId?: string | null;
  onNodeClick?: (
    nodeId: string,
    details: {
      destination: WorkflowResourceDestination | null;
      locked: boolean;
      trigger: boolean;
    },
  ) => void;
}) {
  // Locked graphs use their nodes as detail links. Once unlocked, node clicks
  // are handed back to the page for interactions such as replay selection.
  const [locked, setLocked] = useState(true);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const measure = () => setPaneWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const basic = (definition.editor.displayLayout ?? "REGULAR") === "BASIC";
  const basicDirection =
    paneWidth > 0 && paneWidth < 640 ? "VERTICAL" : "HORIZONTAL";
  const projectedHandleLayout: WorkflowHandleLayout =
    basic && basicDirection === "VERTICAL" ? "TOP_BOTTOM" : "SIDES";
  const elements = useMemo(
    () =>
      workflowFlowElements(definition, {
        attempts,
        generation,
        diagnostics,
        categories,
        currentPageNodeIds,
        destinations,
        navigationEnabled: locked,
        handleLayout: basic ? projectedHandleLayout : undefined,
        selectedNodeId,
      }),
    [
      attempts,
      categories,
      currentPageNodeIds,
      definition,
      destinations,
      diagnostics,
      generation,
      locked,
      basic,
      projectedHandleLayout,
      selectedNodeId,
    ],
  );
  // React Flow measures each card in the DOM and reports the size back through
  // `onNodesChange`. A graph that hands it a `nodes` array and drops those
  // changes never gets the sizes into that array, and everything reading it
  // rather than React Flow's internal copy — the minimap, the check for whether
  // the graph is ready to be fitted — sees a graph of zero-sized steps. The
  // editor keeps its whole array in state for editing; a read-only graph only
  // needs the measurements back, so it holds those and stays a plain function
  // of the definition it was handed.
  const [sizes, setSizes] = useState<Record<string, Dimensions>>({});
  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      setSizes((current) => {
        let next = current;
        for (const change of changes) {
          if (change.type !== "dimensions" || !change.dimensions) continue;
          const previous = current[change.id];
          if (
            previous?.width === change.dimensions.width &&
            previous.height === change.dimensions.height
          )
            continue;
          // Re-measuring settles within a frame or two of mounting, so a fresh
          // object here would restart the render it came from over and over.
          next = next === current ? { ...current } : next;
          next[change.id] = change.dimensions;
        }
        return next;
      });
    },
    [],
  );
  const basicLayout = useMemo(
    () =>
      basic
        ? basicWorkflowLayout(
            elements.nodes.map((node) => ({
              id: node.id,
              position: node.position,
              width: sizes[node.id]?.width,
              height: sizes[node.id]?.height,
            })),
            elements.edges,
            basicDirection,
          )
        : null,
    [basic, basicDirection, elements, sizes],
  );
  const nodes = useMemo(
    () =>
      elements.nodes.map((node) => {
        const measured = sizes[node.id];
        const position = basicLayout?.positions.get(node.id);
        return {
          ...node,
          ...(measured ? { measured } : {}),
          ...(position ? { position } : {}),
        };
      }),
    [basicLayout, elements.nodes, sizes],
  );
  const edges = useMemo(
    () =>
      basic
        ? elements.edges.map((edge) => ({ ...edge, type: "smoothstep" }))
        : elements.edges,
    [basic, elements.edges],
  );
  const basicScale = basicLayout
    ? Math.max(
        0.8,
        Math.min(
          1,
          (Math.max(0, paneWidth - 48) || basicLayout.bounds.width) /
            Math.max(1, basicLayout.bounds.width),
        ),
      )
    : 1;
  const basicVerticalHeight = basicLayout
    ? Math.ceil(basicLayout.bounds.height * basicScale + 48)
    : 0;
  const fitViewOptions = useMemo(
    () => (basic ? { padding: 0.08, minZoom: 0.8, maxZoom: 1 } : undefined),
    [basic],
  );
  const basicTranslateExtent = useMemo(
    () =>
      basicLayout ? basicLayoutTranslateExtent(basicLayout.bounds) : undefined,
    [basicLayout],
  );
  // A read-only graph is there to be read, so it starts pinned to the pane:
  // no stray scroll wheel zooming it into a corner, nothing to fit back. The
  // control stack keeps one button to hand panning and zooming back.
  const signature = useMemo(
    () =>
      `${nodes
        .map(
          ({ id, measured }) =>
            `${id}:${measured?.width ?? 0}x${measured?.height ?? 0}`,
        )
        .join()}|${edges
        .map(({ id }) => id)
        .join()}|${projectedHandleLayout}|${basicDirection}`,
    [basicDirection, edges, nodes, projectedHandleLayout],
  );
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-muted/20",
        compact ? "h-72" : "h-[min(68vh,760px)] min-h-96",
        basic && basicDirection === "VERTICAL" && "h-auto min-h-0",
      )}
      ref={wrapperRef}
      style={
        basic && basicDirection === "VERTICAL"
          ? { height: Math.max(compact ? 288 : 384, basicVerticalHeight) }
          : undefined
      }
    >
      <ReactFlow
        className={cn(locked && workflowFitLockPaneClass)}
        colorMode="system"
        edges={edges}
        // Steps here are read, not picked: a click opens whatever the page
        // hangs off `onNodeClick`, which fires either way, and nothing acts on
        // a selection, so a card should not wear a selected ring.
        elementsSelectable={false}
        fitView
        fitViewOptions={fitViewOptions}
        maxZoom={1.5}
        minZoom={basic ? 0.8 : 0.2}
        nodeTypes={workflowNodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_event, node) =>
          onNodeClick?.(node.id, {
            destination: node.data.destination,
            locked,
            trigger: node.data.trigger,
          })
        }
        onNodesChange={onNodesChange}
        panOnDrag={!locked || (basic && basicDirection === "HORIZONTAL")}
        panOnScroll={false}
        preventScrolling={!locked && !basic}
        proOptions={{ hideAttribution: true }}
        translateExtent={basicTranslateExtent}
        zoomOnDoubleClick={!locked}
        zoomOnPinch={!locked}
        zoomOnScroll={!locked && !basic}
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
        </Controls>
        {basic ? (
          <>
            <WorkflowBasicHorizontalWheel
              containerRef={wrapperRef}
              enabled={basicDirection === "HORIZONTAL"}
              extent={basicTranslateExtent}
            />
            <WorkflowBasicViewport
              direction={basicDirection}
              signature={signature}
            />
          </>
        ) : (
          <WorkflowFitLock locked={locked} signature={signature} />
        )}
        {!compact && !locked && (
          <MiniMap
            className="overflow-hidden rounded-xl border"
            /* The mask dims everything outside the viewport, which reads as a
               heavy border once the viewport covers most of the graph. The
               card-weight border below takes its place as the frame. */
            maskColor="transparent"
            nodeBorderRadius={MINIMAP_NODE_RADIUS}
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
}

export function workflowRunComplete(attempts: WorkflowAttempt[]): boolean {
  return attempts.every(({ status }) => terminal.has(status));
}
