"use client";

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { GitFork, Play, RotateCcw } from "lucide-react";
import { useMemo } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type {
  WorkflowAttempt,
  WorkflowDefinition,
  WorkflowDiagnostic,
} from "./types";

type WorkflowNodeData = {
  label: string;
  kind: string;
  category: string;
  trigger: boolean;
  status: string | null;
  phase: string | null;
  attemptLabel: string | null;
  diagnostics: WorkflowDiagnostic[];
  provides: string[];
};

const MAX_PROVIDES_CHIPS = 3;

export type WorkflowFlowNode = Node<WorkflowNodeData, "workflow">;

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
  if (status === "SUCCEEDED") return "secondary" as const;
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

function WorkflowCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const handles = sourceHandles(data.kind);
  return (
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
          position={Position.Left}
          type="target"
        />
      )}
      <div className="flex items-start gap-2">
        <div className="mt-0.5 rounded-md bg-muted p-1.5">
          {data.trigger ? (
            <Play className="size-3.5" />
          ) : (
            <GitFork className="size-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{data.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {data.category} · {data.kind}
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
              {data.status}
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
          position={Position.Right}
          style={{ top: `${35 + index * 28}%` }}
          title={handle.label}
          type="source"
        />
      ))}
    </div>
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
  const nodes: WorkflowFlowNode[] = [
    ...definition.triggers.map((trigger) => ({
      id: trigger.id,
      type: "workflow" as const,
      position: trigger.position,
      data: {
        label: trigger.name ?? trigger.kind,
        kind: trigger.kind,
        category: "Trigger",
        trigger: true,
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
          category: options.categories?.get(node.kind) ?? "Step",
          trigger: false,
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
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
        {!compact && <MiniMap pannable zoomable />}
      </ReactFlow>
    </div>
  );
}

export function workflowRunComplete(attempts: WorkflowAttempt[]): boolean {
  return attempts.every(({ status }) => terminal.has(status));
}
