/**
 * Structural edits to a workflow definition, expressed as pure functions.
 *
 * The editor mutates the graph through React state; the MCP tools have no such
 * state, so they load the draft, apply one of these, and save it back. Keeping
 * the operations here means both paths agree on what "add a step and wire it up"
 * means, and the rules an agent would otherwise have to infer — an explicit join
 * for a second incoming edge, a choice trigger's handles coming from its config
 * — are enforced in one place.
 *
 * Every function returns a new definition; none mutates its argument. None of
 * them validate the result: callers run `validateWorkflowDefinition` and report
 * the diagnostics, so an intermediate state that is briefly invalid (a step
 * added before it is connected) is allowed.
 */

import {
  workflowTriggerChoices,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
  type WorkflowTriggerDefinition,
} from "./definition";
import { isChoiceTriggerKind, workflowStaticSourceHandles } from "./kinds";

/** Horizontal gap between layout columns, matched to the editor's own spacing. */
const COLUMN_WIDTH = 320;
/** Vertical gap between cards sharing a column. */
const ROW_HEIGHT = 160;

export type GraphPosition = { x: number; y: number };

/**
 * Where a new step attaches. `sourceHandle` defaults to the source's first
 * handle — `success` for an ordinary step, which is what a caller almost always
 * means — except on a choice trigger, where there is no sensible default.
 */
export type ConnectFrom = {
  from: string;
  sourceHandle?: string | null;
};

