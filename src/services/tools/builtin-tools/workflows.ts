/**
 * MCP tools for authoring, running, and inspecting workflows.
 *
 * Three groups of tools, in the order an agent uses them:
 *
 *  - **Discovery** — the catalog of step and trigger kinds with their prose and
 *    config schemas, the session-data vocabulary, and per-step path availability.
 *    Read these before authoring; a step bound to a path its trigger cannot seed
 *    fails validation with REQUIREMENT_UNSATISFIED.
 *  - **Authoring** — granular graph edits that load the draft, apply one change,
 *    save it back, and return fresh diagnostics, plus a whole-definition escape
 *    hatch for bulk work.
 *  - **Runs** — triggering, inspecting, controlling, answering, and replaying.
 *
 * The service is passed as a thunk because `ToolsService` is constructed before
 * `WorkflowsService`, which itself depends on `ToolsService` (see
 * `src/services/server-services.ts`). The thunk is only called at invocation
 * time, long after both constructors have run.
 */

import * as z from "zod/v4";

import {
  computeWorkflowPathAvailability,
  parseWorkflowDefinition,
  resourceManualSeedPaths,
  WORKFLOW_RESOURCE_KINDS,
  WORKFLOW_STEP_CATALOG,
  WORKFLOW_STEP_KINDS,
  WORKFLOW_TRIGGER_CATALOG,
  WORKFLOW_TRIGGER_KINDS,
  type WorkflowDefinition,
} from "@/lib/workflows/definition";
import {
  addWorkflowStep,
  addWorkflowTrigger,
  availableSourceHandles,
  connectWorkflowNodes,
  disconnectWorkflowNodes,
  layoutWorkflowDefinition,
  removeWorkflowGraphNode,
  updateWorkflowStep,
  updateWorkflowTrigger,
} from "@/lib/workflows/graph-edit";
import { expandSessionPaths } from "@/lib/workflows/session-schema";
import type { WorkflowsService } from "@/services/workflows";

import {
  DESTRUCTIVE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";
import {
  jsonSafe,
  workflowAttemptView,
  workflowQuestionBatchView,
  workflowRunEventView,
  workflowRunView,
  workflowVersionView,
  workflowView,
} from "../builtin-views";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const WorkflowIdSchema = z.object({
  workflowId: z.string().min(1).describe("Workflow id."),
});

const PositionSchema = z
  .object({ x: z.number(), y: z.number() })
  .describe(
    "Canvas position. Presentation only — omit it and a sensible spot is chosen.",
  );

const ConfigSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Config object for this kind. Call describe_workflow_kind for its schema. A value may be a constant, a session binding `{source:'SESSION',path:'ticket.key'}`, or a string with `{{ticket.key}}` interpolation.",
  );

/**
 * Per-node path declarations. The catalog can only describe what a *kind* always
 * provides, but a few steps write wherever their config points —
 * CONTROL_SET_VARIABLE to its `path`, TERMINAL_RUN to whatever it emits. Nothing
 * downstream may bind to such a path until the node claims it here, so this is
 * the field that makes "compute a value, then branch on it" publishable.
 */
const ProvidedPathsSchema = z
  .array(z.string())
  .max(100)
  .describe(
    "Extra session paths this step guarantees, on top of what its kind always provides. Required when a step writes to a config-chosen path — e.g. a CONTROL_SET_VARIABLE with `path: 'checks.ready'` must declare ['checks.ready'], or a later step binding it fails validation with REQUIREMENT_UNSATISFIED.",
  );

const RequiredPathsSchema = z
  .array(z.string())
  .max(100)
  .describe(
    "Extra session paths this step demands, on top of its kind's own. Publishing fails unless every trigger that reaches the step guarantees them.",
  );

const DiagnosticSchema = z.object({
  severity: z.enum(["ERROR", "WARNING"]),
  code: z.string(),
  message: z.string(),
  nodeId: z.string().nullable(),
  triggerId: z.string().nullable(),
  path: z.string().nullable(),
});

const DefinitionResultSchema = z.object({
  workflowId: z.string(),
  definition: z.unknown().describe("The saved draft definition."),
  valid: z
    .boolean()
    .describe("Whether the draft would publish. Warnings do not block."),
  diagnostics: z.array(DiagnosticSchema),
  nodeId: z.string().nullable().describe("Id of a step this call created."),
  triggerId: z
    .string()
    .nullable()
    .describe("Id of a trigger this call created."),
  edgeId: z
    .string()
    .nullable()
    .describe("Id of a connection this call created."),
});

