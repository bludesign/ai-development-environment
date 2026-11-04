import {
  WORKFLOW_STEP_CATALOG,
  WORKFLOW_TRIGGER_CATALOG,
  workflowConnectionSummary,
} from "@/lib/workflows/definition";

import type {
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowEdgeDefinition,
} from "./types";

type DiagnosticInput = Pick<
  WorkflowDiagnostic,
  "severity" | "code" | "message"
> & {
  nodeId?: string | null;
  triggerId?: string | null;
  edgeId?: string | null;
  path?: string | null;
};

/** Presentation changes do not invalidate a check of the authored workflow. */
export function workflowSemanticKey(definition: WorkflowDefinition): string {
  const { editor: _editor, nodes, triggers, ...content } = definition;
  const semantic = {
    ...content,
    nodes: nodes.map(({ position: _position, ...node }) => node),
    triggers: triggers.map(({ position: _position, ...trigger }) => trigger),
  };
  return JSON.stringify(semantic, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

export function normalizeWorkflowDiagnostics(
  diagnostics: readonly DiagnosticInput[],
): WorkflowDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: diagnostic.message,
    nodeId: diagnostic.nodeId ?? null,
    triggerId: diagnostic.triggerId ?? null,
    edgeId: diagnostic.edgeId ?? null,
    path: diagnostic.path ?? null,
  }));
}

export function mergeWorkflowDiagnostics(
  ...groups: readonly (readonly DiagnosticInput[])[]
): WorkflowDiagnostic[] {
  const seen = new Set<string>();
  return normalizeWorkflowDiagnostics(groups.flat()).filter((diagnostic) => {
    const key = JSON.stringify(diagnostic);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type WorkflowDiagnosticTarget = {
  label: string;
  nodeIds: string[];
  edgeId: string | null;
  inspectorId: string | null;
};

const labels = new Map<string, string>(
  [...WORKFLOW_STEP_CATALOG, ...WORKFLOW_TRIGGER_CATALOG].map((entry) => [
    entry.kind,
    entry.label,
  ]),
);

function cardLabel(card: { id: string; kind: string; name?: string }): string {
  return card.name?.trim() || labels.get(card.kind) || card.id;
}

/** Resolve indexed schema locations before IDs, which may themselves be invalid. */
export function workflowDiagnosticTarget(
  definition: WorkflowDefinition,
  diagnostic: DiagnosticInput,
): WorkflowDiagnosticTarget {
  const cards = [...definition.triggers, ...definition.nodes];
  const cardIds = new Set(cards.map(({ id }) => id));
  const indexed = /^(nodes|triggers|edges)\.(\d+)(?:\.|$)/.exec(
    diagnostic.path ?? "",
  );
  const edgeTarget = (
    edge: WorkflowEdgeDefinition,
  ): WorkflowDiagnosticTarget => {
    const matching = definition.edges.filter(({ id }) => id === edge.id);
    const related = matching.length > 1 ? matching : [edge];
    const nodeIds = [
      ...new Set(
        related
          .flatMap(({ source, target }) => [source, target])
          .filter((id) => cardIds.has(id)),
      ),
    ];
    return {
      label: workflowConnectionSummary(definition, edge),
      nodeIds,
      // A broken endpoint can prevent drawing the edge, but its unique ID
      // still lets the editor select its summary and offer a repair/delete.
      edgeId: matching.length === 1 ? edge.id : null,
      inspectorId: null,
    };
  };
  if (indexed) {
    const index = Number(indexed[2]);
    if (indexed[1] === "edges") {
      const edge = definition.edges[index];
      if (edge) return edgeTarget(edge);
    } else {
      const card = definition[indexed[1] as "nodes" | "triggers"][index];
      if (card)
        return {
          label: cardLabel(card),
          nodeIds: [card.id],
          edgeId: null,
          inspectorId: card.id,
        };
    }
  }
  const edge = diagnostic.edgeId
    ? definition.edges.find(({ id }) => id === diagnostic.edgeId)
    : undefined;
  if (edge) return edgeTarget(edge);
  // A requirement can mention the originating trigger as well as the failing
  // step. Its primary navigation target is the step that needs repair.
  const card =
    definition.nodes.find(({ id }) => id === diagnostic.nodeId) ??
    cards.find(({ id }) => id === diagnostic.nodeId) ??
    definition.triggers.find(({ id }) => id === diagnostic.triggerId);
  return card
    ? {
        label: cardLabel(card),
        nodeIds: [card.id],
        edgeId: null,
        inspectorId: card.id,
      }
    : { label: "Workflow", nodeIds: [], edgeId: null, inspectorId: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** Keep malformed imports out of code that assumes a drawable graph. */
export function workflowRenderableDefinition(
  value: unknown,
): value is WorkflowDefinition {
  if (
    !isRecord(value) ||
    value.format !== "aide.workflow" ||
    value.schemaVersion !== 1 ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.triggers) ||
    !Array.isArray(value.edges) ||
    !isRecord(value.editor)
  )
    return false;

  const knownSteps = new Set(
    WORKFLOW_STEP_CATALOG.map(({ kind }) => String(kind)),
  );
  const knownTriggers = new Set(
    WORKFLOW_TRIGGER_CATALOG.map(({ kind }) => String(kind)),
  );
  const card = (entry: unknown, kinds: Set<string>) =>
    isRecord(entry) &&
    typeof entry.id === "string" &&
    typeof entry.kind === "string" &&
    kinds.has(entry.kind) &&
    (entry.name === undefined || typeof entry.name === "string") &&
    isRecord(entry.config) &&
    isRecord(entry.position) &&
    typeof entry.position.x === "number" &&
    Number.isFinite(entry.position.x) &&
    typeof entry.position.y === "number" &&
    Number.isFinite(entry.position.y);
  return (
    value.triggers.every((entry) => card(entry, knownTriggers)) &&
    value.nodes.every(
      (entry) =>
        card(entry, knownSteps) &&
        isRecord(entry) &&
        stringArray(entry.requiredPaths) &&
        stringArray(entry.providedPaths) &&
        isRecord(entry.retry) &&
        typeof entry.retry.maxAttempts === "number" &&
        typeof entry.retry.delaySeconds === "number" &&
        (entry.retry.strategy === "FIXED" ||
          entry.retry.strategy === "EXPONENTIAL") &&
        (entry.failurePolicy === "FAIL" || entry.failurePolicy === "CONTINUE"),
    ) &&
    value.edges.every(
      (entry) =>
        isRecord(entry) &&
        ["id", "source", "target", "sourceHandle", "targetHandle"].every(
          (field) => typeof entry[field] === "string",
        ),
    ) &&
    (value.editor.handleLayout === undefined ||
      value.editor.handleLayout === "SIDES" ||
      value.editor.handleLayout === "TOP_BOTTOM") &&
    (value.editor.displayLayout === undefined ||
      value.editor.displayLayout === "REGULAR" ||
      value.editor.displayLayout === "BASIC")
  );
}
