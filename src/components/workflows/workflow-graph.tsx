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
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Copy, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

import { WorkflowFitLock, WorkflowFitLockButton } from "./workflow-fit-lock";
import { workflowCategory, WorkflowCategoryIcon } from "./workflow-icons";
import { useWorkflowLabels } from "./workflow-labels";
import type {
  WorkflowAttempt,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowHandleLayout,
} from "./types";

type WorkflowNodeData = {
  label: string;
  kind: string;
  category: string;
  trigger: boolean;
  handleLayout: WorkflowHandleLayout;
  status: string | null;
  phase: string | null;
  attemptLabel: string | null;
  diagnostics: WorkflowDiagnostic[];
  provides: string[];
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

function sourceHandles(kind: string): Array<{ id: string; label: string }> {
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
  const handles = sourceHandles(data.kind);
  const vertical = data.handleLayout === "TOP_BOTTOM";
  const card = (
    <div
      className={cn(
        "relative min-w-52 rounded-xl border bg-card p-3 text-card-foreground shadow-sm",
        statusClass(data.status, data.diagnostics.length > 0),
        selected && "ring-2 ring-primary/35",
      )}
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
      {handles.map((handle, index) => (
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
          /* The two outcomes share one edge of the card, so they are spread
             along it — down the side, or across the bottom. */
          style={
            vertical
              ? { left: `${35 + index * 28}%` }
              : { top: `${35 + index * 28}%` }
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
        handleLayout,
        status: null,
        phase: null,
        attemptLabel: null,
        diagnostics: diagnostics.filter(
          ({ triggerId }) => triggerId === trigger.id,
        ),
        provides: options.provides?.get(trigger.id) ?? [],
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
          handleLayout,
          status: base?.status ?? null,
          phase: base?.phase ?? null,
          attemptLabel: labelParts.length ? labelParts.join(" · ") : null,
          diagnostics: diagnostics.filter(({ nodeId }) => nodeId === node.id),
          provides: options.provides?.get(node.id) ?? [],
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
  onNodeClick,
}: {
  definition: WorkflowDefinition;
  attempts?: WorkflowAttempt[];
  generation?: number;
  diagnostics?: WorkflowDiagnostic[];
  categories?: Map<string, string>;
  compact?: boolean;
  onNodeClick?: (nodeId: string) => void;
}) {
  const elements = useMemo(
    () =>
      workflowFlowElements(definition, {
        attempts,
        generation,
        diagnostics,
        categories,
      }),
    [attempts, categories, definition, diagnostics, generation],
  );
  // A read-only graph is there to be read, so it starts pinned to the pane:
  // no stray scroll wheel zooming it into a corner, nothing to fit back. The
  // control stack keeps one button to hand panning and zooming back.
  const [locked, setLocked] = useState(true);
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
        colorMode="system"
        edges={elements.edges}
        fitView
        maxZoom={1.5}
        minZoom={0.2}
        nodeTypes={workflowNodeTypes}
        nodes={elements.nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_event, node) => onNodeClick?.(node.id)}
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
