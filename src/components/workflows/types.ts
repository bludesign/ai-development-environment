export type WorkflowPosition = { x: number; y: number };

/**
 * Which edges of a step card its connectors sit on: `SIDES` runs the graph
 * left to right, `TOP_BOTTOM` runs it downwards. Whole-workflow, so every step
 * agrees and edges never cut across a card.
 */
export type WorkflowHandleLayout = "SIDES" | "TOP_BOTTOM";

/** How read-only workflow graphs should position their steps. */
export type WorkflowDisplayLayout = "REGULAR" | "BASIC";

export type WorkflowTriggerDefinition = {
  id: string;
  kind: string;
  name?: string;
  position: WorkflowPosition;
  config: Record<string, unknown>;
};

export type WorkflowNodeDefinition = {
  id: string;
  kind: string;
  name?: string;
  position: WorkflowPosition;
  config: Record<string, unknown>;
  requiredPaths: string[];
  providedPaths: string[];
  retry: {
    maxAttempts: number;
    strategy: "FIXED" | "EXPONENTIAL";
    delaySeconds: number;
  };
  failurePolicy: "FAIL" | "CONTINUE";
};

export type WorkflowEdgeDefinition = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
};

export type WorkflowDefinition = {
  format: "aide.workflow";
  schemaVersion: 1;
  name: string;
  description: string;
  triggers: WorkflowTriggerDefinition[];
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
  editor: {
    viewport?: { x: number; y: number; zoom: number };
    handleLayout?: WorkflowHandleLayout;
    displayLayout?: WorkflowDisplayLayout;
  };
};

export type WorkflowCatalogEntry = {
  kind: string;
  category: string;
  label: string;
  description: string;
  details: string;
  execution: string;
  configSchema: Record<string, unknown>;
  capabilityFlags: string[];
  requiredPaths: string[];
  providedPaths: string[];
  sourceHandles: string[];
  mutatesExternal: boolean;
  mutatesWorktree: boolean;
};

export type WorkflowTriggerCatalogEntry = {
  kind: string;
  category: string;
  label: string;
  description: string;
  details: string;
  configSchema: Record<string, unknown>;
  capabilityFlags: string[];
  seedPaths: string[];
  sourceHandles: string[];
};

export type WorkflowCatalog = {
  schemaVersion: number;
  globalConcurrency: number;
  steps: WorkflowCatalogEntry[];
  triggers: WorkflowTriggerCatalogEntry[];
};

export type WorkflowDiagnostic = {
  severity: "ERROR" | "WARNING";
  code: string;
  message: string;
  nodeId: string | null;
  triggerId: string | null;
  path: string | null;
};

export type WorkflowSummary = {
  id: string;
  name: string;
  description: string;
  draftDefinition: WorkflowDefinition;
  activeVersionId: string | null;
  enabled: boolean;
  overlapPolicy: "QUEUE" | "CONCURRENT" | "COALESCE_LATEST";
  maxConcurrentRuns: number;
  completionNotificationsEnabled: boolean;
  exclusiveWorktree: boolean;
  quickActionKind: "STANDARD" | "MERGE_CONFLICT" | "GITHUB_ACTIONS" | "NONE";
  quickActionIconKey: string;
  quickActionButtonVariant: "default" | "outline" | "secondary" | "destructive";
  quickActionRepositories: Array<{
    id: string;
    name: string;
    displayOrigin: string;
  }>;
  /** Options the published MANUAL_CHOICE trigger offers, if it has one. */
  triggerChoices: Array<{ key: string; label: string; description: string }>;
  /** Whether the published definition also accepts a no-choice manual run. */
  hasPlainTrigger: boolean;
  archivedAt: string | null;
  versionCount: number;
  runCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowVersion = {
  id: string;
  workflowId: string;
  version: number;
  name: string;
  description: string;
  schemaVersion: number;
  definition: WorkflowDefinition;
  contentHash: string;
  publishedAt: string;
};

/**
 * The phase `WorkflowsService.replay` stamps on the steps it copies forward
 * from the previous generation instead of re-running. A replay writes a row for
 * every step of the graph, so this is what separates the steps it actually
 * re-ran from the ones that only carry an older result under the new
 * generation number.
 */
export const WORKFLOW_REUSED_PHASE = "REUSED_FROM_PRIOR_GENERATION";

export type WorkflowAttempt = {
  id: string;
  nodeId: string;
  kind: string;
  generation: number;
  iterationKey: string;
  attempt: number;
  status: string;
  phase: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  supersededAt: string | null;
  resourceLinks: WorkflowResourceLink[];
  questionBatches?: Array<Record<string, unknown>>;
  checkpoints?: Array<Record<string, unknown>>;
};

export type WorkflowResourceLink = {
  id: string;
  runId?: string;
  attemptId?: string | null;
  kind: string;
  resourceId: string;
  label: string | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type WorkflowRun = {
  id: string;
  displayNumber: number;
  workflowId: string;
  workflow: { id: string; name: string };
  versionId: string;
  version: WorkflowVersion;
  trigger?: { nodeId: string } | null;
  triggerKind: string;
  triggerSubjectKey: string;
  status: string;
  phase: string;
  generation: number;
  sessionData: Record<string, unknown>;
  sessionRevision: number;
  worktree?: {
    id: string;
    folder: string;
    branch: string | null;
    highlightColor: string | null;
  } | null;
  blockedReason: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  attempts: WorkflowAttempt[];
  events: Array<{
    id: string;
    sequence: number;
    attemptId: string | null;
    type: string;
    message: string;
    detail: unknown;
    createdAt: string;
  }>;
  resourceLinks: WorkflowResourceLink[];
};

export type WorktreeRunQueueEntry = {
  position: number;
  id: string;
  kind: "WORKFLOW" | "PLAN" | "SESSION";
  displayNumber: number;
  name: string;
  status: string;
  phase: string;
  worktreeId: string | null;
  worktree: {
    id: string;
    folder: string;
    branch: string | null;
    highlightColor: string | null;
  } | null;
  workflowId: string | null;
  workflowRunId: string | null;
  queuedAt: string;
  exclusiveWorktree: boolean;
  worktreeConcurrencyLimit: number | null;
};

export function emptyDefinition(
  name = "Untitled workflow",
): WorkflowDefinition {
  return {
    format: "aide.workflow",
    schemaVersion: 1,
    name,
    description: "",
    triggers: [
      {
        id: "manual",
        kind: "MANUAL",
        name: "Manual",
        position: { x: 0, y: 160 },
        config: {},
      },
    ],
    nodes: [],
    edges: [],
    editor: {},
  };
}