function uniqueId(definition: WorkflowDefinition, prefix: string): string {
  const taken = new Set([
    ...definition.nodes.map(({ id }) => id),
    ...definition.triggers.map(({ id }) => id),
  ]);
  for (let index = 1; ; index += 1) {
    const candidate = `${prefix}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function uniqueEdgeId(definition: WorkflowDefinition): string {
  const taken = new Set(definition.edges.map(({ id }) => id));
  for (let index = 1; ; index += 1) {
    const candidate = `edge-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function graphItem(
  definition: WorkflowDefinition,
  id: string,
): WorkflowNodeDefinition | WorkflowTriggerDefinition | undefined {
  return (
    definition.nodes.find((node) => node.id === id) ??
    definition.triggers.find((trigger) => trigger.id === id)
  );
}

/**
 * The handles an item actually offers. Choice triggers derive theirs from the
 * options in their config, so this reads config rather than assuming the static
 * table covers every kind.
 */
export function availableSourceHandles(item: {
  kind: string;
  config?: unknown;
}): string[] {
  return isChoiceTriggerKind(item.kind)
    ? workflowTriggerChoices(item.config).map(({ key }) => key)
    : workflowStaticSourceHandles(item.kind);
}

/** A free position to the right of `from`, clear of anything already there. */
function positionAfter(
  definition: WorkflowDefinition,
  from: string | null,
): GraphPosition {
  const source = from ? graphItem(definition, from) : undefined;
  const x = source ? source.position.x + COLUMN_WIDTH : COLUMN_WIDTH;
  const baseY = source ? source.position.y : 120;
  const occupied = [...definition.nodes, ...definition.triggers]
    .filter((item) => Math.abs(item.position.x - x) < COLUMN_WIDTH / 2)
    .map((item) => item.position.y);
  let y = baseY;
  while (occupied.some((taken) => Math.abs(taken - y) < ROW_HEIGHT / 2)) {
    y += ROW_HEIGHT;
  }
  return { x, y };
}

export type AddStepInput = {
  kind: WorkflowNodeDefinition["kind"];
  name?: string | null;
  config?: Record<string, unknown> | null;
  position?: GraphPosition | null;
  connectFrom?: ConnectFrom | null;
  retry?: WorkflowNodeDefinition["retry"] | null;
  failurePolicy?: WorkflowNodeDefinition["failurePolicy"] | null;
  requiredPaths?: string[] | null;
  providedPaths?: string[] | null;
};

export function addWorkflowStep(
  definition: WorkflowDefinition,
  input: AddStepInput,
): { definition: WorkflowDefinition; nodeId: string; edgeId: string | null } {
  const nodeId = uniqueId(definition, "node");
  const node: WorkflowNodeDefinition = {
    id: nodeId,
    kind: input.kind,
    name: input.name ?? undefined,
    position:
      input.position ??
      positionAfter(definition, input.connectFrom?.from ?? null),
    config: input.config ?? {},
    requiredPaths: input.requiredPaths ?? [],
    providedPaths: input.providedPaths ?? [],
    retry: input.retry ?? {
      maxAttempts: 1,
      strategy: "EXPONENTIAL",
      delaySeconds: 5,
    },
    failurePolicy: input.failurePolicy ?? "FAIL",
  };
  const added: WorkflowDefinition = {
    ...definition,
    nodes: [...definition.nodes, node],
  };
  if (!input.connectFrom) return { definition: added, nodeId, edgeId: null };
  const connected = connectWorkflowNodes(added, {
    source: input.connectFrom.from,
    target: nodeId,
    sourceHandle: input.connectFrom.sourceHandle ?? null,
  });
  return {
    definition: connected.definition,
    nodeId,
    edgeId: connected.edgeId,
  };
}

export type UpdateStepInput = {
  nodeId: string;
  name?: string | null;
  /** Replaces the whole config. Mutually exclusive with `configPatch`. */
  config?: Record<string, unknown> | null;
  /** Merges into the existing config; a `null` value deletes that key. */
  configPatch?: Record<string, unknown> | null;
  position?: GraphPosition | null;
  retry?: WorkflowNodeDefinition["retry"] | null;
  failurePolicy?: WorkflowNodeDefinition["failurePolicy"] | null;
  requiredPaths?: string[] | null;
  providedPaths?: string[] | null;
};

/**
 * Applies a config replacement or patch. Patching is the safer default for an
 * agent editing one key of a step it did not author, since a replacement
 * silently drops everything it forgot to include.
 */
function nextConfig(
  current: Record<string, unknown>,
  input: {
    config?: Record<string, unknown> | null;
    configPatch?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  if (input.config) return input.config;
  if (!input.configPatch) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(input.configPatch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

export function updateWorkflowStep(
  definition: WorkflowDefinition,
  input: UpdateStepInput,
): WorkflowDefinition {
  if (!definition.nodes.some(({ id }) => id === input.nodeId)) {
    throw new Error(`Step ${input.nodeId} is not in this workflow`);
  }
  if (input.config && input.configPatch) {
    throw new Error("Pass either config or configPatch, not both");
  }
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.id === input.nodeId
        ? {
            ...node,
            name: input.name ?? node.name,
            config: nextConfig(node.config, input),
            position: input.position ?? node.position,
            retry: input.retry ?? node.retry,
            failurePolicy: input.failurePolicy ?? node.failurePolicy,
            requiredPaths: input.requiredPaths ?? node.requiredPaths,
            providedPaths: input.providedPaths ?? node.providedPaths,
          }
        : node,
    ),
  };
}

export type AddTriggerInput = {
  kind: WorkflowTriggerDefinition["kind"];
  name?: string | null;
  config?: Record<string, unknown> | null;
  position?: GraphPosition | null;
};

export function addWorkflowTrigger(
  definition: WorkflowDefinition,
  input: AddTriggerInput,
): { definition: WorkflowDefinition; triggerId: string } {
  const triggerId = uniqueId(definition, "trigger");
  const trigger: WorkflowTriggerDefinition = {
    id: triggerId,
    kind: input.kind,
    name: input.name ?? undefined,
    config: input.config ?? {},
    position: input.position ?? {
      x: 0,
      y: 100 + definition.triggers.length * 140,
    },
  };
  return {
    definition: { ...definition, triggers: [...definition.triggers, trigger] },
    triggerId,
  };
}

export type UpdateTriggerInput = {
  triggerId: string;
  name?: string | null;
  config?: Record<string, unknown> | null;
  configPatch?: Record<string, unknown> | null;
  position?: GraphPosition | null;
};

export function updateWorkflowTrigger(
  definition: WorkflowDefinition,
  input: UpdateTriggerInput,
): WorkflowDefinition {
  const existing = definition.triggers.find(({ id }) => id === input.triggerId);
  if (!existing) {
    throw new Error(`Trigger ${input.triggerId} is not in this workflow`);
  }
  if (input.config && input.configPatch) {
    throw new Error("Pass either config or configPatch, not both");
  }
  const updated: WorkflowTriggerDefinition = {
    ...existing,
    name: input.name ?? existing.name,
    config: nextConfig(existing.config, input),
    position: input.position ?? existing.position,
  };
  // Dropping an option from a choice trigger orphans the edges that left its
  // handle, and those fail validation with TRIGGER_CHOICE_HANDLE_UNKNOWN. Remove
  // them here so editing the options list does not leave the graph unpublishable.
  const live = new Set(availableSourceHandles(updated));
  const edges = isChoiceTriggerKind(updated.kind)
    ? definition.edges.filter(
        (edge) => edge.source !== updated.id || live.has(edge.sourceHandle),
      )
    : definition.edges;
  return {
    ...definition,
    triggers: definition.triggers.map((trigger) =>
      trigger.id === updated.id ? updated : trigger,
    ),
    edges,
  };
}

/**
 * Removes a step or trigger and every edge touching it. `reconnect` stitches
 * each predecessor to each successor first, so pulling a step out of the middle
 * of a chain leaves the chain intact instead of severing it.
 */
export function removeWorkflowGraphNode(
  definition: WorkflowDefinition,
  id: string,
  options: { reconnect?: boolean } = {},
): WorkflowDefinition {
  if (!graphItem(definition, id)) {
    throw new Error(`${id} is not in this workflow`);
  }
  const incoming = definition.edges.filter((edge) => edge.target === id);
  const outgoing = definition.edges.filter((edge) => edge.source === id);
  const kept = definition.edges.filter(
    (edge) => edge.source !== id && edge.target !== id,
  );
  let next: WorkflowDefinition = {
    ...definition,
    nodes: definition.nodes.filter((node) => node.id !== id),
    triggers: definition.triggers.filter((trigger) => trigger.id !== id),
    edges: kept,
  };
  if (!options.reconnect) return next;
  for (const before of incoming) {
    for (const after of outgoing) {
      next = connectWorkflowNodes(next, {
        source: before.source,
        // The incoming edge's handle is what the predecessor branched on, so it
        // is the one to preserve; the removed step's own handle is meaningless
        // now that the step is gone.
        sourceHandle: before.sourceHandle,
        target: after.target,
        targetHandle: after.targetHandle,
      }).definition;
    }
  }
  return next;
}

export type ConnectInput = {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export function connectWorkflowNodes(
  definition: WorkflowDefinition,
  input: ConnectInput,
): { definition: WorkflowDefinition; edgeId: string } {
  const source = graphItem(definition, input.source);
  if (!source) throw new Error(`${input.source} is not in this workflow`);
  if (!definition.nodes.some(({ id }) => id === input.target)) {
    throw new Error(
      `${input.target} is not a step — triggers cannot have incoming connections`,
    );
  }
  const handles = availableSourceHandles(source);
  const sourceHandle = input.sourceHandle ?? handles[0];
  if (!sourceHandle) {
    throw new Error(
      `${input.source} offers no connectors yet — a choice trigger needs its options set first`,
    );
  }
  if (!handles.includes(sourceHandle)) {
    throw new Error(
      `${input.source} has no ${sourceHandle} connector; it offers ${handles.join(", ")}`,
    );
  }
  const targetHandle = input.targetHandle ?? "input";
  const existing = definition.edges.find(
    (edge) =>
      edge.source === input.source &&
      edge.target === input.target &&
      edge.sourceHandle === sourceHandle,
  );
  if (existing) return { definition, edgeId: existing.id };
  const edgeId = uniqueEdgeId(definition);
  return {
    definition: {
      ...definition,
      edges: [
        ...definition.edges,
        {
          id: edgeId,
          source: input.source,
          target: input.target,
          sourceHandle,
          targetHandle,
        },
      ],
    },
    edgeId,
  };
}

export type DisconnectInput = {
  edgeId?: string | null;
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
};

export function disconnectWorkflowNodes(
  definition: WorkflowDefinition,
  input: DisconnectInput,
): { definition: WorkflowDefinition; removedEdgeIds: string[] } {
  const matches = definition.edges.filter((edge) => {
    if (input.edgeId) return edge.id === input.edgeId;
    if (!input.source && !input.target) return false;
    if (input.source && edge.source !== input.source) return false;
    if (input.target && edge.target !== input.target) return false;
    if (input.sourceHandle && edge.sourceHandle !== input.sourceHandle)
      return false;
    return true;
  });
  if (!matches.length) throw new Error("No matching connection to remove");
  const removed = new Set(matches.map(({ id }) => id));
  return {
    definition: {
      ...definition,
      edges: definition.edges.filter((edge) => !removed.has(edge.id)),
    },
    removedEdgeIds: [...removed],
  };
}

/**
 * Assigns readable positions to every trigger and step: triggers on the left,
 * each step one column right of its furthest-left predecessor, siblings stacked.
 *
 * Positions are pure presentation — the runtime never reads them — but a graph
 * authored over MCP has none, and every card landing on the same coordinates
 * makes the editor look broken. Anything unreachable from a trigger is parked in
 * a column of its own rather than dropped.
 */
export function layoutWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const successors = new Map<string, string[]>();
  for (const edge of definition.edges) {
    successors.set(edge.source, [
      ...(successors.get(edge.source) ?? []),
      edge.target,
    ]);
  }

  const column = new Map<string, number>();
  for (const trigger of definition.triggers) column.set(trigger.id, 0);
  // Longest-path layering: revisiting a node that gains a deeper predecessor
  // pushes it (and its successors) right. Bounded by node count, so a cycle —
  // which the validator rejects anyway — cannot spin here.
  const pending = definition.triggers.map(({ id }) => id);
  let guard = definition.nodes.length * definition.edges.length + 1;
  while (pending.length && guard-- > 0) {
    const id = pending.shift()!;
    const depth = column.get(id) ?? 0;
    for (const target of successors.get(id) ?? []) {
      if ((column.get(target) ?? -1) >= depth + 1) continue;
      column.set(target, depth + 1);
      pending.push(target);
    }
  }

  // Unreached steps still need somewhere to sit; put them past everything else.
  const deepest = Math.max(0, ...column.values());
  for (const node of definition.nodes) {
    if (!column.has(node.id)) column.set(node.id, deepest + 1);
  }

  const rows = new Map<number, number>();
  const place = <T extends { id: string; position: GraphPosition }>(
    item: T,
  ): T => {
    const index = column.get(item.id) ?? 0;
    const row = rows.get(index) ?? 0;
    rows.set(index, row + 1);
    return {
      ...item,
      position: { x: index * COLUMN_WIDTH, y: row * ROW_HEIGHT },
    };
  };
  // Triggers first so column 0 stacks them before any step that landed there.
  const triggers = definition.triggers.map(place);
  const nodes = definition.nodes.map(place);
  return { ...definition, triggers, nodes };
}