const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  overlapPolicy: z.string(),
  maxConcurrentRuns: z.number(),
  activeVersionId: z.string().nullable(),
  draftSchemaVersion: z.number(),
  globalQuickAction: z.boolean(),
  archivedAt: z.string().nullable(),
  versionCount: z.number(),
  runCount: z.number(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const RunSchema = z.object({
  id: z.string(),
  displayNumber: z.number(),
  workflowId: z.string(),
  versionId: z.string(),
  parentRunId: z.string().nullable(),
  triggerKind: z.string(),
  triggerSubjectKey: z.string(),
  triggerPayload: z.unknown(),
  status: z.string(),
  phase: z.string(),
  generation: z.number(),
  sessionData: z.unknown(),
  blockedReason: z.string().nullable(),
  error: z.string().nullable(),
  attemptCount: z.number(),
  eventCount: z.number(),
  queuedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  attemptId: z.string().nullable(),
  sequence: z.number(),
  type: z.string(),
  message: z.string(),
  detail: z.unknown(),
  createdAt: z.string().nullable(),
});

const QuestionBatchSchema = z.object({
  batchId: z.string(),
  runId: z.string().nullable(),
  status: z.string(),
  createdAt: z.string().nullable(),
  questions: z.array(
    z.object({
      id: z.string(),
      header: z.string().nullable(),
      prompt: z.string(),
      multiSelect: z.boolean(),
      allowCustom: z.boolean(),
      options: z.array(
        z.object({ label: z.string(), description: z.string().nullable() }),
      ),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Service = () => WorkflowsService;

const TRIGGER_WORKFLOW_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

function matches(haystack: string, search?: string | null): boolean {
  return !search || haystack.toLowerCase().includes(search.toLowerCase());
}

/**
 * Loads a workflow's draft definition. Read-modify-write is the only way to make
 * a granular edit — the service persists whole definitions — so every authoring
 * tool starts here.
 */
async function draft(
  service: Service,
  workflowId: string,
): Promise<WorkflowDefinition> {
  const workflow = await service().get(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} was not found`);
  return parseWorkflowDefinition(JSON.parse(workflow.draftDefinitionJson));
}

/**
 * Saves an edited draft and reports what the validator makes of it. Diagnostics
 * come back on every edit rather than only on demand, so an agent sees the
 * consequence of the change it just made instead of discovering it at publish.
 */
async function saveDraft(
  service: Service,
  workflowId: string,
  definition: WorkflowDefinition,
  created: {
    nodeId?: string | null;
    triggerId?: string | null;
    edgeId?: string | null;
  } = {},
) {
  const workflows = service();
  await workflows.saveDraft({ id: workflowId, definition });
  const { valid, diagnostics } = await workflows.validateDraft(workflowId);
  return {
    workflowId,
    definition: jsonSafe(definition),
    valid,
    diagnostics: diagnostics.map((entry) => ({
      severity: entry.severity,
      code: entry.code,
      message: entry.message,
      nodeId: entry.nodeId ?? null,
      triggerId: entry.triggerId ?? null,
      path: entry.path ?? null,
    })),
    nodeId: created.nodeId ?? null,
    triggerId: created.triggerId ?? null,
    edgeId: created.edgeId ?? null,
  };
}

function stepEntry(kind: string) {
  const entry = WORKFLOW_STEP_CATALOG.find((item) => item.kind === kind);
  if (!entry) throw new Error(`Unknown step kind ${kind}`);
  return entry;
}

function triggerEntry(kind: string) {
  const entry = WORKFLOW_TRIGGER_CATALOG.find((item) => item.kind === kind);
  if (!entry) throw new Error(`Unknown trigger kind ${kind}`);
  return entry;
}

// ---------------------------------------------------------------------------
// Tool group
// ---------------------------------------------------------------------------

export function createWorkflowToolGroup(workflows: Service): BuiltInToolGroup {
  const discoveryGroup: BuiltInToolGroup = {
    id: "builtin:workflows:discovery",
    name: "Discovery",
    children: [],
    tools: [
      defineTool({
        name: "list_workflow_step_kinds",
        title: "List workflow step kinds",
        description:
          "Browse the step kinds a workflow can be built from, with a short description of each. Start here when authoring; use describe_workflow_kind for the config schema of one kind.",
        inputSchema: z.object({
          category: z
            .string()
            .optional()
            .describe(
              "Restrict to one category, e.g. 'Jira' or 'Control flow'.",
            ),
          search: z
            .string()
            .optional()
            .describe("Match against kind, label, category, and description."),
        }),
        outputSchema: z.object({
          steps: z.array(
            z.object({
              kind: z.string(),
              category: z.string(),
              label: z.string(),
              description: z.string(),
              execution: z.string(),
              requiredPaths: z.array(z.string()),
              providedPaths: z.array(z.string()),
              sourceHandles: z.array(z.string()),
              mutatesExternal: z.boolean(),
              mutatesWorktree: z.boolean(),
            }),
          ),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: ({ category, search }) => ({
          steps: WORKFLOW_STEP_CATALOG.filter(
            (entry) =>
              (!category || entry.category === category) &&
              matches(
                `${entry.kind} ${entry.label} ${entry.category} ${entry.description}`,
                search,
              ),
            // `details` and the config schema are left out on purpose: 65 of
            // each would swamp a listing. describe_workflow_kind has them.
          ).map((entry) => ({
            kind: entry.kind,
            category: entry.category,
            label: entry.label,
            description: entry.description,
            execution: entry.execution,
            requiredPaths: entry.requiredPaths,
            providedPaths: entry.providedPaths,
            sourceHandles: entry.sourceHandles,
            mutatesExternal: entry.mutatesExternal,
            mutatesWorktree: entry.mutatesWorktree,
          })),
        }),
      }),
      defineTool({
        name: "list_workflow_trigger_kinds",
        title: "List workflow trigger kinds",
        description:
          "Browse the trigger kinds that can start a workflow, with what each one seeds into session data. Every workflow needs at least one trigger.",
        inputSchema: z.object({
          category: z.string().optional(),
          search: z.string().optional(),
        }),
        outputSchema: z.object({
          triggers: z.array(
            z.object({
              kind: z.string(),
              category: z.string(),
              label: z.string(),
              description: z.string(),
              seedPaths: z.array(z.string()),
              sourceHandles: z.array(z.string()),
            }),
          ),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: ({ category, search }) => ({
          triggers: WORKFLOW_TRIGGER_CATALOG.filter(
            (entry) =>
              (!category || entry.category === category) &&
              matches(
                `${entry.kind} ${entry.label} ${entry.category} ${entry.description}`,
                search,
              ),
          ).map((entry) => ({
            kind: entry.kind,
            category: entry.category,
            label: entry.label,
            description: entry.description,
            seedPaths: entry.seedPaths,
            sourceHandles: entry.sourceHandles,
          })),
        }),
      }),
      defineTool({
        name: "describe_workflow_kind",
        title: "Describe a workflow step or trigger kind",
        description:
          "Full detail for one kind: long-form notes on preconditions and side effects, the JSON Schema for its config, the session paths it requires and provides, and the handles edges may leave it from.",
        inputSchema: z.object({
          kind: z.string().min(1).describe("A step or trigger kind."),
        }),
        outputSchema: z.object({
          scope: z.enum(["step", "trigger"]),
          kind: z.string(),
          category: z.string(),
          label: z.string(),
          description: z.string(),
          details: z.string(),
          execution: z.string().nullable(),
          configSchema: z.unknown(),
          requiredPaths: z.array(z.string()),
          providedPaths: z.array(z.string()),
          seedPaths: z.array(z.string()),
          sourceHandles: z.array(z.string()),
          mutatesExternal: z.boolean(),
          mutatesWorktree: z.boolean(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: ({ kind }) => {
          const step = WORKFLOW_STEP_CATALOG.find((item) => item.kind === kind);
          if (step) {
            return {
              scope: "step" as const,
              ...step,
              configSchema: jsonSafe(step.configSchema),
              seedPaths: [],
            };
          }
          const trigger = triggerEntry(kind);
          return {
            scope: "trigger" as const,
            ...trigger,
            configSchema: jsonSafe(trigger.configSchema),
            execution: null,
            requiredPaths: [],
            providedPaths: [],
            mutatesExternal: false,
            mutatesWorktree: false,
          };
        },
      }),
      defineTool({
        name: "list_workflow_session_paths",
        title: "List workflow session-data paths",
        description:
          "The session-data vocabulary a step's config can bind to — concrete paths like `ticket.key` or `pr.number`, with what each holds. Use it to write bindings that resolve at run time.",
        inputSchema: z.object({
          namespace: z
            .string()
            .optional()
            .describe("Restrict to one namespace, e.g. 'ticket' or 'pr'."),
        }),
        outputSchema: z.object({
          paths: z.array(
            z.object({ path: z.string(), description: z.string().nullable() }),
          ),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: ({ namespace }) => {
          const wildcards = namespace
            ? [`${namespace}.*`]
            : [
                ...new Set(
                  WORKFLOW_TRIGGER_CATALOG.flatMap(
                    ({ seedPaths }) => seedPaths,
                  ),
                ),
              ];
          return {
            paths: expandSessionPaths(wildcards).map(
              ({ path, description }) => ({
                path,
                description: description ?? null,
              }),
            ),
          };
        },
      }),
      defineTool({
        name: "get_workflow_path_availability",
        title: "Get workflow path availability",
        description:
          "Per step, the session paths guaranteed to exist before it runs and the ones it contributes. This is what decides whether a config binding is legal — check it before binding a step to a path.",
        inputSchema: WorkflowIdSchema,
        outputSchema: z.object({
          steps: z.array(
            z.object({
              nodeId: z.string(),
              kind: z.string(),
              availableBefore: z.array(z.string()),
              provides: z.array(z.string()),
            }),
          ),
          triggerSeeds: z.array(
            z.object({
              triggerId: z.string(),
              kind: z.string(),
              seedPaths: z.array(z.string()),
            }),
          ),
          violations: z.array(
            z.object({
              nodeId: z.string(),
              triggerId: z.string(),
              triggerName: z.string(),
              path: z.string(),
            }),
          ),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ workflowId }) => {
          const definition = await draft(workflows, workflowId);
          const availability = computeWorkflowPathAvailability(definition);
          return {
            steps: definition.nodes.map((node) => ({
              nodeId: node.id,
              kind: node.kind,
              availableBefore: availability.availableBefore.get(node.id) ?? [],
              provides: availability.provides.get(node.id) ?? [],
            })),
            triggerSeeds: definition.triggers.map((entry) => ({
              triggerId: entry.id,
              kind: entry.kind,
              seedPaths: [
                "workflow.*",
                ...triggerEntry(entry.kind).seedPaths,
                ...resourceManualSeedPaths(entry.kind, entry.config),
              ],
            })),
            violations: availability.requirementViolations,
          };
        },
      }),
    ],
  };

  const authoringGroup: BuiltInToolGroup = {
    id: "builtin:workflows:authoring",
    name: "Authoring",
    children: [],
    tools: [
      // -- Workflow CRUD -----------------------------------------------------
      defineTool({
        name: "list_workflows",
        title: "List workflows",
        description: "List workflows with their publish and enablement state.",
        inputSchema: z.object({
          search: z.string().optional().describe("Match name or description."),
          archive: z
            .enum(["ACTIVE", "ARCHIVED", "ALL"])
            .optional()
            .describe("Defaults to ACTIVE."),
          enabled: z.boolean().optional(),
          first: z.number().int().min(1).max(200).optional(),
          after: z.string().optional().describe("Cursor from a previous page."),
        }),
        outputSchema: z.object({
          workflows: z.array(WorkflowSchema),
          nextCursor: z.string().nullable(),
          totalCount: z.number(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async (input) => {
          const page = await workflows().list(input);
          return {
            workflows: page.items.map((item) =>
              workflowView(item as unknown as Record<string, unknown>),
            ),
            nextCursor: page.nextCursor,
            totalCount: page.totalCount,
          };
        },
      }),
      defineTool({
        name: "get_workflow",
        title: "Get workflow",
        description:
          "Read one workflow, optionally with its full draft definition — every trigger, step, and connection.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          includeDefinition: z
            .boolean()
            .optional()
            .describe("Include the draft graph. Defaults to true."),
        }),
        outputSchema: z.object({
          workflow: WorkflowSchema,
          definition: z.unknown().nullable(),
          activeVersion: z.unknown().nullable(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ workflowId, includeDefinition }) => {
          const workflow = await workflows().get(workflowId);
          if (!workflow)
            throw new Error(`Workflow ${workflowId} was not found`);
          return {
            workflow: workflowView(
              workflow as unknown as Record<string, unknown>,
            ),
            definition:
              includeDefinition === false
                ? null
                : (JSON.parse(workflow.draftDefinitionJson) as unknown),
            activeVersion: workflow.activeVersion
              ? workflowVersionView(
                  workflow.activeVersion as unknown as Record<string, unknown>,
                )
              : null,
          };
        },
      }),
      defineTool({
        name: "create_workflow",
        title: "Create workflow",
        description:
          "Create a workflow. Without a definition it starts as a draft holding one manual trigger and no steps, ready for add_workflow_step.",
        inputSchema: z.object({
          name: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
          definition: z
            .unknown()
            .optional()
            .describe("A complete definition, e.g. from export_workflow."),
          overlapPolicy: z
            .enum(["QUEUE", "CONCURRENT", "COALESCE_LATEST"])
            .optional()
            .describe(
              "What happens when a run starts while one is in flight. Defaults to QUEUE.",
            ),
          maxConcurrentRuns: z.number().int().min(1).optional(),
        }),
        outputSchema: z.object({
          workflow: WorkflowSchema,
          definition: z.unknown(),
        }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const workflow = await workflows().create(input);
          if (!workflow) throw new Error("Workflow could not be created");
          return {
            workflow: workflowView(
              workflow as unknown as Record<string, unknown>,
            ),
            definition: JSON.parse(workflow.draftDefinitionJson) as unknown,
          };
        },
      }),
      defineTool({
        name: "update_workflow_settings",
        title: "Update workflow settings",
        description:
          "Change a workflow's name, description, or concurrency. Name and description live inside the definition, so this rewrites the draft.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          name: z.string().min(1).max(200).optional(),
          description: z.string().max(2000).optional(),
          overlapPolicy: z
            .enum(["QUEUE", "CONCURRENT", "COALESCE_LATEST"])
            .optional(),
          maxConcurrentRuns: z.number().int().min(1).optional(),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          const next = {
            ...definition,
            name: input.name ?? definition.name,
            description: input.description ?? definition.description,
          };
          await workflows().saveDraft({
            id: input.workflowId,
            definition: next,
            overlapPolicy: input.overlapPolicy ?? null,
            maxConcurrentRuns: input.maxConcurrentRuns ?? null,
          });
          return saveDraft(workflows, input.workflowId, next);
        },
      }),
      defineTool({
        name: "set_workflow_enabled",
        title: "Enable or pause workflow",
        description:
          "Enable a workflow or pause it. A paused workflow ignores its triggers and refuses manual runs.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          enabled: z.boolean(),
        }),
        outputSchema: z.object({ workflow: WorkflowSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ workflowId, enabled }) => {
          const workflow = await workflows().setEnabled(workflowId, enabled);
          return {
            workflow: workflowView(
              workflow as unknown as Record<string, unknown>,
            ),
          };
        },
      }),
      defineTool({
        name: "archive_workflow",
        title: "Archive or restore workflow",
        description:
          "Move a workflow out of the active list, or bring it back. Reversible — use delete_workflow to remove it for good.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          archived: z.boolean(),
        }),
        outputSchema: z.object({ workflow: WorkflowSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ workflowId, archived }) => {
          const workflow = await workflows().archive(workflowId, archived);
          return {
            workflow: workflowView(
              workflow as unknown as Record<string, unknown>,
            ),
          };
        },
      }),
      defineTool({
        name: "delete_workflow",
        title: "Delete workflow",
        description:
          "Permanently delete a workflow and its published versions. Refused once the workflow has run history — archive_workflow is the way to retire one that has run. Not reversible.",
        inputSchema: z.object({ workflowId: z.string().min(1) }),
        outputSchema: z.object({ deleted: z.boolean() }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ workflowId }) => ({
          deleted: await workflows().delete(workflowId),
        }),
      }),

      // -- Graph editing -----------------------------------------------------
      defineTool({
        name: "add_workflow_step",
        title: "Add workflow step",
        description:
          "Add a step to the draft and optionally wire it to an existing trigger or step. Returns the new step's id and the validator's view of the result.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          kind: z
            .enum(WORKFLOW_STEP_KINDS)
            .describe("Step kind. See list_workflow_step_kinds."),
          name: z
            .string()
            .max(200)
            .optional()
            .describe("Display name. Defaults to the kind's label."),
          config: ConfigSchema.optional(),
          connectFrom: z
            .object({
              from: z
                .string()
                .min(1)
                .describe("Trigger or step id this one follows."),
              sourceHandle: z
                .string()
                .optional()
                .describe(
                  "Handle to leave from — 'success' by default, 'true'/'false' on an If, 'body'/'empty' on a For each, an option key on a choice trigger.",
                ),
            })
            .optional(),
          position: PositionSchema.optional(),
          failurePolicy: z
            .enum(["FAIL", "CONTINUE"])
            .optional()
            .describe("CONTINUE lets the run carry on past a failure."),
          retry: z
            .object({
              maxAttempts: z.number().int().min(1).max(20),
              strategy: z.enum(["FIXED", "EXPONENTIAL"]),
              delaySeconds: z.number().int().min(1).max(86_400),
            })
            .optional(),
          providedPaths: ProvidedPathsSchema.optional(),
          requiredPaths: RequiredPathsSchema.optional(),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          const result = addWorkflowStep(definition, {
            ...input,
            name: input.name ?? stepEntry(input.kind).label,
          });
          return saveDraft(workflows, input.workflowId, result.definition, {
            nodeId: result.nodeId,
            edgeId: result.edgeId,
          });
        },
      }),
      defineTool({
        name: "update_workflow_step",
        title: "Update workflow step",
        description:
          "Change a step's name, config, retry, or failure policy. Prefer configPatch, which merges — config replaces the object wholesale.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          nodeId: z.string().min(1),
          name: z.string().max(200).optional(),
          config: ConfigSchema.optional().describe(
            "Replaces the entire config. Keys left out are dropped.",
          ),
          configPatch: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Merges into the existing config. A null value removes that key.",
            ),
          position: PositionSchema.optional(),
          failurePolicy: z.enum(["FAIL", "CONTINUE"]).optional(),
          retry: z
            .object({
              maxAttempts: z.number().int().min(1).max(20),
              strategy: z.enum(["FIXED", "EXPONENTIAL"]),
              delaySeconds: z.number().int().min(1).max(86_400),
            })
            .optional(),
          providedPaths: ProvidedPathsSchema.optional(),
          requiredPaths: RequiredPathsSchema.optional(),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          return saveDraft(
            workflows,
            input.workflowId,
            updateWorkflowStep(definition, input),
            { nodeId: input.nodeId },
          );
        },
      }),
      defineTool({
        name: "add_workflow_trigger",
        title: "Add workflow trigger",
        description:
          "Add a trigger to the draft. A workflow needs at least one, and each must reach a step before it can be published.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          kind: z
            .enum(WORKFLOW_TRIGGER_KINDS)
            .describe("Trigger kind. See list_workflow_trigger_kinds."),
          name: z.string().max(200).optional(),
          config: ConfigSchema.optional().describe(
            "Trigger config. Resource triggers need `resourceKind`; choice triggers need keyed `choices`; issue-command triggers need `allowedLogins` and an anchored `commandPattern`.",
          ),
          position: PositionSchema.optional(),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          const result = addWorkflowTrigger(definition, {
            ...input,
            name: input.name ?? triggerEntry(input.kind).label,
          });
          return saveDraft(workflows, input.workflowId, result.definition, {
            triggerId: result.triggerId,
          });
        },
      }),
      defineTool({
        name: "update_workflow_trigger",
        title: "Update workflow trigger",
        description:
          "Change a trigger's name or config. Narrowing a choice trigger's options also removes the connections that left the options you dropped.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          triggerId: z.string().min(1),
          name: z.string().max(200).optional(),
          config: ConfigSchema.optional(),
          configPatch: z.record(z.string(), z.unknown()).optional(),
          position: PositionSchema.optional(),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          return saveDraft(
            workflows,
            input.workflowId,
            updateWorkflowTrigger(definition, input),
            { triggerId: input.triggerId },
          );
        },
      }),
      defineTool({
        name: "remove_workflow_node",
        title: "Remove workflow step or trigger",
        description:
          "Delete a step or trigger from the draft along with its connections. Set reconnect to stitch its predecessors to its successors so the chain survives.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          id: z.string().min(1).describe("Step or trigger id."),
          reconnect: z
            .boolean()
            .optional()
            .describe("Join what came before to what came after."),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ workflowId, id, reconnect }) => {
          const definition = await draft(workflows, workflowId);
          return saveDraft(
            workflows,
            workflowId,
            removeWorkflowGraphNode(definition, id, { reconnect }),
          );
        },
      }),
      defineTool({
        name: "connect_workflow_nodes",
        title: "Connect workflow nodes",
        description:
          "Draw a connection from a trigger or step to a step. A step with more than one incoming connection must be a CONTROL_JOIN.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          source: z.string().min(1).describe("Trigger or step id."),
          target: z
            .string()
            .min(1)
            .describe("Step id. Triggers take no input."),
          sourceHandle: z
            .string()
            .optional()
            .describe(
              "Handle to leave from. Defaults to the source's first — 'success' for a step.",
            ),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          const result = connectWorkflowNodes(definition, input);
          return saveDraft(workflows, input.workflowId, result.definition, {
            edgeId: result.edgeId,
          });
        },
      }),
      defineTool({
        name: "disconnect_workflow_nodes",
        title: "Disconnect workflow nodes",
        description:
          "Remove a connection, either by its edge id or by the pair of nodes it joins.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          edgeId: z.string().optional(),
          source: z.string().optional(),
          target: z.string().optional(),
          sourceHandle: z.string().optional(),
        }),
        outputSchema: DefinitionResultSchema.extend({
          removedEdgeIds: z.array(z.string()),
        }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const definition = await draft(workflows, input.workflowId);
          const result = disconnectWorkflowNodes(definition, input);
          return {
            ...(await saveDraft(
              workflows,
              input.workflowId,
              result.definition,
            )),
            removedEdgeIds: result.removedEdgeIds,
          };
        },
      }),
      defineTool({
        name: "layout_workflow",
        title: "Lay out workflow graph",
        description:
          "Reposition every trigger and step into readable left-to-right columns. Worth calling once after building a workflow, so it does not open as a pile of overlapping cards.",
        inputSchema: WorkflowIdSchema,
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ workflowId }) => {
          const definition = await draft(workflows, workflowId);
          return saveDraft(
            workflows,
            workflowId,
            layoutWorkflowDefinition(definition),
          );
        },
      }),
      defineTool({
        name: "set_workflow_definition",
        title: "Replace workflow definition",
        description:
          "Overwrite the entire draft graph. The bulk escape hatch — prefer the granular tools for single edits, which cannot clobber work they did not read.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          definition: z
            .unknown()
            .describe(
              "A complete definition object, as returned by get_workflow.",
            ),
        }),
        outputSchema: DefinitionResultSchema,
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ workflowId, definition }) =>
          saveDraft(workflows, workflowId, parseWorkflowDefinition(definition)),
      }),

      // -- Validation and transfer -------------------------------------------
      defineTool({
        name: "validate_workflow",
        title: "Validate workflow draft",
        description:
          "Check the draft without saving anything. Errors block publishing; the codes name the problem — REQUIREMENT_UNSATISFIED means a step binds a path its trigger cannot seed.",
        inputSchema: WorkflowIdSchema,
        outputSchema: z.object({
          valid: z.boolean(),
          diagnostics: z.array(DiagnosticSchema),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ workflowId }) => {
          const result = await workflows().validateDraft(workflowId);
          return {
            valid: result.valid,
            diagnostics: result.diagnostics.map((entry) => ({
              severity: entry.severity,
              code: entry.code,
              message: entry.message,
              nodeId: entry.nodeId ?? null,
              triggerId: entry.triggerId ?? null,
              path: entry.path ?? null,
            })),
          };
        },
      }),
      defineTool({
        name: "publish_workflow",
        title: "Publish workflow",
        description:
          "Publish the draft as a new immutable version. Only a published version can run, and publishing fails if the draft has errors.",
        inputSchema: WorkflowIdSchema,
        outputSchema: z.object({ version: z.unknown() }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ workflowId }) => ({
          version: workflowVersionView(
            (await workflows().publish(workflowId)) as unknown as Record<
              string,
              unknown
            >,
          ),
        }),
      }),
      defineTool({
        name: "export_workflow",
        title: "Export workflow",
        description:
          "Export a workflow as a portable document, with secrets and machine-specific paths stripped. Pass a version id to export a published version instead of the draft.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          versionId: z.string().optional(),
        }),
        outputSchema: z.object({ export: z.unknown() }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ workflowId, versionId }) => ({
          export: jsonSafe(await workflows().export(workflowId, versionId)),
        }),
      }),
      defineTool({
        name: "import_workflow",
        title: "Import workflow",
        description:
          "Create a workflow from an exported document. References that cannot be resolved on this machine come in marked unresolved and must be fixed before publishing.",
        inputSchema: z.object({
          payload: z.unknown().describe("A document from export_workflow."),
          name: z.string().max(200).optional(),
        }),
        outputSchema: z.object({
          workflow: WorkflowSchema,
          definition: z.unknown(),
        }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => {
          const workflow = await workflows().import(input);
          if (!workflow) throw new Error("Workflow could not be imported");
          return {
            workflow: workflowView(
              workflow as unknown as Record<string, unknown>,
            ),
            definition: JSON.parse(workflow.draftDefinitionJson) as unknown,
          };
        },
      }),
    ],
  };

  const runsGroup: BuiltInToolGroup = {
    id: "builtin:workflows:runs",
    name: "Runs",
    children: [],
    tools: [
      defineTool({
        name: "trigger_workflow",
        title: "Trigger workflow run",
        description:
          "Start a run of a published, enabled workflow. Runs whatever the workflow's steps do, including external side effects.",
        inputSchema: z.object({
          workflowId: z.string().min(1),
          sessionData: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("Initial session data, merged with the trigger's seeds."),
          resourceKind: z
            .enum(WORKFLOW_RESOURCE_KINDS)
            .optional()
            .describe("Launch through a resource trigger of this kind."),
          resourceId: z
            .string()
            .optional()
            .describe("The resource to launch against."),
          choice: z
            .string()
            .optional()
            .describe(
              "Option key when the workflow's trigger offers choices. Omitting it on a choice-only workflow returns the valid keys.",
            ),
          subjectKey: z
            .string()
            .optional()
            .describe("Dedupe key. Defaults to the resource or a fresh id."),
        }),
        outputSchema: z.object({ run: RunSchema }),
        annotations: TRIGGER_WORKFLOW_ANNOTATIONS,
        handler: async (input) => {
          const run = await workflows().trigger(input);
          if (!run) throw new Error("Workflow run could not be started");
          return {
            run: workflowRunView(run as unknown as Record<string, unknown>),
          };
        },
      }),
      defineTool({
        name: "list_workflow_runs",
        title: "List workflow runs",
        description: "List runs, newest first, optionally filtered.",
        inputSchema: z.object({
          workflowId: z.string().optional(),
          status: z
            .enum([
              "QUEUED",
              "RUNNING",
              "PAUSING",
              "PAUSED",
              "WAITING",
              "BLOCKED",
              "SUCCEEDED",
              "FAILED",
              "CANCELLED",
            ])
            .optional(),
          search: z
            .string()
            .optional()
            .describe("A run number, or part of a workflow name."),
          first: z.number().int().min(1).max(200).optional(),
          after: z.string().optional(),
        }),
        outputSchema: z.object({
          runs: z.array(RunSchema),
          nextCursor: z.string().nullable(),
          totalCount: z.number(),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async (input) => {
          const page = await workflows().runs(input);
          return {
            runs: page.items.map((item) =>
              workflowRunView(item as unknown as Record<string, unknown>),
            ),
            nextCursor: page.nextCursor,
            totalCount: page.totalCount,
          };
        },
      }),
      defineTool({
        name: "get_workflow_run",
        title: "Get workflow run",
        description:
          "Read a run's status and session data, with its per-step attempts and any questions it is blocked on. Poll this after trigger_workflow.",
        inputSchema: z.object({
          runId: z.string().min(1),
          includeAttempts: z
            .boolean()
            .optional()
            .describe("Include per-step attempts. Defaults to true."),
        }),
        outputSchema: z.object({
          run: RunSchema,
          attempts: z.array(z.unknown()),
          pendingQuestions: z.array(QuestionBatchSchema),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ runId, includeAttempts }) => {
          const run = await workflows().run(runId);
          if (!run) throw new Error(`Workflow run ${runId} was not found`);
          const attempts = run.attempts ?? [];
          return {
            run: workflowRunView(run as unknown as Record<string, unknown>),
            attempts:
              includeAttempts === false
                ? []
                : attempts.map((attempt) =>
                    workflowAttemptView(
                      attempt as unknown as Record<string, unknown>,
                    ),
                  ),
            pendingQuestions: attempts
              .flatMap((attempt) => attempt.questionBatches ?? [])
              .filter((batch) => batch.status === "PENDING")
              .map((batch) =>
                workflowQuestionBatchView(
                  batch as unknown as Record<string, unknown>,
                ),
              ),
          };
        },
      }),
      defineTool({
        name: "get_workflow_run_events",
        title: "Get workflow run events",
        description:
          "Read a run's event log in order. Pass the last sequence you saw to tail only what is new.",
        inputSchema: z.object({
          runId: z.string().min(1),
          afterSequence: z.number().int().optional(),
          first: z.number().int().min(1).max(500).optional(),
        }),
        outputSchema: z.object({ events: z.array(RunEventSchema) }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ runId, afterSequence, first }) => ({
          events: (
            await workflows().runEvents(runId, afterSequence, first)
          ).map((event) =>
            workflowRunEventView(event as unknown as Record<string, unknown>),
          ),
        }),
      }),
      defineTool({
        name: "control_workflow_run",
        title: "Pause, resume, or cancel a run",
        description:
          "Change an in-flight run's lifecycle. Cancelling is final, and leaves any external effects already applied in place.",
        inputSchema: z.object({
          runId: z.string().min(1),
          action: z.enum(["PAUSE", "RESUME", "CANCEL"]),
        }),
        outputSchema: z.object({ run: RunSchema }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ runId, action }) => {
          const run = await workflows().lifecycle(runId, action);
          if (!run) throw new Error("Workflow run lifecycle change failed");
          return {
            run: workflowRunView(run as unknown as Record<string, unknown>),
          };
        },
      }),
      defineTool({
        name: "answer_workflow_question",
        title: "Answer a workflow question",
        description:
          "Answer the question a run is parked on so it can continue. Find the batch id and the questions through get_workflow_run.",
        inputSchema: z.object({
          batchId: z.string().min(1).describe("From get_workflow_run."),
          answers: z
            .record(z.string(), z.unknown())
            .describe(
              "Answers keyed by question id. A value is the chosen option label, a list of labels for a multi-select, or free text where a custom answer is allowed.",
            ),
        }),
        outputSchema: z.object({ run: RunSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ batchId, answers }) => {
          const run = await workflows().answerQuestion(batchId, answers);
          if (!run) throw new Error("Workflow question could not be answered");
          return {
            run: workflowRunView(run as unknown as Record<string, unknown>),
          };
        },
      }),
      defineTool({
        name: "prepare_workflow_replay",
        title: "Preview a workflow replay",
        description:
          "See what replaying a run from a given step would affect: the downstream steps, the external effects that would happen again, and whether a Git checkpoint is available. Read-only — call it before replay_workflow_run.",
        inputSchema: z.object({
          runId: z.string().min(1),
          nodeId: z.string().min(1).describe("Step to replay from."),
        }),
        outputSchema: z.object({ preview: z.unknown() }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ runId, nodeId }) => ({
          preview: jsonSafe(await workflows().prepareReplay(runId, nodeId)),
        }),
      }),
      defineTool({
        name: "replay_workflow_run",
        title: "Replay a workflow run from a step",
        description:
          "Re-run a workflow from one step onward. Every external effect downstream happens again — merges, comments, deploys — so preview it with prepare_workflow_replay first.",
        inputSchema: z.object({
          runId: z.string().min(1),
          nodeId: z.string().min(1),
          restore: z
            .boolean()
            .optional()
            .describe(
              "Restore the worktree to the Git checkpoint at that step, discarding later changes.",
            ),
          stash: z
            .boolean()
            .optional()
            .describe("Stash uncommitted changes before restoring."),
        }),
        outputSchema: z.object({ run: RunSchema }),
        annotations: DESTRUCTIVE_ANNOTATIONS,
        handler: async ({ runId, nodeId, restore, stash }) => {
          const run = await workflows().replay(runId, nodeId, {
            restore,
            stash,
          });
          if (!run) throw new Error("Workflow run could not be replayed");
          return {
            run: workflowRunView(run as unknown as Record<string, unknown>),
          };
        },
      }),
    ],
  };

  return {
    id: "builtin:workflows",
    name: "Workflows",
    tools: [],
    children: [discoveryGroup, authoringGroup, runsGroup],
  };
}

/** Re-exported for tests that assert handle rules without loading the service. */
export { availableSourceHandles };
