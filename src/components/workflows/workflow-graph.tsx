"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useStoreApi,
  type Dimensions,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { Copy, ExternalLink, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
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
import type {
  WorkflowAttempt,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowHandleLayout,
} from "./types";

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
  if (kind === "CONTROL_IF") {
    return [
      { id: "true", label: "true" },
      { id: "false", label: "false" },
    ];
  }
  if (kind === "CONTROL_FOR_EACH") {
    return [
      { id: "body", label: "body" },
      { id: "empty", label: "empty" },
    ];
  }
  if (kind === "CONTROL_TRY") {
    return [
      { id: "success", label: "success" },
      { id: "catch", label: "catch" },
    ];
  }
  return [
    { id: "success", label: "success" },
    { id: "failure", label: "failure" },
  ];
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
      {(data.status || data.attemptLabel) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {data.status && (
            <Badge
              className="text-[10px]"
              variant={workflowStatusVariant(data.status)}
            >
              {labels.status(data.status)}
            </Badge>
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
  const handleLayout = definition.editor.handleLayout ?? "SIDES";
  const nodes: WorkflowFlowNode[] = [
    ...definition.triggers.map((trigger) => ({
      id: trigger.id,
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
      const labelParts = [
        retryCount
          ? `${retryCount} retr${retryCount === 1 ? "y" : "ies"}`
          : null,
        iterationCount ? `${iterationCount} iterations` : null,
        base && options.generation && options.generation > 0
          ? `generation ${base.generation}`
          : null,
      ].filter(Boolean);
      return {
        id: node.id,
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
}: {
  definition: WorkflowDefinition;
  attempts?: WorkflowAttempt[];
  generation?: number;
  diagnostics?: WorkflowDiagnostic[];
  categories?: Map<string, string>;
  compact?: boolean;
  currentPageNodeIds?: ReadonlySet<string>;
  destinations?: ReadonlyMap<string, WorkflowResourceDestination>;
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
  const nodes = useMemo(
    () =>
      elements.nodes.map((node) => {
        const measured = sizes[node.id];
        return measured ? { ...node, measured } : node;
      }),
    [elements, sizes],
  );
  // A read-only graph is there to be read, so it starts pinned to the pane:
  // no stray scroll wheel zooming it into a corner, nothing to fit back. The
  // control stack keeps one button to hand panning and zooming back.
  const signature = useMemo(
    () =>
      `${elements.nodes.map(({ id }) => id).join()}|${elements.edges
        .map(({ id }) => id)
        .join()}|${definition.editor.handleLayout ?? "SIDES"}`,
    [definition, elements],
  );
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-muted/20",
        compact ? "h-72" : "h-[min(68vh,760px)] min-h-96",
      )}
    >
      <ReactFlow
        className={cn(locked && workflowFitLockPaneClass)}
        colorMode="system"
        edges={elements.edges}
        // Steps here are read, not picked: a click opens whatever the page
        // hangs off `onNodeClick`, which fires either way, and nothing acts on
        // a selection, so a card should not wear a selected ring.
        elementsSelectable={false}
        fitView
        maxZoom={1.5}
        minZoom={0.2}
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
        panOnDrag={!locked}
        panOnScroll={false}
        preventScrolling={!locked}
        proOptions={{ hideAttribution: true }}
        zoomOnDoubleClick={!locked}
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
        </Controls>
        <WorkflowFitLock locked={locked} signature={signature} />
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
