import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type {
  Prisma,
  Workflow,
  WorkflowRun,
  WorkflowStepAttempt,
  WorkflowTrigger,
  WorkflowVersion,
} from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import {
  emptyWorkflowDefinition,
  hasWorkflowErrors,
  parseWorkflowDefinition,
  sanitizeWorkflowExportDefinition,
  validateWorkflowDefinition,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STEP_BY_KIND,
  WORKFLOW_STEP_CATALOG,
  WORKFLOW_TRIGGER_CATALOG,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowNodeDefinition,
} from "@/lib/workflows/definition";
import {
  evaluateWorkflowCondition,
  getSessionValue,
  hasSessionValue,
  mergeSessionData,
  resolveWorkflowValue,
  setSessionValue,
  workflowValueSessionPaths,
  workflowSessionData,
  type SessionData,
  type WorkflowCondition,
} from "@/lib/workflows/session";
import {
  agentEventBus,
  type AgentControlService,
} from "@/services/agent-control";
import type { CredentialService } from "@/services/credentials";
import type { NotificationsService } from "@/services/notifications";
import type { RunsService } from "@/services/runs";
import {
  CREDENTIAL_KINDS,
  type CredentialDescriptor,
} from "@/services/credentials/types";
import {
  WORKFLOW_GIT_CHECKPOINT_JOB_KIND,
  WORKFLOW_TERMINAL_JOB_KIND,
  parseWorkflowGitCheckpointPayload,
  parseWorkflowTerminalPayload,
} from "@ai-development-environment/agent-contract/workflows";
import { evaluateWorkflowScript } from "./compute";
import {
  WorkflowEventsService,
  type RecordWorkflowEventInput,
} from "./workflow-events.service";
import {
  WorkflowStepExecutor,
  type WorkflowExecutionContext,
  type WorkflowExecutionResult,
} from "./step-executor";

const WORKFLOWS_CHANGED_TOPIC = "workflows:changed";
const runTopic = (runId: string) => `workflow-run:${runId}`;
const runEventTopic = (runId: string) => `workflow-run:${runId}:events`;
const runQuestionTopic = (runId: string) => `workflow-run:${runId}:questions`;
const ACTIVE_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "PAUSING",
  "PAUSED",
  "WAITING",
  "BLOCKED",
] as const;
const TERMINAL_RUN_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const TERMINAL_ATTEMPT_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
  "SUPERSEDED",
]);
const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const GLOBAL_CONCURRENCY = 4;
const CLAIM_TTL_MS = 5 * 60_000;

type WorkflowWithActiveVersion = Workflow & {
  activeVersion: WorkflowVersion | null;
};

export type CreateWorkflowInput = {
  name: string;
  description?: string | null;
  definition?: unknown;
  overlapPolicy?: string | null;
  maxConcurrentRuns?: number | null;
};

export type SaveWorkflowDraftInput = {
  id: string;
  definition: unknown;
  overlapPolicy?: string | null;
  maxConcurrentRuns?: number | null;
};

export type TriggerWorkflowInput = {
  workflowId: string;
  sessionData?: Record<string, unknown> | null;
  resourceKind?: string | null;
  resourceId?: string | null;
  subjectKey?: string | null;
};

export type ImportWorkflowInput = {
  payload: unknown;
  name?: string | null;
};

export type WorkflowReplayPreview = {
  runId: string;
  nodeId: string;
  affectedNodeIds: string[];
  affectedAttemptIds: string[];
  externalEffects: Array<{
    kind: string;
    resourceId: string;
    label: string | null;
    url: string | null;
  }>;
  checkpointId: string | null;
  gitComparison: Record<string, unknown> | null;
  warning: string | null;
};

export type WorkflowWaitPollResult = {
  pending: boolean;
  result?: Record<string, unknown>;
  error?: string | null;
  pollAfterSeconds?: number;
};

const json = <T>(value: string): T => JSON.parse(value) as T;

function boundedText(value: string, label: string, maximum: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maximum) throw new Error(`${label} is too long`);
  return result;
}

function overlapPolicy(value: string | null | undefined): string {
  const normalized = value?.trim().toUpperCase() || "QUEUE";
  if (!new Set(["QUEUE", "CONCURRENT", "COALESCE_LATEST"]).has(normalized)) {
    throw new Error("Workflow overlap policy is not supported");
  }
  return normalized;
}

function concurrentRuns(
  value: number | null | undefined,
  policy: string,
): number {
  const fallback = policy === "CONCURRENT" ? GLOBAL_CONCURRENCY : 1;
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 32) {
    throw new Error("Maximum concurrent runs must be between 1 and 32");
  }
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function assertSize(value: string, label: string, maximum: number): void {
  if (Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`${label} is too large`);
  }
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function publishWorkflowChanged(id: string): void {
  agentEventBus.publish(WORKFLOWS_CHANGED_TOPIC, {
    workflowChanged: { id },
  });
}

function publishRunChanged(runId: string): void {
  const payload = { workflowRunChanged: { id: runId } };
  agentEventBus.publish(runTopic(runId), payload);
  agentEventBus.publish(WORKFLOWS_CHANGED_TOPIC, {
    workflowChanged: { id: "runs", runId },
  });
}

function nodeRequiredPaths(node: WorkflowNodeDefinition): string[] {
  const catalog = WORKFLOW_STEP_BY_KIND.get(node.kind)!;
  return [
    ...catalog.requiredPaths.map((path) =>
      path.replaceAll("<stepId>", node.id),
    ),
    ...node.requiredPaths,
    ...workflowValueSessionPaths(node.config),
  ];
}

function nodeProvidedPaths(node: WorkflowNodeDefinition): string[] {
  const catalog = WORKFLOW_STEP_BY_KIND.get(node.kind)!;
  return [
    ...catalog.providedPaths.map((path) =>
      path.replaceAll("<stepId>", node.id),
    ),
    ...node.providedPaths,
    `steps.${node.id}.*`,
  ];
}

async function nextDisplayNumber(
  transaction: Prisma.TransactionClient,
): Promise<number> {
  const sequence = await transaction.workflowRunNumberSequence.upsert({
    where: { id: "default" },
    create: { id: "default", nextValue: 2 },
    update: { nextValue: { increment: 1 } },
  });
  return sequence.nextValue - 1;
}

export class WorkflowsService {
  private runtimeTimer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private readonly workerId = randomUUID();
  private readonly activeExecutions = new Map<string, AbortController>();
  private readonly claimedSecretJobs = new Set<string>();
  private readonly waitPollers = new Map<
    string,
    (externalKey: string) => Promise<WorkflowWaitPollResult>
  >();

  constructor(
    readonly events: WorkflowEventsService,
    readonly executor: WorkflowStepExecutor = new WorkflowStepExecutor(),
    private readonly checkpointRestorer?: (
      checkpointId: string,
      options: { stash: boolean },
    ) => Promise<void>,
    private readonly credentials?: CredentialService,
    private readonly agentControl?: AgentControlService,
    private readonly notifications?: NotificationsService,
    private readonly runsService?: RunsService,
  ) {
    if (this.agentControl) {
      this.executor.register("TERMINAL_RUN", (context) =>
        this.startTerminalJob(context),
      );
      this.executor.register("WORKTREE_SNAPSHOT", (context) =>
        this.startCheckpointJob(context),
      );
      this.agentControl.registerCompletionHandler(
        WORKFLOW_TERMINAL_JOB_KIND,
        (job) => this.workflowAgentJobCompleted(job),
      );
      this.agentControl.registerCompletionObserver((job) =>
        this.genericAgentJobCompleted(job),
      );
      this.agentControl.registerCompletionHandler(
        WORKFLOW_GIT_CHECKPOINT_JOB_KIND,
        (job) => this.workflowAgentJobCompleted(job),
      );
    }
  }

  private async controlLinkedAgentRuns(
    workflowRunId: string,
    action: "PAUSE" | "CONTINUE" | "CANCEL",
  ): Promise<void> {
    if (!this.runsService) return;
    const prisma = await getPrismaClient();
    const links = await prisma.workflowRunResourceLink.findMany({
      where: {
        runId: workflowRunId,
        kind: "AGENT_RUN",
        attempt: { status: { in: ["RUNNING", "WAITING"] } },
      },
      select: { resourceId: true },
      distinct: ["resourceId"],
    });
    await Promise.allSettled(
      links.map(async ({ resourceId }) => {
        const run = await this.runsService!.get(resourceId);
        if (!run || run.origin !== "MANAGED") return;
        if (action === "PAUSE" && run.status !== "IN_PROGRESS") return;
        if (action === "CONTINUE" && run.status !== "PAUSED") return;
        if (
          action === "CANCEL" &&
          new Set(["COMPLETED", "FAILED", "CANCELLED"]).has(run.status)
        ) {
          return;
        }
        await this.runsService!.lifecycle(resourceId, action);
      }),
    );
  }

  private async notifyRun(
    runId: string,
    typeKey:
      | "WORKFLOW_NEEDS_ATTENTION"
      | "WORKFLOW_COMPLETED"
      | "WORKFLOW_FAILED"
      | "WORKFLOW_RECOVERY_PAUSED",
    title: string,
    body: string,
    dedupeSuffix: string,
  ): Promise<void> {
    if (!this.notifications) return;
    const prisma = await getPrismaClient();
    const notification = await prisma.$transaction((transaction) =>
      this.notifications!.recordInTransaction(transaction, {
        dedupeKey: `workflow:${runId}:${dedupeSuffix}`,
        typeKey,
        title,
        body,
        href: `/workflows/runs/${runId}`,
        resourceKind: "WORKFLOW_RUN",
        resourceId: runId,
      }),
    );
    this.notifications.created(notification);
  }

  startRuntime(): void {
    if (this.runtimeTimer) return;
    this.runtimeTimer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error("Workflow runtime tick failed:", error);
      });
    }, 1_000);
    this.runtimeTimer.unref?.();
    void this.tick().catch((error) => {
      console.error("Workflow runtime startup failed:", error);
    });
  }

  stopRuntime(): void {
    if (this.runtimeTimer) clearInterval(this.runtimeTimer);
    this.runtimeTimer = undefined;
    for (const controller of this.activeExecutions.values()) controller.abort();
    this.activeExecutions.clear();
  }

  catalog() {
    return {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      globalConcurrency: GLOBAL_CONCURRENCY,
      steps: WORKFLOW_STEP_CATALOG,
      triggers: WORKFLOW_TRIGGER_CATALOG,
    };
  }

  registerWaitPoller(
    kind: string,
    poller: (externalKey: string) => Promise<WorkflowWaitPollResult>,
  ): void {
    this.waitPollers.set(kind, poller);
  }

  async list(
    input: {
      search?: string | null;
      archive?: string | null;
      enabled?: boolean | null;
      first?: number | null;
      after?: string | null;
    } = {},
  ) {
    const prisma = await getPrismaClient();
    const first = Math.min(Math.max(input.first ?? 100, 1), 200);
    const archive = input.archive?.toUpperCase() ?? "ACTIVE";
    const search = input.search?.trim();
    const items = await prisma.workflow.findMany({
      where: {
        ...(archive === "ALL"
          ? {}
          : archive === "ARCHIVED"
            ? { archivedAt: { not: null } }
            : { archivedAt: null }),
        ...(input.enabled === null || input.enabled === undefined
          ? {}
          : { enabled: input.enabled }),
        ...(search
          ? {
              OR: [
                { name: { contains: search } },
                { description: { contains: search } },
              ],
            }
          : {}),
      },
      include: {
        activeVersion: true,
        _count: { select: { versions: true, runs: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: first + 1,
      ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
    });
    return {
      items: items.slice(0, first),
      nextCursor: items.length > first ? items[first - 1]!.id : null,
      totalCount: await prisma.workflow.count(),
    };
  }

  async get(id: string) {
    const prisma = await getPrismaClient();
    return prisma.workflow.findUnique({
      where: { id },
      include: {
        activeVersion: true,
        versions: { orderBy: { version: "desc" } },
        _count: { select: { runs: true } },
      },
    });
  }

  async version(id: string) {
    const prisma = await getPrismaClient();
    return prisma.workflowVersion.findUnique({
      where: { id },
      include: { triggers: true },
    });
  }

  async create(input: CreateWorkflowInput) {
    const name = boundedText(input.name, "Workflow name", 200);
    const definition = parseWorkflowDefinition(
      input.definition ?? emptyWorkflowDefinition(name),
    );
    const serialized = JSON.stringify({
      ...definition,
      name,
      description: input.description?.trim() ?? definition.description,
    });
    assertSize(serialized, "Workflow definition", MAX_DEFINITION_BYTES);
    const policy = overlapPolicy(input.overlapPolicy);
    const prisma = await getPrismaClient();
    const workflow = await prisma.workflow.create({
      data: {
        id: randomUUID(),
        name,
        description: input.description?.trim() ?? definition.description,
        draftDefinitionJson: serialized,
        draftSchemaVersion: WORKFLOW_SCHEMA_VERSION,
        overlapPolicy: policy,
        maxConcurrentRuns: concurrentRuns(input.maxConcurrentRuns, policy),
      },
    });
    publishWorkflowChanged(workflow.id);
    return this.get(workflow.id);
  }

  async saveDraft(input: SaveWorkflowDraftInput) {
    const definition = parseWorkflowDefinition(input.definition);
    const serialized = JSON.stringify(definition);
    assertSize(serialized, "Workflow definition", MAX_DEFINITION_BYTES);
    const current = await this.get(input.id);
    if (!current) throw new Error("Workflow not found");
    const policy = overlapPolicy(input.overlapPolicy ?? current.overlapPolicy);
    const prisma = await getPrismaClient();
    await prisma.workflow.update({
      where: { id: input.id },
      data: {
        name: definition.name,
        description: definition.description,
        draftDefinitionJson: serialized,
        draftSchemaVersion: definition.schemaVersion,
        overlapPolicy: policy,
        maxConcurrentRuns: concurrentRuns(
          input.maxConcurrentRuns ?? current.maxConcurrentRuns,
          policy,
        ),
      },
    });
    publishWorkflowChanged(input.id);
    return this.get(input.id);
  }

  async validateDraft(id: string): Promise<{
    valid: boolean;
    diagnostics: WorkflowDiagnostic[];
  }> {
    const workflow = await this.get(id);
    if (!workflow) throw new Error("Workflow not found");
    const validation = validateWorkflowDefinition(
      json(workflow.draftDefinitionJson),
    );
    const diagnostics = [...validation.diagnostics];
    if (validation.definition) {
      diagnostics.push(
        ...(await this.validateSubworkflows(
          workflow.id,
          validation.definition,
        )),
      );
    }
    return { valid: !hasWorkflowErrors(diagnostics), diagnostics };
  }

  private async validateSubworkflows(
    workflowId: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowDiagnostic[]> {
    const references = definition.nodes
      .filter(({ kind }) => kind === "CONTROL_SUBWORKFLOW")
      .map((node) => ({ node, versionId: node.config.versionId }))
      .filter(
        (entry): entry is { node: WorkflowNodeDefinition; versionId: string } =>
          typeof entry.versionId === "string",
      );
    if (!references.length) return [];
    const prisma = await getPrismaClient();
    const byId = new Map<string, WorkflowVersion>();
    const nestedById = new Map<string, string[]>();
    const invalidVersionIds = new Set<string>();
    const requested = new Set<string>();
    let pending = references.map(({ versionId }) => versionId);
    while (pending.length) {
      const batch = [...new Set(pending)].filter((id) => !requested.has(id));
      if (!batch.length) break;
      batch.forEach((id) => requested.add(id));
      const versions = await prisma.workflowVersion.findMany({
        where: { id: { in: batch } },
      });
      pending = [];
      for (const version of versions) {
        byId.set(version.id, version);
        try {
          const nested = parseWorkflowDefinition(json(version.definitionJson))
            .nodes.filter(({ kind }) => kind === "CONTROL_SUBWORKFLOW")
            .map(({ config }) => config.versionId)
            .filter((id): id is string => typeof id === "string");
          nestedById.set(version.id, nested);
          pending.push(...nested);
        } catch {
          invalidVersionIds.add(version.id);
        }
      }
    }

    const inspectChain = (
      versionId: string,
      workflowPath: Set<string>,
    ): "MISSING" | "INVALID" | "RECURSIVE" | null => {
      const version = byId.get(versionId);
      if (!version) return "MISSING";
      if (invalidVersionIds.has(versionId)) return "INVALID";
      if (workflowPath.has(version.workflowId)) return "RECURSIVE";
      const nextPath = new Set(workflowPath).add(version.workflowId);
      for (const nestedId of nestedById.get(versionId) ?? []) {
        const result = inspectChain(nestedId, nextPath);
        if (result) return result;
      }
      return null;
    };

    const diagnostics: WorkflowDiagnostic[] = [];
    for (const { node, versionId } of references) {
      const result = inspectChain(versionId, new Set([workflowId]));
      if (result === "MISSING") {
        diagnostics.push({
          severity: "ERROR",
          code: "SUBWORKFLOW_NOT_FOUND",
          message: "Pinned sub-workflow chain contains a missing version",
          nodeId: node.id,
        });
      } else if (result === "INVALID") {
        diagnostics.push({
          severity: "ERROR",
          code: "SUBWORKFLOW_INVALID",
          message: "Pinned sub-workflow chain contains an invalid definition",
          nodeId: node.id,
        });
      } else if (result === "RECURSIVE") {
        diagnostics.push({
          severity: "ERROR",
          code: "SUBWORKFLOW_RECURSION",
          message: "Pinned sub-workflow calls cannot form a recursive chain",
          nodeId: node.id,
        });
      }
    }
    return diagnostics;
  }

  async publish(id: string) {
    const workflow = await this.get(id);
    if (!workflow) throw new Error("Workflow not found");
    const definition = parseWorkflowDefinition(
      json(workflow.draftDefinitionJson),
    );
    const validation = await this.validateDraft(id);
    if (!validation.valid) {
      throw new Error(
        `Workflow cannot be published: ${validation.diagnostics
          .filter(({ severity }) => severity === "ERROR")
          .map(({ message }) => message)
          .slice(0, 5)
          .join("; ")}`,
      );
    }
    const prisma = await getPrismaClient();
    const published = await prisma.$transaction(async (transaction) => {
      const latest = await transaction.workflowVersion.findFirst({
        where: { workflowId: id },
        orderBy: { version: "desc" },
      });
      const versionId = randomUUID();
      const version = await transaction.workflowVersion.create({
        data: {
          id: versionId,
          workflowId: id,
          version: (latest?.version ?? 0) + 1,
          name: definition.name,
          description: definition.description,
          schemaVersion: definition.schemaVersion,
          definitionJson: JSON.stringify(definition),
          contentHash: contentHash(definition),
          triggers: {
            create: definition.triggers.map((trigger) => ({
              id: randomUUID(),
              nodeId: trigger.id,
              kind: trigger.kind,
              configJson: JSON.stringify(trigger.config),
            })),
          },
        },
        include: { triggers: true },
      });
      await transaction.workflow.update({
        where: { id },
        data: { activeVersionId: versionId },
      });
      return version;
    });
    publishWorkflowChanged(id);
    return published;
  }

  async setEnabled(id: string, enabled: boolean) {
    const prisma = await getPrismaClient();
    const workflow = await prisma.workflow.findUnique({ where: { id } });
    if (!workflow) throw new Error("Workflow not found");
    if (enabled && !workflow.activeVersionId) {
      throw new Error("Publish the workflow before enabling it");
    }
    await prisma.workflow.update({ where: { id }, data: { enabled } });
    publishWorkflowChanged(id);
    return this.get(id);
  }

  async archive(id: string, archived: boolean) {
    const prisma = await getPrismaClient();
    await prisma.workflow.update({
      where: { id },
      data: {
        archivedAt: archived ? new Date() : null,
        ...(archived ? { enabled: false } : {}),
      },
    });
    publishWorkflowChanged(id);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    if (await prisma.workflowRun.count({ where: { workflowId: id } })) {
      throw new Error(
        "Archive workflows that have run history instead of deleting them",
      );
    }
    await prisma.workflow.delete({ where: { id } });
    publishWorkflowChanged(id);
    return true;
  }

  export(id: string, versionId?: string | null) {
    return this.exportInternal(id, versionId);
  }

  private async exportInternal(id: string, versionId?: string | null) {
    const workflow = await this.get(id);
    if (!workflow) throw new Error("Workflow not found");
    const version = versionId
      ? workflow.versions.find((entry) => entry.id === versionId)
      : null;
    if (versionId && !version) throw new Error("Workflow version not found");
    const definition = parseWorkflowDefinition(
      json(version?.definitionJson ?? workflow.draftDefinitionJson),
    );
    return {
      format: "aide.workflow.export",
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      workflow: {
        name: version?.name ?? workflow.name,
        description: version?.description ?? workflow.description,
        overlapPolicy: workflow.overlapPolicy,
        maxConcurrentRuns: workflow.maxConcurrentRuns,
        definition: sanitizeWorkflowExportDefinition(definition),
      },
    };
  }

  async import(input: ImportWorkflowInput) {
    const raw =
      typeof input.payload === "string"
        ? input.payload
        : JSON.stringify(input.payload);
    assertSize(raw, "Workflow import", MAX_DEFINITION_BYTES);
    const payload =
      typeof input.payload === "string"
        ? JSON.parse(input.payload)
        : input.payload;
    const object = parseObject(payload, "Workflow import");
    const exported = object.format === "aide.workflow.export";
    const workflow = exported
      ? parseObject(object.workflow, "Exported workflow")
      : object;
    const definition = parseWorkflowDefinition(
      exported ? workflow.definition : workflow,
    );
    return this.create({
      name: input.name?.trim() || definition.name,
      description: definition.description,
      definition: {
        ...definition,
        name: input.name?.trim() || definition.name,
      },
      overlapPolicy:
        typeof workflow.overlapPolicy === "string"
          ? workflow.overlapPolicy
          : "QUEUE",
      maxConcurrentRuns:
        typeof workflow.maxConcurrentRuns === "number"
          ? workflow.maxConcurrentRuns
          : 1,
    });
  }

  async runs(
    input: {
      workflowId?: string | null;
      status?: string | null;
      search?: string | null;
      first?: number | null;
      after?: string | null;
    } = {},
  ) {
    const prisma = await getPrismaClient();
    const first = Math.min(Math.max(input.first ?? 100, 1), 200);
    const searchNumber = Number(input.search);
    const items = await prisma.workflowRun.findMany({
      where: {
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        ...(input.status ? { status: input.status.toUpperCase() } : {}),
        ...(Number.isInteger(searchNumber) && searchNumber > 0
          ? { displayNumber: searchNumber }
          : input.search?.trim()
            ? { workflow: { name: { contains: input.search.trim() } } }
            : {}),
      },
      include: {
        workflow: true,
        version: true,
        trigger: true,
        _count: { select: { attempts: true, events: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: first + 1,
      ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
    });
    return {
      items: items.slice(0, first),
      nextCursor: items.length > first ? items[first - 1]!.id : null,
      totalCount: await prisma.workflowRun.count({
        where: input.workflowId ? { workflowId: input.workflowId } : {},
      }),
    };
  }

  async run(id: string) {
    const prisma = await getPrismaClient();
    return prisma.workflowRun.findUnique({
      where: { id },
      include: {
        workflow: true,
        version: true,
        trigger: true,
        parentRun: true,
        childRuns: { orderBy: { createdAt: "asc" } },
        attempts: {
          orderBy: [
            { generation: "asc" },
            { nodeId: "asc" },
            { iterationKey: "asc" },
            { attempt: "asc" },
          ],
          include: {
            waits: { orderBy: { createdAt: "asc" } },
            resourceLinks: { orderBy: { createdAt: "asc" } },
            questionBatches: {
              orderBy: { createdAt: "asc" },
              include: {
                questions: {
                  orderBy: { position: "asc" },
                  include: { options: { orderBy: { position: "asc" } } },
                },
                answerRevisions: { orderBy: { revision: "asc" } },
                checkpoint: true,
              },
            },
            checkpoints: { orderBy: { createdAt: "asc" } },
          },
        },
        waits: { orderBy: { createdAt: "asc" } },
        events: { orderBy: { sequence: "asc" } },
        resourceLinks: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  async runEvents(runId: string, afterSequence = -1, first = 500) {
    const prisma = await getPrismaClient();
    return prisma.workflowRunEvent.findMany({
      where: { runId, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take: Math.min(Math.max(first, 1), 1_000),
    });
  }

  async questionBatch(id: string) {
    const prisma = await getPrismaClient();
    return prisma.runQuestionBatch.findUnique({
      where: { id },
      include: {
        questions: {
          orderBy: { position: "asc" },
          include: { options: { orderBy: { position: "asc" } } },
        },
        answerRevisions: { orderBy: { revision: "asc" } },
        checkpoint: true,
      },
    });
  }

  async jobSecrets(agentId: string, jobId: string) {
    if (!this.credentials || !this.agentControl) {
      throw new Error("Workflow credentials are unavailable");
    }
    if (this.claimedSecretJobs.has(jobId)) {
      throw new Error("Workflow job secrets were already claimed");
    }
    const job = await this.agentControl.getJob(jobId);
    if (
      !job ||
      job.agentId !== agentId ||
      job.kind !== "workflow.terminal.run" ||
      job.status !== "RUNNING"
    ) {
      throw new Error("Workflow job is not eligible to claim secrets");
    }
    const payload = parseWorkflowTerminalPayload(json(job.payloadJson));
    const knownKinds = new Set<string>(Object.values(CREDENTIAL_KINDS));
    const secrets: Array<{ name: string; value: string }> = [];
    for (const entry of payload.credentialEnvironment) {
      if (!knownKinds.has(entry.credential.kind)) {
        throw new Error("Workflow references an unsupported credential kind");
      }
      const value = await this.credentials.getText(
        entry.credential as CredentialDescriptor,
      );
      if (value === null) {
        throw new Error(`Credential ${entry.credential.id} is unavailable`);
      }
      secrets.push({ name: entry.name, value });
    }
    this.claimedSecretJobs.add(jobId);
    return secrets;
  }

  private async workflowAgentContext(sessionData: SessionData) {
    const prisma = await getPrismaClient();
    const worktreeId = getSessionValue(sessionData, "worktree.id");
    if (typeof worktreeId === "string") {
      const worktree = await prisma.worktree.findUnique({
        where: { id: worktreeId },
        include: { codebase: { include: { agent: true } } },
      });
      if (!worktree) throw new Error("Workflow worktree is unavailable");
      const capabilities: unknown = JSON.parse(
        worktree.codebase.agent.capabilitiesJson,
      );
      return {
        agentId: worktree.codebase.agentId,
        codebaseId: worktree.codebaseId,
        worktreeId: worktree.id,
        cwd: worktree.folder,
        capabilities: Array.isArray(capabilities)
          ? capabilities.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [],
      };
    }
    const codebaseId = getSessionValue(sessionData, "codebase.id");
    if (typeof codebaseId !== "string") {
      throw new Error("Workflow requires a codebase or worktree");
    }
    const codebase = await prisma.codebase.findUnique({
      where: { id: codebaseId },
      include: { agent: true },
    });
    if (!codebase) throw new Error("Workflow codebase is unavailable");
    const capabilities: unknown = JSON.parse(codebase.agent.capabilitiesJson);
    return {
      agentId: codebase.agentId,
      codebaseId: codebase.id,
      worktreeId: null,
      cwd: codebase.folder,
      capabilities: Array.isArray(capabilities)
        ? capabilities.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    };
  }

  private async startTerminalJob(
    context: WorkflowExecutionContext,
  ): Promise<WorkflowExecutionResult> {
    if (!this.agentControl) throw new Error("Agent control is unavailable");
    const target = await this.workflowAgentContext(context.sessionData);
    if (!target.capabilities.includes(WORKFLOW_TERMINAL_JOB_KIND)) {
      throw new Error(
        "The selected agent must be updated to run workflow terminal steps",
      );
    }
    const configuredEnvironment =
      context.node.config.environment &&
      typeof context.node.config.environment === "object" &&
      !Array.isArray(context.node.config.environment)
        ? Object.fromEntries(
            Object.entries(
              context.node.config.environment as Record<string, unknown>,
            ).map(([name, value]) => [name, String(value)]),
          )
        : {};
    const environment = {
      ...configuredEnvironment,
      AIDE_TICKET_KEY: String(
        getSessionValue(context.sessionData, "ticket.key") ?? "",
      ),
      AIDE_TICKET_TITLE: String(
        getSessionValue(context.sessionData, "ticket.title") ?? "",
      ),
      AIDE_BRANCH: String(
        getSessionValue(context.sessionData, "worktree.branch") ?? "",
      ),
      AIDE_BASE_BRANCH: String(
        getSessionValue(context.sessionData, "worktree.baseBranch") ?? "",
      ),
      AIDE_WORKTREE_PATH: String(
        getSessionValue(context.sessionData, "worktree.path") ?? target.cwd,
      ),
      AIDE_CODEBASE_PATH: String(
        getSessionValue(context.sessionData, "codebase.folder") ?? target.cwd,
      ),
      AIDE_REPO_ORIGIN: String(
        getSessionValue(context.sessionData, "repo.displayOrigin") ?? "",
      ),
    };
    const credentialEnvironment = Array.isArray(context.node.config.credentials)
      ? context.node.config.credentials
      : [];
    const job = await this.agentControl.createJob({
      agentId: target.agentId,
      kind: WORKFLOW_TERMINAL_JOB_KIND,
      payload: {
        workflowRunId: context.run.id,
        stepAttemptId: context.attempt.id,
        stepId: context.node.id,
        codebaseId: target.codebaseId,
        worktreeId: target.worktreeId,
        cwd: target.cwd,
        script: boundedText(
          String(context.node.config.script ?? ""),
          "Terminal script",
          1_000_000,
        ),
        interpreter:
          context.node.config.interpreter === "NODE" ? "NODE" : "SHELL",
        sessionData: context.sessionData,
        environment,
        credentialEnvironment,
      },
      idempotencyKey: context.attempt.idempotencyKey,
      timeoutSeconds: Number(context.node.config.timeoutSeconds ?? 900),
      codebaseId: target.codebaseId,
      worktreeId: target.worktreeId,
      visibility: "SYSTEM",
    });
    return {
      output: { jobId: job.id },
      links: [
        {
          kind: "AGENT_JOB",
          resourceId: job.id,
          label: "Workflow terminal job",
          url: `/jobs/${job.id}`,
        },
      ],
      wait: {
        kind: "AGENT_JOB",
        externalKey: job.id,
        timeoutAt: new Date(
          Date.now() +
            Math.max(10, Number(context.node.config.timeoutSeconds ?? 900)) *
              1_000,
        ),
      },
    };
  }

  private async startCheckpointJob(
    context: WorkflowExecutionContext,
  ): Promise<WorkflowExecutionResult> {
    if (!this.agentControl) throw new Error("Agent control is unavailable");
    const target = await this.workflowAgentContext(context.sessionData);
    if (!target.capabilities.includes(WORKFLOW_GIT_CHECKPOINT_JOB_KIND)) {
      throw new Error(
        "The selected agent must be updated to capture workflow checkpoints",
      );
    }
    const job = await this.agentControl.createJob({
      agentId: target.agentId,
      kind: WORKFLOW_GIT_CHECKPOINT_JOB_KIND,
      payload: {
        operation: "CAPTURE",
        workflowRunId: context.run.id,
        stepAttemptId: context.attempt.id,
        cwd: target.cwd,
        kind: String(context.node.config.kind ?? "STEP"),
        checkpoint: null,
        stash: false,
      },
      idempotencyKey: context.attempt.idempotencyKey,
      timeoutSeconds: 300,
      codebaseId: target.codebaseId,
      worktreeId: target.worktreeId,
      visibility: "SYSTEM",
    });
    return {
      output: { jobId: job.id },
      links: [
        {
          kind: "AGENT_JOB",
          resourceId: job.id,
          label: "Workflow checkpoint job",
          url: `/jobs/${job.id}`,
        },
      ],
      wait: { kind: "AGENT_JOB", externalKey: job.id },
    };
  }

  private async workflowAgentJobCompleted(job: {
    id: string;
    kind: string;
    payloadJson: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }): Promise<void> {
    if (job.kind === WORKFLOW_TERMINAL_JOB_KIND) {
      const payload = parseWorkflowTerminalPayload(json(job.payloadJson));
      if (job.status !== "SUCCEEDED" || !job.resultJson) {
        await this.resolveExternalWait(
          "AGENT_JOB",
          job.id,
          { jobId: job.id, status: job.status },
          job.error || `Workflow terminal job ${job.status.toLowerCase()}`,
        );
        return;
      }
      const result = parseObject(
        json(job.resultJson),
        "Workflow terminal result",
      );
      await this.resolveExternalWait("AGENT_JOB", job.id, {
        ...result,
        jobId: job.id,
        stepAttemptId: payload.stepAttemptId,
      });
      return;
    }
    if (job.kind !== WORKFLOW_GIT_CHECKPOINT_JOB_KIND) return;
    const payload = parseWorkflowGitCheckpointPayload(json(job.payloadJson));
    if (job.status !== "SUCCEEDED" || !job.resultJson) {
      await this.resolveExternalWait(
        "AGENT_JOB",
        job.id,
        { jobId: job.id, status: job.status },
        job.error || `Workflow checkpoint job ${job.status.toLowerCase()}`,
      );
      return;
    }
    const result = parseObject(
      json(job.resultJson),
      "Workflow checkpoint result",
    );
    let checkpointId: string | null = null;
    if (result.checkpoint && typeof result.checkpoint === "object") {
      const checkpoint = result.checkpoint as Record<string, unknown>;
      const prisma = await getPrismaClient();
      checkpointId = randomUUID();
      await prisma.$transaction([
        prisma.runCheckpoint.create({
          data: {
            id: checkpointId,
            workflowStepAttemptId: payload.stepAttemptId,
            kind: String(checkpoint.kind ?? payload.kind),
            headSha:
              typeof checkpoint.headSha === "string"
                ? checkpoint.headSha
                : null,
            branch:
              typeof checkpoint.branch === "string" ? checkpoint.branch : null,
            upstreamSha:
              typeof checkpoint.upstreamSha === "string"
                ? checkpoint.upstreamSha
                : null,
            indexTree:
              typeof checkpoint.indexTree === "string"
                ? checkpoint.indexTree
                : null,
            worktreeTree:
              typeof checkpoint.worktreeTree === "string"
                ? checkpoint.worktreeTree
                : null,
            refName:
              typeof checkpoint.refName === "string"
                ? checkpoint.refName
                : null,
            manifestJson:
              typeof checkpoint.manifestJson === "string"
                ? checkpoint.manifestJson
                : null,
            diffSummary:
              typeof checkpoint.diffSummary === "string"
                ? checkpoint.diffSummary
                : null,
            diffPatch:
              typeof checkpoint.diffPatch === "string"
                ? checkpoint.diffPatch
                : null,
            stashRef:
              typeof result.stashRef === "string"
                ? result.stashRef
                : typeof checkpoint.stashRef === "string"
                  ? checkpoint.stashRef
                  : null,
          },
        }),
        prisma.workflowRunResourceLink.create({
          data: {
            id: randomUUID(),
            runId: payload.workflowRunId,
            attemptId: payload.stepAttemptId,
            kind: "CHECKPOINT",
            resourceId: checkpointId,
            label: `${String(checkpoint.kind ?? payload.kind)} checkpoint`,
          },
        }),
      ]);
    }
    await this.resolveExternalWait("AGENT_JOB", job.id, {
      ...result,
      jobId: job.id,
      checkpointId,
    });
  }

  private async genericAgentJobCompleted(job: {
    id: string;
    kind: string;
    status: string;
    resultJson: string | null;
    error: string | null;
    codebaseId?: string | null;
    worktreeId?: string | null;
  }): Promise<void> {
    if (
      job.kind === WORKFLOW_TERMINAL_JOB_KIND ||
      job.kind === WORKFLOW_GIT_CHECKPOINT_JOB_KIND
    ) {
      return;
    }
    let result = job.resultJson
      ? parseObject(json(job.resultJson), "Agent job result")
      : { status: job.status };
    if (job.status === "SUCCEEDED") {
      const prisma = await getPrismaClient();
      const resultWorktree =
        result.worktree &&
        typeof result.worktree === "object" &&
        !Array.isArray(result.worktree)
          ? (result.worktree as Record<string, unknown>)
          : null;
      const gitDirectory =
        resultWorktree && typeof resultWorktree.gitDirectory === "string"
          ? resultWorktree.gitDirectory
          : null;
      const worktree = job.codebaseId
        ? await prisma.worktree.findFirst({
            where: {
              codebaseId: job.codebaseId,
              ...(job.worktreeId
                ? { id: job.worktreeId }
                : gitDirectory
                  ? { gitDirectory }
                  : { id: "__missing__" }),
            },
            include: { codebase: { include: { repository: true } } },
          })
        : null;
      const codebase =
        worktree?.codebase ??
        (job.codebaseId
          ? await prisma.codebase.findUnique({
              where: { id: job.codebaseId },
              include: { repository: true },
            })
          : null);
      const sessionPatch: SessionData = {};
      if (codebase) {
        sessionPatch.repo = {
          id: codebase.repository.id,
          canonicalOrigin: codebase.repository.canonicalOrigin,
          displayOrigin: codebase.repository.displayOrigin,
          defaultBranch: codebase.defaultBranch,
        };
        sessionPatch.codebase = {
          id: codebase.id,
          folder: codebase.folder,
          agentId: codebase.agentId,
          branch: codebase.defaultBranch,
          headSha: codebase.headSha,
        };
      }
      if (worktree) {
        sessionPatch.worktree = {
          id: worktree.id,
          path: worktree.folder,
          branch: worktree.branch,
          baseBranch:
            worktree.baseBranchOverride ?? worktree.codebase.defaultBranch,
          headSha: worktree.headSha,
          pushStatus: worktree.pushStatus,
          ahead: worktree.ahead,
          behind: worktree.behind,
          baseBehind: worktree.baseBehind,
          dirty: worktree.hasStagedChanges || worktree.hasUnstagedChanges,
        };
      }
      if (Object.keys(sessionPatch).length) {
        result = { ...result, sessionPatch };
      }
    }
    await this.resolveExternalWait(
      "AGENT_JOB",
      job.id,
      { ...result, jobId: job.id, status: job.status },
      job.status === "SUCCEEDED"
        ? null
        : job.error || `Agent job ${job.status.toLowerCase()}`,
    );
  }

  private async restoreCheckpointWithAgent(
    checkpointId: string,
    options: { stash: boolean },
  ): Promise<void> {
    if (!this.agentControl) throw new Error("Agent control is unavailable");
    const prisma = await getPrismaClient();
    const checkpoint = await prisma.runCheckpoint.findUnique({
      where: { id: checkpointId },
      include: {
        workflowStepAttempt: { include: { run: true } },
      },
    });
    const attempt = checkpoint?.workflowStepAttempt;
    if (!checkpoint || !attempt)
      throw new Error("Workflow checkpoint not found");
    const target = await this.workflowAgentContext(
      workflowSessionData(attempt.run.sessionDataJson),
    );
    const job = await this.agentControl.createJob({
      agentId: target.agentId,
      kind: WORKFLOW_GIT_CHECKPOINT_JOB_KIND,
      payload: {
        operation: "RESTORE",
        workflowRunId: attempt.runId,
        stepAttemptId: attempt.id,
        cwd: target.cwd,
        kind: "REPLAY_RESTORE",
        checkpoint: {
          headSha: checkpoint.headSha,
          branch: checkpoint.branch,
          upstreamSha: checkpoint.upstreamSha,
          indexTree: checkpoint.indexTree,
          worktreeTree: checkpoint.worktreeTree,
          refName: checkpoint.refName,
        },
        stash: options.stash,
      },
      idempotencyKey: `workflow:restore:${checkpointId}:${randomUUID()}`,
      timeoutSeconds: 300,
      codebaseId: target.codebaseId,
      worktreeId: target.worktreeId,
      visibility: "SYSTEM",
    });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const current = await this.agentControl.getJob(job.id);
      if (!current) throw new Error("Workflow restore job disappeared");
      if (
        new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]).has(
          current.status,
        )
      ) {
        if (current.status !== "SUCCEEDED") {
          throw new Error(
            current.error ||
              `Workflow restore job ${current.status.toLowerCase()}`,
          );
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.agentControl.cancelJob(job.id);
    throw new Error("Workflow restore job timed out");
  }

  private async compareCheckpointWithAgent(
    checkpointId: string,
  ): Promise<Record<string, unknown>> {
    if (!this.agentControl) throw new Error("Agent control is unavailable");
    const prisma = await getPrismaClient();
    const checkpoint = await prisma.runCheckpoint.findUnique({
      where: { id: checkpointId },
      include: { workflowStepAttempt: { include: { run: true } } },
    });
    const attempt = checkpoint?.workflowStepAttempt;
    if (!checkpoint || !attempt)
      throw new Error("Workflow checkpoint not found");
    const target = await this.workflowAgentContext(
      workflowSessionData(attempt.run.sessionDataJson),
    );
    const job = await this.agentControl.createJob({
      agentId: target.agentId,
      kind: WORKFLOW_GIT_CHECKPOINT_JOB_KIND,
      payload: {
        operation: "COMPARE",
        workflowRunId: attempt.runId,
        stepAttemptId: attempt.id,
        cwd: target.cwd,
        kind: "REPLAY_PREVIEW",
        checkpoint: {
          headSha: checkpoint.headSha,
          branch: checkpoint.branch,
          upstreamSha: checkpoint.upstreamSha,
          indexTree: checkpoint.indexTree,
          worktreeTree: checkpoint.worktreeTree,
          refName: checkpoint.refName,
        },
        stash: false,
      },
      idempotencyKey: `workflow:compare:${checkpointId}:${randomUUID()}`,
      timeoutSeconds: 60,
      codebaseId: target.codebaseId,
      worktreeId: target.worktreeId,
      visibility: "SYSTEM",
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = await this.agentControl.getJob(job.id);
      if (!current) throw new Error("Workflow comparison job disappeared");
      if (
        new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]).has(
          current.status,
        )
      ) {
        if (current.status !== "SUCCEEDED" || !current.resultJson) {
          throw new Error(
            current.error ||
              `Workflow comparison job ${current.status.toLowerCase()}`,
          );
        }
        const result = parseObject(
          json(current.resultJson),
          "Workflow comparison result",
        );
        return parseObject(result.comparison, "Git checkpoint comparison");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await this.agentControl.cancelJob(job.id);
    throw new Error("Workflow comparison job timed out");
  }

  async runsForResource(kind: string, resourceId: string) {
    const prisma = await getPrismaClient();
    const links = await prisma.workflowRunResourceLink.findMany({
      where: { kind: kind.trim().toUpperCase(), resourceId: resourceId.trim() },
      select: { runId: true },
      distinct: ["runId"],
      orderBy: { createdAt: "desc" },
    });
    return prisma.workflowRun.findMany({
      where: { id: { in: links.map(({ runId }) => runId) } },
      include: {
        workflow: true,
        version: true,
        trigger: true,
        attempts: { orderBy: [{ generation: "asc" }, { createdAt: "asc" }] },
        resourceLinks: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async acceptingResource(kind: string) {
    const normalized = kind.trim().toUpperCase();
    const prisma = await getPrismaClient();
    const workflows = await prisma.workflow.findMany({
      where: {
        enabled: true,
        archivedAt: null,
        activeVersionId: { not: null },
      },
      include: { activeVersion: true },
      orderBy: { name: "asc" },
    });
    return workflows.filter((workflow) => {
      if (!workflow.activeVersion) return false;
      const definition = parseWorkflowDefinition(
        json(workflow.activeVersion.definitionJson),
      );
      return definition.inputs.some(
        ({ acceptedResourceKind }) =>
          acceptedResourceKind?.toUpperCase() === normalized,
      );
    });
  }

  async recordEvent(input: RecordWorkflowEventInput) {
    return this.events.record(input);
  }

  async trigger(input: TriggerWorkflowInput) {
    const prisma = await getPrismaClient();
    const workflow = await prisma.workflow.findUnique({
      where: { id: input.workflowId },
      include: {
        activeVersion: { include: { triggers: true } },
      },
    });
    if (!workflow?.activeVersion)
      throw new Error("Published workflow not found");
    if (!workflow.enabled || workflow.archivedAt) {
      throw new Error("Workflow is paused");
    }
    const wantedKind = input.resourceKind ? "RESOURCE_MANUAL" : "MANUAL";
    const trigger =
      workflow.activeVersion.triggers.find(({ kind }) => kind === wantedKind) ??
      workflow.activeVersion.triggers.find(({ kind }) => kind === "MANUAL") ??
      null;
    const subjectKey =
      input.subjectKey?.trim() ||
      (input.resourceKind && input.resourceId
        ? `${input.resourceKind}:${input.resourceId}`
        : `manual:${randomUUID()}`);
    const payload = {
      sessionData: input.sessionData ?? {},
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
      manual: true,
    };
    const run = await this.createRunForTrigger(
      workflow,
      workflow.activeVersion,
      trigger,
      null,
      wantedKind,
      subjectKey,
      payload,
      `manual:${workflow.id}:${randomUUID()}`,
    );
    publishRunChanged(run.id);
    return this.run(run.id);
  }

  private async createRunForTrigger(
    workflow: WorkflowWithActiveVersion,
    version: WorkflowVersion,
    trigger: WorkflowTrigger | null,
    triggerEventId: string | null,
    triggerKind: string,
    subjectKey: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    parentRunId: string | null = null,
  ): Promise<WorkflowRun> {
    const prisma = await getPrismaClient();
    return prisma.$transaction(async (transaction) => {
      const existing = await transaction.workflowRun.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return existing;
      if (workflow.overlapPolicy === "COALESCE_LATEST") {
        const queued = await transaction.workflowRun.findFirst({
          where: {
            workflowId: workflow.id,
            triggerSubjectKey: subjectKey,
            status: "QUEUED",
          },
          orderBy: { queuedAt: "desc" },
        });
        if (queued) {
          return transaction.workflowRun.update({
            where: { id: queued.id },
            data: {
              triggerId: trigger?.id ?? null,
              triggerEventId,
              triggerKind,
              triggerPayloadJson: JSON.stringify(payload),
              queuedAt: new Date(),
            },
          });
        }
      }
      const id = randomUUID();
      const sessionSeed = parseObject(
        payload.sessionData ?? {},
        "Session data",
      );
      const sessionData = mergeSessionData(
        {
          workflow: {
            id: workflow.id,
            name: version.name,
            runId: id,
            startedAt: null,
            trigger: {
              id: trigger?.nodeId ?? null,
              kind: triggerKind,
              subjectKey,
            },
          },
          steps: {},
        },
        sessionSeed,
      );
      const serializedSession = JSON.stringify(sessionData);
      assertSize(serializedSession, "Workflow session data", MAX_SESSION_BYTES);
      return transaction.workflowRun.create({
        data: {
          id,
          displayNumber: await nextDisplayNumber(transaction),
          workflowId: workflow.id,
          versionId: version.id,
          triggerId: trigger?.id ?? null,
          triggerEventId,
          parentRunId,
          idempotencyKey,
          triggerKind,
          triggerSubjectKey: subjectKey,
          triggerPayloadJson: JSON.stringify(payload),
          sessionDataJson: serializedSession,
        },
      });
    });
  }

  private async processTriggerEvents(): Promise<void> {
    const prisma = await getPrismaClient();
    const pending = await prisma.workflowTriggerEvent.findMany({
      where: { status: "PENDING" },
      orderBy: { receivedAt: "asc" },
      take: 50,
    });
    for (const event of pending) {
      try {
        const payload = parseObject(json(event.payloadJson), "Trigger payload");
        const workflows = await prisma.workflow.findMany({
          where: {
            enabled: true,
            archivedAt: null,
            activeVersionId: { not: null },
          },
          include: {
            activeVersion: { include: { triggers: true } },
          },
        });
        for (const workflow of workflows) {
          if (!workflow.activeVersion) continue;
          const matching = workflow.activeVersion.triggers.filter(
            ({ kind }) => kind === event.kind,
          );
          for (const trigger of matching) {
            if (
              !(await this.triggerMatches(trigger, event.subjectKey, payload))
            ) {
              continue;
            }
            if (
              payload.workflowCorrelation &&
              typeof payload.workflowCorrelation === "object" &&
              (payload.workflowCorrelation as Record<string, unknown>)
                .workflowId === workflow.id
            ) {
              continue;
            }
            const run = await this.createRunForTrigger(
              { ...workflow, activeVersion: workflow.activeVersion },
              workflow.activeVersion,
              trigger,
              event.id,
              event.kind,
              event.subjectKey,
              payload,
              `${event.id}:${workflow.id}:${trigger.id}`,
            );
            publishRunChanged(run.id);
          }
        }
        await prisma.workflowTriggerEvent.update({
          where: { id: event.id },
          data: { status: "PROCESSED", processedAt: new Date(), error: null },
        });
      } catch (error) {
        await prisma.workflowTriggerEvent.update({
          where: { id: event.id },
          data: {
            status: "FAILED",
            processedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private async triggerMatches(
    trigger: WorkflowTrigger,
    subjectKey: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const config = parseObject(
      json(trigger.configJson),
      "Trigger configuration",
    );
    let cursorChanged: boolean | null = null;
    if (
      payload.cursorValue !== undefined &&
      !(
        typeof config.thresholdPath === "string" &&
        typeof config.thresholdOperator === "string"
      )
    ) {
      const prisma = await getPrismaClient();
      const previous = await prisma.workflowTriggerState.findUnique({
        where: { triggerId_subjectKey: { triggerId: trigger.id, subjectKey } },
      });
      const previousCursor = previous?.cursorJson
        ? parseObject(json(previous.cursorJson), "Trigger cursor").value
        : undefined;
      cursorChanged =
        canonical(previousCursor) !== canonical(payload.cursorValue);
      await prisma.workflowTriggerState.upsert({
        where: { triggerId_subjectKey: { triggerId: trigger.id, subjectKey } },
        create: {
          id: randomUUID(),
          triggerId: trigger.id,
          subjectKey,
          cursorJson: JSON.stringify({ value: payload.cursorValue }),
          lastMatched: cursorChanged,
          ...(cursorChanged ? { lastFiredAt: new Date() } : {}),
        },
        update: {
          cursorJson: JSON.stringify({ value: payload.cursorValue }),
          lastMatched: cursorChanged,
          ...(cursorChanged ? { lastFiredAt: new Date() } : {}),
        },
      });
    }
    if (trigger.kind === "GITHUB_ISSUE_COMMAND") {
      const login = getSessionValue(payload, "comment.author.login");
      const body = getSessionValue(payload, "comment.body");
      const allow = Array.isArray(config.allowedLogins)
        ? config.allowedLogins
        : [];
      if (typeof login !== "string" || !allow.includes(login)) return false;
      if (
        typeof body !== "string" ||
        typeof config.commandPattern !== "string" ||
        !new RegExp(config.commandPattern).test(body)
      ) {
        return false;
      }
    }
    if (
      trigger.kind === "WORKTREE_CONFLICT" &&
      getSessionValue(payload, "worktree.conflicted") !== true
    ) {
      return false;
    }
    if (
      trigger.kind === "WORKTREE_MISSING" &&
      getSessionValue(payload, "worktree.missingAt") == null
    ) {
      return false;
    }
    if (
      trigger.kind === "WORKTREE_DIVERGED" &&
      getSessionValue(payload, "worktree.pushStatus") !== "DIVERGED"
    ) {
      return false;
    }
    if (config.filters && typeof config.filters === "object") {
      for (const [path, expected] of Object.entries(
        config.filters as Record<string, unknown>,
      )) {
        const actual = getSessionValue(payload, path);
        if (Array.isArray(expected)) {
          if (
            !expected.some((entry) => canonical(entry) === canonical(actual))
          ) {
            return false;
          }
        } else if (canonical(expected) !== canonical(actual)) {
          return false;
        }
      }
    }
    if (
      typeof config.thresholdPath === "string" &&
      typeof config.thresholdOperator === "string"
    ) {
      const condition = {
        op: config.thresholdOperator,
        left: { source: "SESSION", path: config.thresholdPath },
        right: config.thresholdValue,
      } as WorkflowCondition;
      const matched = evaluateWorkflowCondition(condition, payload);
      const prisma = await getPrismaClient();
      const previous = await prisma.workflowTriggerState.findUnique({
        where: {
          triggerId_subjectKey: { triggerId: trigger.id, subjectKey },
        },
      });
      await prisma.workflowTriggerState.upsert({
        where: {
          triggerId_subjectKey: { triggerId: trigger.id, subjectKey },
        },
        create: {
          id: randomUUID(),
          triggerId: trigger.id,
          subjectKey,
          lastMatched: matched,
          cursorJson: JSON.stringify({
            value: getSessionValue(payload, config.thresholdPath),
          }),
          ...(matched ? { lastFiredAt: new Date() } : {}),
        },
        update: {
          lastMatched: matched,
          cursorJson: JSON.stringify({
            value: getSessionValue(payload, config.thresholdPath),
          }),
          ...(matched && !previous?.lastMatched
            ? { lastFiredAt: new Date() }
            : {}),
        },
      });
      return matched && !previous?.lastMatched;
    }
    return cursorChanged ?? true;
  }

  private async processSchedules(): Promise<void> {
    const prisma = await getPrismaClient();
    const workflows = await prisma.workflow.findMany({
      where: {
        enabled: true,
        archivedAt: null,
        activeVersionId: { not: null },
      },
      include: {
        activeVersion: {
          include: {
            triggers: {
              where: { kind: "SCHEDULE" },
              include: { states: true },
            },
          },
        },
      },
    });
    const now = new Date();
    for (const workflow of workflows) {
      for (const trigger of workflow.activeVersion?.triggers ?? []) {
        const config = parseObject(
          json(trigger.configJson),
          "Schedule configuration",
        );
        const cadenceSeconds = Number(config.cadenceSeconds);
        if (!Number.isInteger(cadenceSeconds) || cadenceSeconds < 1) continue;
        const subjectKey = workflow.id;
        let state = trigger.states.find(
          (entry) => entry.subjectKey === subjectKey,
        );
        if (!state) {
          const firstRunAt =
            typeof config.firstRunAt === "string"
              ? new Date(config.firstRunAt)
              : null;
          const nextScheduledAt =
            firstRunAt && Number.isFinite(firstRunAt.getTime())
              ? firstRunAt
              : new Date(now.getTime() + cadenceSeconds * 1_000);
          state = await prisma.workflowTriggerState.create({
            data: {
              id: randomUUID(),
              triggerId: trigger.id,
              subjectKey,
              nextScheduledAt,
            },
          });
        }
        if (!state.nextScheduledAt || state.nextScheduledAt > now) continue;
        const scheduledFor = state.nextScheduledAt;
        const nextScheduledAt = new Date(
          Math.max(now.getTime(), scheduledFor.getTime()) +
            cadenceSeconds * 1_000,
        );
        await prisma.workflowTriggerState.update({
          where: { id: state.id },
          data: { lastFiredAt: now, nextScheduledAt },
        });
        await this.events.record({
          kind: "SCHEDULE",
          subjectKey,
          dedupeKey: `schedule:${trigger.id}:${scheduledFor.toISOString()}`,
          payload: {
            sessionData: {},
            scheduledFor: scheduledFor.toISOString(),
            cadenceSeconds,
          },
        });
      }
    }
  }

  async lifecycle(runId: string, action: "PAUSE" | "RESUME" | "CANCEL") {
    const prisma = await getPrismaClient();
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error("Workflow run not found");
    if (action === "PAUSE") {
      if (!new Set(["RUNNING", "WAITING", "BLOCKED"]).has(run.status)) {
        throw new Error("Only an active workflow run can be paused");
      }
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: "PAUSING", phase: "DRAINING" },
      });
      await this.controlLinkedAgentRuns(runId, "PAUSE");
      await this.appendEvent(
        runId,
        null,
        "RUN_PAUSING",
        "Workflow pause requested",
      );
    } else if (action === "RESUME") {
      if (run.status !== "PAUSED") {
        throw new Error("Only a paused workflow run can be resumed");
      }
      await prisma.workflowRun.update({
        where: { id: runId },
        data: { status: "RUNNING", phase: "SCHEDULING", pausedAt: null },
      });
      await this.controlLinkedAgentRuns(runId, "CONTINUE");
      await this.appendEvent(runId, null, "RUN_RESUMED", "Workflow resumed");
    } else {
      if (TERMINAL_RUN_STATUSES.has(run.status)) return this.run(runId);
      await this.controlLinkedAgentRuns(runId, "CANCEL");
      for (const [attemptId, controller] of this.activeExecutions) {
        const attempt = await prisma.workflowStepAttempt.findUnique({
          where: { id: attemptId },
          select: { runId: true },
        });
        if (attempt?.runId === runId) controller.abort();
      }
      await prisma.$transaction([
        prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: "CANCELLED",
            phase: "CANCELLED",
            finishedAt: new Date(),
          },
        }),
        prisma.workflowStepAttempt.updateMany({
          where: {
            runId,
            status: { notIn: [...TERMINAL_ATTEMPT_STATUSES] },
          },
          data: {
            status: "CANCELLED",
            phase: "CANCELLED",
            finishedAt: new Date(),
            claimOwner: null,
            claimExpiresAt: null,
          },
        }),
        prisma.workflowWait.updateMany({
          where: { runId, status: "PENDING" },
          data: { status: "CANCELLED", resolvedAt: new Date() },
        }),
        prisma.workflowResourceLease.deleteMany({ where: { runId } }),
      ]);
      await this.appendEvent(
        runId,
        null,
        "RUN_CANCELLED",
        "Workflow cancelled",
      );
    }
    publishRunChanged(runId);
    return this.run(runId);
  }

  async repairRunData(runId: string, patchValue: unknown) {
    const patch = parseObject(patchValue, "Session data patch");
    const prisma = await getPrismaClient();
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error("Workflow run not found");
    if (!new Set(["BLOCKED", "PAUSED"]).has(run.status)) {
      throw new Error("Only blocked or paused workflows accept repair data");
    }
    const current = workflowSessionData(run.sessionDataJson);
    const identity = getSessionValue(current, "workflow");
    let next = mergeSessionData(current, patch);
    if (identity && typeof identity === "object") {
      next = setSessionValue(next, "workflow", identity);
    }
    const serialized = JSON.stringify(next);
    assertSize(serialized, "Workflow session data", MAX_SESSION_BYTES);
    await prisma.$transaction([
      prisma.workflowRun.update({
        where: { id: runId },
        data: {
          sessionDataJson: serialized,
          sessionRevision: { increment: 1 },
          status: run.status === "PAUSED" ? "PAUSED" : "RUNNING",
          phase: run.status === "PAUSED" ? "PAUSED" : "SCHEDULING",
          blockedReason: null,
        },
      }),
      prisma.workflowStepAttempt.updateMany({
        where: { runId, status: "BLOCKED" },
        data: { status: "PENDING", phase: "PENDING", error: null },
      }),
    ]);
    await this.appendEvent(
      runId,
      null,
      "RUN_DATA_REPAIRED",
      "Workflow session data repaired",
    );
    publishRunChanged(runId);
    return this.run(runId);
  }

  async answerQuestion(batchId: string, answers: unknown) {
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const batch = await transaction.runQuestionBatch.findUnique({
        where: { id: batchId },
        include: { workflowStepAttempt: true, answerRevisions: true },
      });
      const attempt = batch?.workflowStepAttempt;
      if (!batch || !attempt) throw new Error("Workflow question not found");
      if (batch.status !== "PENDING")
        throw new Error("Question was already answered");
      await transaction.runAnswerRevision.create({
        data: {
          id: randomUUID(),
          batchId,
          revision: batch.answerRevisions.length,
          answersJson: JSON.stringify(answers),
        },
      });
      await transaction.runQuestionBatch.update({
        where: { id: batchId },
        data: { status: "ANSWERED", answeredAt: new Date() },
      });
      await transaction.workflowWait.updateMany({
        where: { attemptId: attempt.id, status: "PENDING", kind: "HUMAN" },
        data: {
          status: "RESOLVED",
          resultJson: JSON.stringify({ answers }),
          resolvedAt: new Date(),
        },
      });
      return attempt;
    });
    await this.completeWaitingAttempt(result.id, { answers });
    agentEventBus.publish(runQuestionTopic(result.runId), {
      workflowQuestionChanged: { id: batchId, runId: result.runId },
    });
    return this.run(result.runId);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recoverExpiredClaims();
      await this.processSchedules();
      await this.processTriggerEvents();
      await this.resolveDueWaits();
      await this.startQueuedRuns();
      const prisma = await getPrismaClient();
      const active = await prisma.workflowRun.findMany({
        where: { status: { in: ["RUNNING", "WAITING", "PAUSING"] } },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: 100,
      });
      for (const { id } of active) await this.progressRun(id);
      await this.dispatchReadyAttempts();
    } finally {
      this.ticking = false;
    }
  }

  private async recoverExpiredClaims(): Promise<void> {
    const prisma = await getPrismaClient();
    const expired = await prisma.workflowStepAttempt.findMany({
      where: {
        status: "RUNNING",
        claimExpiresAt: { lt: new Date() },
      },
      include: { run: true },
      take: 100,
    });
    for (const attempt of expired) {
      await prisma.$transaction([
        prisma.workflowStepAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "BLOCKED",
            phase: "RECOVERY_BLOCKED",
            error:
              "The workflow worker stopped while this step was running; verify external state before retrying.",
            claimOwner: null,
            claimExpiresAt: null,
          },
        }),
        prisma.workflowRun.update({
          where: { id: attempt.runId },
          data: {
            status: "BLOCKED",
            phase: "RECOVERY_BLOCKED",
            blockedReason: `Step ${attempt.nodeId} needs recovery review`,
          },
        }),
        prisma.workflowResourceLease.deleteMany({
          where: { attemptId: attempt.id },
        }),
      ]);
      await this.appendEvent(
        attempt.runId,
        attempt.id,
        "STEP_RECOVERY_BLOCKED",
        "Step needs recovery review after its worker lease expired",
      );
      await this.notifyRun(
        attempt.runId,
        "WORKFLOW_RECOVERY_PAUSED",
        "Workflow paused during recovery",
        "An interrupted step requires external-state verification before replay.",
        `recovery:${attempt.id}`,
      );
      publishRunChanged(attempt.runId);
    }
  }

  private async startQueuedRuns(): Promise<void> {
    const prisma = await getPrismaClient();
    const queued = await prisma.workflowRun.findMany({
      where: { status: "QUEUED" },
      include: { workflow: true, version: true },
      orderBy: { queuedAt: "asc" },
      take: 50,
    });
    for (const run of queued) {
      const limit =
        run.workflow.overlapPolicy === "CONCURRENT"
          ? run.workflow.maxConcurrentRuns
          : 1;
      const active = await prisma.workflowRun.count({
        where: {
          workflowId: run.workflowId,
          id: { not: run.id },
          status: {
            in: ACTIVE_RUN_STATUSES.filter((status) => status !== "QUEUED"),
          },
        },
      });
      if (active >= limit) continue;
      const definition = parseWorkflowDefinition(
        json(run.version.definitionJson),
      );
      const startedAt = new Date();
      const sessionData = setSessionValue(
        workflowSessionData(run.sessionDataJson),
        "workflow.startedAt",
        startedAt.toISOString(),
      );
      const started = await prisma.$transaction(async (transaction) => {
        const claimed = await transaction.workflowRun.updateMany({
          where: { id: run.id, status: "QUEUED" },
          data: {
            status: "RUNNING",
            phase: "SCHEDULING",
            startedAt,
            sessionDataJson: JSON.stringify(sessionData),
            sessionRevision: { increment: 1 },
          },
        });
        if (!claimed.count) return false;
        await transaction.workflowStepAttempt.createMany({
          data: definition.nodes.map((node) => ({
            id: randomUUID(),
            runId: run.id,
            nodeId: node.id,
            kind: node.kind,
            generation: run.generation,
            iterationKey: "",
            attempt: 0,
            requiredPathsJson: JSON.stringify(nodeRequiredPaths(node)),
            providedPathsJson: JSON.stringify(nodeProvidedPaths(node)),
            idempotencyKey: `${run.id}:${node.id}:${run.generation}::0`,
          })),
        });
        return true;
      });
      if (started) {
        await this.appendEvent(run.id, null, "RUN_STARTED", "Workflow started");
        publishRunChanged(run.id);
      }
    }
  }

  private selectedTriggerId(
    run: WorkflowRun & { trigger?: WorkflowTrigger | null },
    definition: WorkflowDefinition,
  ): string | null {
    return (
      run.trigger?.nodeId ??
      definition.triggers.find(({ kind }) => kind === run.triggerKind)?.id ??
      null
    );
  }

  private attemptOutput(attempt: WorkflowStepAttempt): {
    value?: unknown;
    selectedHandles?: string[];
  } {
    if (!attempt.outputJson) return {};
    const parsed = json<unknown>(attempt.outputJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { value?: unknown; selectedHandles?: string[] })
      : { value: parsed };
  }

  private edgeState(
    edge: WorkflowDefinition["edges"][number],
    selectedTriggerId: string | null,
    attempts: Map<string, WorkflowStepAttempt>,
    nodeById: Map<string, WorkflowNodeDefinition>,
  ): "ACTIVE" | "INACTIVE" | "PENDING" {
    if (!nodeById.has(edge.source)) {
      return edge.source === selectedTriggerId ? "ACTIVE" : "INACTIVE";
    }
    const attempt = attempts.get(edge.source);
    if (!attempt || !TERMINAL_ATTEMPT_STATUSES.has(attempt.status))
      return "PENDING";
    if (new Set(["SKIPPED", "CANCELLED", "SUPERSEDED"]).has(attempt.status)) {
      return "INACTIVE";
    }
    const sourceNode = nodeById.get(edge.source)!;
    if (attempt.status === "FAILED") {
      if (edge.sourceHandle === "failure" || edge.sourceHandle === "catch") {
        return "ACTIVE";
      }
      return sourceNode.failurePolicy === "CONTINUE" &&
        edge.sourceHandle === "success"
        ? "ACTIVE"
        : "INACTIVE";
    }
    const selected = this.attemptOutput(attempt).selectedHandles;
    if (selected?.length)
      return selected.includes(edge.sourceHandle) ? "ACTIVE" : "INACTIVE";
    return edge.sourceHandle === "success" || edge.sourceHandle === "output"
      ? "ACTIVE"
      : "INACTIVE";
  }

  private async progressRun(runId: string): Promise<void> {
    const prisma = await getPrismaClient();
    let run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { version: true, trigger: true, attempts: true, waits: true },
    });
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    if (run.status === "PAUSING") {
      const drainingWaitKinds = new Set([
        "AGENT_JOB",
        "BUILD",
        "SKILL_RUN",
        "WORKTREE_MOVE",
        "GITHUB_CHECKS",
      ]);
      const drainingAttemptIds = new Set(
        run.waits
          .filter(
            ({ status, kind }) =>
              status === "PENDING" && drainingWaitKinds.has(kind),
          )
          .map(({ attemptId }) => attemptId),
      );
      const active = run.attempts.some(
        ({ id, status }) =>
          new Set(["RUNNING", "READY"]).has(status) ||
          (status === "WAITING" && drainingAttemptIds.has(id)),
      );
      if (!active) {
        await prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: "PAUSED",
            phase: "PAUSED",
            pausedAt: new Date(),
          },
        });
        await this.appendEvent(runId, null, "RUN_PAUSED", "Workflow paused");
        publishRunChanged(runId);
      }
      return;
    }
    if (!new Set(["RUNNING", "WAITING"]).has(run.status)) return;
    const definition = parseWorkflowDefinition(
      json(run.version.definitionJson),
    );
    const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
    const incoming = new Map<string, WorkflowDefinition["edges"]>();
    for (const edge of definition.edges) {
      incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
    }
    let changed = true;
    while (changed) {
      changed = false;
      run = await prisma.workflowRun.findUnique({
        where: { id: runId },
        include: { version: true, trigger: true, attempts: true, waits: true },
      });
      if (!run) return;
      const currentAttempts = run.attempts.filter(
        ({ generation, supersededAt }) =>
          generation === run!.generation && !supersededAt,
      );
      const latest = new Map<string, WorkflowStepAttempt>();
      for (const attempt of currentAttempts) {
        const key = `${attempt.nodeId}:${attempt.iterationKey}`;
        const existing = latest.get(key);
        if (!existing || existing.attempt < attempt.attempt)
          latest.set(key, attempt);
      }
      const base = new Map(
        [...latest.values()]
          .filter(({ iterationKey }) => !iterationKey)
          .map((attempt) => [attempt.nodeId, attempt]),
      );
      const selectedTrigger = this.selectedTriggerId(run, definition);
      for (const node of definition.nodes) {
        const attempt = base.get(node.id);
        if (!attempt || attempt.status !== "PENDING") continue;
        const forEachSource = definition.nodes.find(
          (candidate) =>
            candidate.kind === "CONTROL_FOR_EACH" &&
            candidate.config.joinNodeId === node.id,
        );
        if (forEachSource) {
          const sourceAttempt = base.get(forEachSource.id);
          if (
            !sourceAttempt ||
            !TERMINAL_ATTEMPT_STATUSES.has(sourceAttempt.status)
          ) {
            continue;
          }
          const iterationLatest = [...latest.values()].filter(
            ({ iterationKey }) => Boolean(iterationKey),
          );
          if (
            iterationLatest.some(
              ({ status }) => !TERMINAL_ATTEMPT_STATUSES.has(status),
            )
          ) {
            continue;
          }
          await prisma.workflowStepAttempt.update({
            where: { id: attempt.id },
            data: { status: "READY", phase: "ITERATIONS_JOINED" },
          });
          changed = true;
          continue;
        }
        const edges = incoming.get(node.id) ?? [];
        if (!edges.length) continue;
        const states = edges.map((edge) =>
          this.edgeState(edge, selectedTrigger, base, nodeById),
        );
        const activeCount = states.filter((state) => state === "ACTIVE").length;
        const pendingCount = states.filter(
          (state) => state === "PENDING",
        ).length;
        const joinMode =
          node.kind === "CONTROL_JOIN" && node.config.mode === "ANY"
            ? "ANY"
            : "ALL";
        const ready =
          joinMode === "ANY"
            ? activeCount > 0
            : pendingCount === 0 && activeCount > 0;
        if (ready) {
          await prisma.workflowStepAttempt.update({
            where: { id: attempt.id },
            data: { status: "READY", phase: "READY" },
          });
          changed = true;
        } else if (pendingCount === 0 && activeCount === 0) {
          await prisma.workflowStepAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "SKIPPED",
              phase: "INACTIVE_BRANCH",
              finishedAt: new Date(),
            },
          });
          changed = true;
        }
      }
      if (
        await this.progressIterationAttempts(
          definition,
          run,
          selectedTrigger,
          nodeById,
          incoming,
          latest,
          base,
        )
      ) {
        changed = true;
      }
    }
    run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { version: true, trigger: true, attempts: true, waits: true },
    });
    if (!run) return;
    const latest = new Map<string, WorkflowStepAttempt>();
    for (const attempt of run.attempts.filter(
      ({ generation, supersededAt }) =>
        generation === run!.generation && !supersededAt,
    )) {
      const key = `${attempt.nodeId}:${attempt.iterationKey}`;
      const existing = latest.get(key);
      if (!existing || existing.attempt < attempt.attempt)
        latest.set(key, attempt);
    }
    const values = [...latest.values()];
    const pendingWaits = run.waits.some(({ status }) => status === "PENDING");
    const unfinished = values.some(
      ({ status }) => !TERMINAL_ATTEMPT_STATUSES.has(status),
    );
    if (unfinished) {
      const nextStatus = pendingWaits ? "WAITING" : "RUNNING";
      if (run.status !== nextStatus) {
        await prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: nextStatus,
            phase: pendingWaits ? "WAITING" : "SCHEDULING",
          },
        });
        publishRunChanged(runId);
      }
      return;
    }
    const definitionNow = parseWorkflowDefinition(
      json(run.version.definitionJson),
    );
    const failed = values.find((attempt) => {
      if (attempt.status !== "FAILED") return false;
      const node = definitionNow.nodes.find(({ id }) => id === attempt.nodeId);
      if (!node || node.failurePolicy === "CONTINUE") return false;
      return !definitionNow.edges.some(
        (edge) =>
          edge.source === node.id &&
          new Set(["failure", "catch"]).has(edge.sourceHandle),
      );
    });
    await this.finishRun(
      run,
      failed ? "FAILED" : "SUCCEEDED",
      failed?.error ?? null,
    );
  }

  private async finishRun(
    run: WorkflowRun,
    status: "SUCCEEDED" | "FAILED",
    error: string | null,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.$transaction([
      prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status,
          phase: status,
          error,
          finishedAt: new Date(),
        },
      }),
      prisma.workflowResourceLease.deleteMany({ where: { runId: run.id } }),
    ]);
    await this.appendEvent(
      run.id,
      null,
      `RUN_${status}`,
      status === "SUCCEEDED" ? "Workflow completed" : "Workflow failed",
      error ? { error } : null,
    );
    await this.resolveExternalWait(
      "WORKFLOW_RUN",
      run.id,
      { status, runId: run.id },
      status === "FAILED" ? error || "Sub-workflow failed" : null,
    );
    await this.events.record({
      kind: "WORKFLOW_FINISHED",
      subjectKey: run.workflowId,
      dedupeKey: `workflow-finished:${run.id}`,
      payload: {
        sessionData: workflowSessionData(run.sessionDataJson),
        run: { id: run.id, status },
        workflowCorrelation: { workflowId: run.workflowId, runId: run.id },
      },
    });
    await this.notifyRun(
      run.id,
      status === "SUCCEEDED" ? "WORKFLOW_COMPLETED" : "WORKFLOW_FAILED",
      status === "SUCCEEDED" ? "Workflow completed" : "Workflow failed",
      error || `Workflow run ${run.displayNumber} ${status.toLowerCase()}`,
      status.toLowerCase(),
    );
    publishRunChanged(run.id);
  }

  private async dispatchReadyAttempts(): Promise<void> {
    const prisma = await getPrismaClient();
    const runningCount = await prisma.workflowStepAttempt.count({
      where: { status: "RUNNING" },
    });
    let slots = Math.max(0, GLOBAL_CONCURRENCY - runningCount);
    if (!slots) return;
    const candidates = await prisma.workflowStepAttempt.findMany({
      where: { status: "READY", run: { status: "RUNNING" } },
      orderBy: { createdAt: "asc" },
      take: slots * 2,
    });
    for (const attempt of candidates) {
      if (slots <= 0) break;
      const claimed = await prisma.workflowStepAttempt.updateMany({
        where: { id: attempt.id, status: "READY" },
        data: {
          status: "RUNNING",
          phase: "RUNNING",
          claimOwner: this.workerId,
          claimExpiresAt: new Date(Date.now() + CLAIM_TTL_MS),
          startedAt: attempt.startedAt ?? new Date(),
        },
      });
      if (!claimed.count) continue;
      slots -= 1;
      const controller = new AbortController();
      this.activeExecutions.set(attempt.id, controller);
      void this.executeAttempt(attempt.id, controller.signal)
        .catch((error) => {
          console.error(
            `Workflow attempt ${attempt.id} failed unexpectedly:`,
            error,
          );
        })
        .finally(() => {
          this.activeExecutions.delete(attempt.id);
        });
    }
  }

  private async acquireResourceLease(
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    sessionData: SessionData,
  ): Promise<boolean> {
    const catalog = WORKFLOW_STEP_BY_KIND.get(node.kind)!;
    let key: string | null = null;
    if (catalog.mutatesWorktree) {
      const identifier =
        getSessionValue(sessionData, "worktree.id") ??
        getSessionValue(sessionData, "worktree.path") ??
        getSessionValue(sessionData, "codebase.id");
      if (identifier) key = `git:${String(identifier)}`;
    } else if (node.kind.startsWith("BUILD_")) {
      const identifier = getSessionValue(sessionData, "build.id");
      if (identifier) key = `build:${String(identifier)}`;
    }
    if (!key) return true;
    const prisma = await getPrismaClient();
    await prisma.workflowResourceLease.deleteMany({
      where: { key, expiresAt: { lt: new Date() } },
    });
    try {
      await prisma.workflowResourceLease.create({
        data: {
          key,
          runId: attempt.runId,
          attemptId: attempt.id,
          expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
        },
      });
      await prisma.workflowStepAttempt.update({
        where: { id: attempt.id },
        data: { resourceLockKey: key },
      });
      return true;
    } catch {
      await prisma.workflowStepAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "READY",
          phase: "WAITING_FOR_RESOURCE",
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      return false;
    }
  }

  private async executeAttempt(
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const attempt = await prisma.workflowStepAttempt.findUnique({
      where: { id: attemptId },
      include: { run: { include: { version: true } } },
    });
    if (!attempt || attempt.status !== "RUNNING") return;
    const definition = parseWorkflowDefinition(
      json(attempt.run.version.definitionJson),
    );
    const node = definition.nodes.find(({ id }) => id === attempt.nodeId);
    if (!node) {
      await this.failAttempt(
        attempt,
        null,
        new Error("Workflow step definition is missing"),
      );
      return;
    }
    let sessionData = workflowSessionData(attempt.run.sessionDataJson);
    if (attempt.iterationKey) {
      sessionData = await this.iterationSessionData(
        attempt.run,
        attempt,
        sessionData,
      );
    }
    const missing = nodeRequiredPaths(node).filter(
      (path) => !hasSessionValue(sessionData, path),
    );
    if (missing.length) {
      await prisma.$transaction([
        prisma.workflowStepAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "BLOCKED",
            phase: "MISSING_REQUIREMENTS",
            error: `Missing required session data: ${missing.join(", ")}`,
            claimOwner: null,
            claimExpiresAt: null,
          },
        }),
        prisma.workflowRun.update({
          where: { id: attempt.runId },
          data: {
            status: "BLOCKED",
            phase: "MISSING_REQUIREMENTS",
            blockedReason: `Step ${node.name ?? node.id} needs ${missing.join(", ")}`,
          },
        }),
        prisma.workflowResourceLease.deleteMany({ where: { attemptId } }),
      ]);
      await this.appendEvent(
        attempt.runId,
        attempt.id,
        "STEP_BLOCKED",
        `Step blocked by missing requirements: ${missing.join(", ")}`,
      );
      await this.notifyRun(
        attempt.runId,
        "WORKFLOW_NEEDS_ATTENTION",
        "Workflow needs data",
        `Step ${node.name ?? node.id} needs ${missing.join(", ")}`,
        `blocked:${attempt.id}`,
      );
      publishRunChanged(attempt.runId);
      return;
    }
    await prisma.workflowStepAttempt.update({
      where: { id: attempt.id },
      data: { inputJson: JSON.stringify(sessionData) },
    });
    if (!(await this.acquireResourceLease(attempt, node, sessionData))) return;
    try {
      const resolvedNode: WorkflowNodeDefinition = {
        ...node,
        config: resolveWorkflowValue(node.config, sessionData) as Record<
          string,
          unknown
        >,
      };
      let result: WorkflowExecutionResult;
      if (
        node.kind.startsWith("CONTROL_") ||
        node.kind === "HUMAN_CONFIRM" ||
        node.kind === "HUMAN_CHOICE"
      ) {
        result = await this.executeControl(
          attempt.run,
          attempt,
          resolvedNode,
          sessionData,
          definition,
        );
      } else {
        result = await this.executor.execute({
          run: attempt.run,
          attempt,
          node: resolvedNode,
          sessionData,
          signal,
        });
      }
      if (signal.aborted) throw new Error("Workflow step was cancelled");
      if (result.wait) {
        await this.parkAttempt(attempt, result);
      } else {
        await this.completeAttempt(attempt, node, result);
      }
    } catch (error) {
      await this.failAttempt(
        attempt,
        node,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async iterationSessionData(
    run: WorkflowRun,
    attempt: WorkflowStepAttempt,
    base: SessionData,
  ): Promise<SessionData> {
    const prisma = await getPrismaClient();
    const attempts = await prisma.workflowStepAttempt.findMany({
      where: {
        runId: run.id,
        generation: attempt.generation,
        iterationKey: attempt.iterationKey,
        status: "SUCCEEDED",
      },
      orderBy: { finishedAt: "asc" },
    });
    let result = base;
    if (attempt.inputJson) {
      result = mergeSessionData(
        result,
        parseObject(json(attempt.inputJson), "Iteration input"),
      );
    }
    for (const completed of attempts) {
      const output = this.attemptOutput(completed) as {
        sessionPatch?: SessionData;
      };
      if (output.sessionPatch)
        result = mergeSessionData(result, output.sessionPatch);
    }
    return result;
  }

  private async executeControl(
    run: WorkflowRun,
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    sessionData: SessionData,
    definition: WorkflowDefinition,
  ): Promise<WorkflowExecutionResult> {
    switch (node.kind) {
      case "CONTROL_IF": {
        const condition = node.config.condition as
          WorkflowCondition | undefined;
        if (!condition) throw new Error("If steps require a condition");
        const matched = evaluateWorkflowCondition(condition, sessionData);
        return {
          output: { matched },
          selectedHandles: [matched ? "true" : "false"],
        };
      }
      case "CONTROL_JOIN": {
        const forEachSource = definition.nodes.find(
          (candidate) =>
            candidate.kind === "CONTROL_FOR_EACH" &&
            candidate.config.joinNodeId === node.id,
        );
        if (forEachSource) {
          const prisma = await getPrismaClient();
          const failures = await prisma.workflowStepAttempt.findMany({
            where: {
              runId: run.id,
              generation: attempt.generation,
              iterationKey: { not: "" },
              status: "FAILED",
            },
          });
          if (
            failures.length &&
            forEachSource.config.errorMode !== "COLLECT_ERRORS"
          ) {
            throw new Error(
              `${failures.length} for-each iteration step(s) failed`,
            );
          }
          return {
            output: {
              iterations: await prisma.workflowStepAttempt.count({
                where: {
                  runId: run.id,
                  generation: attempt.generation,
                  iterationKey: { not: "" },
                },
              }),
              failures: failures.map(({ nodeId, iterationKey, error }) => ({
                nodeId,
                iterationKey,
                error,
              })),
            },
          };
        }
        return { output: { joined: true } };
      }
      case "CONTROL_TRY":
        return { output: { started: true } };
      case "CONTROL_DELAY": {
        const seconds = Number(node.config.seconds ?? 0);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 31_536_000) {
          throw new Error("Delay must be between zero and 31,536,000 seconds");
        }
        return {
          wait: {
            kind: "DELAY",
            resumeAfter: new Date(Date.now() + seconds * 1_000),
          },
        };
      }
      case "CONTROL_WAIT_UNTIL": {
        const condition = node.config.condition as
          WorkflowCondition | undefined;
        if (!condition) throw new Error("Wait-until steps require a condition");
        if (evaluateWorkflowCondition(condition, sessionData)) {
          return { output: { matched: true } };
        }
        const cadenceSeconds = Math.max(
          1,
          Number(node.config.cadenceSeconds ?? 15),
        );
        const timeoutSeconds =
          node.config.timeoutSeconds === null ||
          node.config.timeoutSeconds === undefined
            ? null
            : Number(node.config.timeoutSeconds);
        return {
          wait: {
            kind: "PREDICATE",
            predicate: {
              condition: condition as unknown as Record<string, unknown>,
              cadenceSeconds,
            },
            resumeAfter: new Date(Date.now() + cadenceSeconds * 1_000),
            timeoutAt:
              timeoutSeconds === null
                ? null
                : new Date(Date.now() + timeoutSeconds * 1_000),
          },
        };
      }
      case "CONTROL_SET_VARIABLE": {
        if (typeof node.config.path !== "string") {
          throw new Error("Set-variable steps require an output path");
        }
        const value =
          typeof node.config.script === "string"
            ? await evaluateWorkflowScript(node.config.script, sessionData)
            : node.config.value;
        return {
          output: value,
          sessionPatch: setSessionValue({}, node.config.path, value),
        };
      }
      case "CONTROL_FOR_EACH": {
        const items = Array.isArray(node.config.items)
          ? node.config.items
          : typeof node.config.listPath === "string"
            ? getSessionValue(sessionData, node.config.listPath)
            : null;
        if (!Array.isArray(items))
          throw new Error("For-each source must be an array");
        if (items.length > 1_000)
          throw new Error("For-each is limited to 1,000 items");
        await this.spawnForEach(run, attempt, node, definition, items);
        return {
          output: { itemCount: items.length },
          selectedHandles: items.length ? ["body"] : ["empty"],
          sessionPatch: setSessionValue({}, `steps.${node.id}.items`, items),
        };
      }
      case "CONTROL_SUBWORKFLOW":
        return this.startSubworkflow(run, attempt, node, sessionData);
      case "HUMAN_CONFIRM":
      case "HUMAN_CHOICE":
        return this.createHumanQuestion(run, attempt, node);
      default:
        throw new Error(`Unsupported control step ${node.kind}`);
    }
  }

  private async progressIterationAttempts(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    selectedTrigger: string | null,
    nodeById: Map<string, WorkflowNodeDefinition>,
    incoming: Map<string, WorkflowDefinition["edges"]>,
    latest: Map<string, WorkflowStepAttempt>,
    base: Map<string, WorkflowStepAttempt>,
  ): Promise<boolean> {
    const prisma = await getPrismaClient();
    let changed = false;
    const iterationKeys = new Set(
      [...latest.values()]
        .map(({ iterationKey }) => iterationKey)
        .filter(Boolean),
    );
    for (const iterationKey of iterationKeys) {
      const scoped = new Map(base);
      for (const attempt of latest.values()) {
        if (attempt.iterationKey === iterationKey)
          scoped.set(attempt.nodeId, attempt);
      }
      for (const attempt of scoped.values()) {
        if (
          attempt.iterationKey !== iterationKey ||
          attempt.status !== "PENDING"
        ) {
          continue;
        }
        const node = nodeById.get(attempt.nodeId);
        if (!node) continue;
        const edges = incoming.get(node.id) ?? [];
        const states = edges.map((edge) =>
          this.edgeState(edge, selectedTrigger, scoped, nodeById),
        );
        const activeCount = states.filter((state) => state === "ACTIVE").length;
        const pendingCount = states.filter(
          (state) => state === "PENDING",
        ).length;
        const joinMode =
          node.kind === "CONTROL_JOIN" && node.config.mode === "ANY"
            ? "ANY"
            : "ALL";
        if (
          joinMode === "ANY"
            ? activeCount > 0
            : pendingCount === 0 && activeCount > 0
        ) {
          await prisma.workflowStepAttempt.update({
            where: { id: attempt.id },
            data: { status: "READY", phase: "ITERATION_READY" },
          });
          changed = true;
        } else if (pendingCount === 0 && activeCount === 0) {
          await prisma.workflowStepAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "SKIPPED",
              phase: "INACTIVE_ITERATION_BRANCH",
              finishedAt: new Date(),
            },
          });
          changed = true;
        }
      }
    }
    return changed;
  }

  private async spawnForEach(
    run: WorkflowRun,
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    definition: WorkflowDefinition,
    items: unknown[],
  ): Promise<void> {
    const joinNodeId =
      typeof node.config.joinNodeId === "string"
        ? node.config.joinNodeId
        : null;
    const join = definition.nodes.find(({ id }) => id === joinNodeId);
    if (!join || join.kind !== "CONTROL_JOIN") {
      throw new Error("For-each steps require an explicit joinNodeId");
    }
    const outgoing = new Map<string, WorkflowDefinition["edges"]>();
    for (const edge of definition.edges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    }
    const pending = (outgoing.get(node.id) ?? [])
      .filter(({ sourceHandle }) => sourceHandle === "body")
      .map(({ target }) => target);
    const bodyIds = new Set<string>();
    while (pending.length) {
      const id = pending.shift()!;
      if (id === joinNodeId || bodyIds.has(id)) continue;
      bodyIds.add(id);
      pending.push(...(outgoing.get(id) ?? []).map(({ target }) => target));
    }
    if (items.length && !bodyIds.size) {
      throw new Error("For-each body is not connected to its body handle");
    }
    const bodyNodes = definition.nodes.filter(({ id }) => bodyIds.has(id));
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      await transaction.workflowStepAttempt.updateMany({
        where: {
          runId: run.id,
          generation: attempt.generation,
          iterationKey: attempt.iterationKey,
          nodeId: { in: [...bodyIds] },
          status: "PENDING",
        },
        data: {
          status: "SKIPPED",
          phase: "ITERATION_TEMPLATE",
          finishedAt: new Date(),
        },
      });
      if (!items.length || !bodyNodes.length) return;
      await transaction.workflowStepAttempt.createMany({
        data: items.flatMap((item, index) => {
          const iterationKey = attempt.iterationKey
            ? `${attempt.iterationKey}.${index}`
            : String(index);
          const iterationInput = JSON.stringify({
            loop: {
              current: { forEachNodeId: node.id, index, item },
              [node.id]: { index, item },
            },
          });
          return bodyNodes.map((bodyNode) => ({
            id: randomUUID(),
            runId: run.id,
            nodeId: bodyNode.id,
            kind: bodyNode.kind,
            generation: attempt.generation,
            iterationKey,
            attempt: 0,
            status: "PENDING",
            phase: "ITERATION_PENDING",
            inputJson: iterationInput,
            requiredPathsJson: JSON.stringify(nodeRequiredPaths(bodyNode)),
            providedPathsJson: JSON.stringify(nodeProvidedPaths(bodyNode)),
            idempotencyKey: `${run.id}:${bodyNode.id}:${attempt.generation}:${iterationKey}:0`,
          }));
        }),
      });
    });
  }

  private async startSubworkflow(
    run: WorkflowRun,
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    sessionData: SessionData,
  ): Promise<WorkflowExecutionResult> {
    const versionId =
      typeof node.config.versionId === "string" ? node.config.versionId : null;
    if (!versionId) throw new Error("Sub-workflow version is required");
    const prisma = await getPrismaClient();
    const version = await prisma.workflowVersion.findUnique({
      where: { id: versionId },
      include: { workflow: { include: { activeVersion: true } } },
    });
    if (!version) throw new Error("Sub-workflow version not found");
    if (!version.workflow.enabled || version.workflow.archivedAt) {
      throw new Error("Sub-workflow is paused");
    }
    let ancestor: WorkflowRun | null = run;
    let depth = 0;
    while (ancestor) {
      if (ancestor.workflowId === version.workflowId) {
        throw new Error("Recursive sub-workflow invocation is not allowed");
      }
      depth += 1;
      if (depth >= 10) throw new Error("Sub-workflow depth is limited to 10");
      ancestor = ancestor.parentRunId
        ? await prisma.workflowRun.findUnique({
            where: { id: ancestor.parentRunId },
          })
        : null;
    }
    let mapped: SessionData = {};
    if (
      node.config.inputMapping &&
      typeof node.config.inputMapping === "object"
    ) {
      for (const [path, value] of Object.entries(
        node.config.inputMapping as Record<string, unknown>,
      )) {
        mapped = setSessionValue(
          mapped,
          path,
          resolveWorkflowValue(value, sessionData),
        );
      }
    }
    const child = await this.createRunForTrigger(
      { ...version.workflow, activeVersion: version },
      version,
      null,
      null,
      "SUBWORKFLOW",
      run.id,
      { sessionData: mapped, parentRunId: run.id },
      `${attempt.id}:subworkflow:${version.id}`,
      run.id,
    );
    publishRunChanged(child.id);
    return {
      output: { childRunId: child.id },
      links: [
        {
          kind: "WORKFLOW_RUN",
          resourceId: child.id,
          label: `Workflow run #${child.displayNumber}`,
          url: `/workflows/runs/${child.id}`,
        },
      ],
      wait: { kind: "WORKFLOW_RUN", externalKey: child.id },
    };
  }

  private async createHumanQuestion(
    run: WorkflowRun,
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
  ): Promise<WorkflowExecutionResult> {
    const configured = Array.isArray(node.config.questions)
      ? node.config.questions
      : [
          {
            header: node.name ?? null,
            prompt:
              typeof node.config.prompt === "string"
                ? node.config.prompt
                : node.kind === "HUMAN_CONFIRM"
                  ? "Continue this workflow?"
                  : "Choose an option",
            multiSelect: Boolean(node.config.multiSelect),
            allowCustom:
              node.kind === "HUMAN_CONFIRM"
                ? false
                : node.config.allowCustom !== false,
            options:
              node.kind === "HUMAN_CONFIRM"
                ? [
                    { label: "Confirm", description: null },
                    { label: "Cancel", description: null },
                  ]
                : Array.isArray(node.config.options)
                  ? node.config.options
                  : [],
          },
        ];
    if (!configured.length || configured.length > 10) {
      throw new Error(
        "Workflow questions must contain between one and ten questions",
      );
    }
    const prisma = await getPrismaClient();
    const batchId = randomUUID();
    await prisma.runQuestionBatch.create({
      data: {
        id: batchId,
        workflowStepAttemptId: attempt.id,
        nativeRequestId: `workflow:${attempt.id}`,
        questions: {
          create: configured.map((entry, position) => {
            const question = parseObject(entry, "Workflow question");
            const options = Array.isArray(question.options)
              ? question.options
              : [];
            return {
              id: randomUUID(),
              position,
              header:
                typeof question.header === "string" ? question.header : null,
              prompt: boundedText(
                String(question.prompt ?? ""),
                "Question prompt",
                10_000,
              ),
              multiSelect: Boolean(question.multiSelect),
              allowCustom: question.allowCustom !== false,
              options: {
                create: options.map((entry, optionPosition) => {
                  const option = parseObject(entry, "Question option");
                  return {
                    id: randomUUID(),
                    position: optionPosition,
                    label: boundedText(
                      String(option.label ?? ""),
                      "Option label",
                      500,
                    ),
                    description:
                      typeof option.description === "string"
                        ? option.description.slice(0, 2_000)
                        : null,
                  };
                }),
              },
            };
          }),
        },
      },
    });
    agentEventBus.publish(runQuestionTopic(run.id), {
      workflowQuestionChanged: { id: batchId, runId: run.id },
    });
    const timeoutSeconds =
      node.config.timeoutSeconds === null ||
      node.config.timeoutSeconds === undefined
        ? null
        : Number(node.config.timeoutSeconds);
    return {
      output: { questionBatchId: batchId },
      wait: {
        kind: "HUMAN",
        externalKey: batchId,
        timeoutAt:
          timeoutSeconds === null
            ? null
            : new Date(Date.now() + timeoutSeconds * 1_000),
      },
    };
  }

  private async parkAttempt(
    attempt: WorkflowStepAttempt,
    result: WorkflowExecutionResult,
  ): Promise<void> {
    const wait = result.wait;
    if (!wait) throw new Error("Workflow wait is missing");
    const prisma = await getPrismaClient();
    const waitId = randomUUID();
    await prisma.$transaction(async (transaction) => {
      await transaction.workflowStepAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "WAITING",
          phase: wait.kind,
          outputJson: JSON.stringify({
            value: result.output,
            selectedHandles: result.selectedHandles,
            sessionPatch: result.sessionPatch,
          }),
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      await transaction.workflowWait.create({
        data: {
          id: waitId,
          runId: attempt.runId,
          attemptId: attempt.id,
          kind: wait.kind,
          predicateJson: wait.predicate ? JSON.stringify(wait.predicate) : null,
          externalKey: wait.externalKey ?? null,
          resumeAfter: wait.resumeAfter ?? null,
          timeoutAt: wait.timeoutAt ?? null,
        },
      });
      if (result.links?.length) {
        await transaction.workflowRunResourceLink.createMany({
          data: result.links.map((link) => ({
            id: randomUUID(),
            runId: attempt.runId,
            attemptId: attempt.id,
            kind: link.kind.toUpperCase(),
            resourceId: link.resourceId,
            label: link.label ?? null,
            url: link.url ?? null,
            metadataJson: link.metadata ? JSON.stringify(link.metadata) : null,
          })),
        });
      }
      await transaction.workflowRun.update({
        where: { id: attempt.runId },
        data: { status: "WAITING", phase: wait.kind },
      });
      await transaction.workflowResourceLease.deleteMany({
        where: { attemptId: attempt.id },
      });
    });
    await this.appendEvent(
      attempt.runId,
      attempt.id,
      "STEP_WAITING",
      `Step is waiting for ${wait.kind.toLowerCase().replaceAll("_", " ")}`,
      { waitId },
    );
    publishRunChanged(attempt.runId);
  }

  private async completeAttempt(
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    result: WorkflowExecutionResult,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findUnique({
        where: { id: attempt.runId },
      });
      if (!run) throw new Error("Workflow run disappeared");
      let sessionData = workflowSessionData(run.sessionDataJson);
      if (attempt.iterationKey) {
        sessionData = setSessionValue(
          sessionData,
          `steps.${node.id}.iterations.${attempt.iterationKey.replaceAll(".", "_")}`,
          {
            status: "SUCCEEDED",
            output: result.output ?? null,
            data: result.sessionPatch ?? null,
          },
        );
      } else {
        if (result.sessionPatch) {
          sessionData = mergeSessionData(sessionData, result.sessionPatch);
        }
        sessionData = setSessionValue(sessionData, `steps.${node.id}`, {
          status: "SUCCEEDED",
          output: result.output ?? null,
          snapshotId:
            result.links?.find(({ kind }) => kind === "CHECKPOINT")
              ?.resourceId ?? null,
        });
      }
      const serialized = JSON.stringify(sessionData);
      assertSize(serialized, "Workflow session data", MAX_SESSION_BYTES);
      await transaction.workflowStepAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "SUCCEEDED",
          phase: "SUCCEEDED",
          outputJson: JSON.stringify({
            value: result.output,
            selectedHandles: result.selectedHandles,
            sessionPatch: result.sessionPatch,
          }),
          error: null,
          finishedAt: new Date(),
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      if (result.links?.length) {
        await transaction.workflowRunResourceLink.createMany({
          data: result.links.map((link) => ({
            id: randomUUID(),
            runId: attempt.runId,
            attemptId: attempt.id,
            kind: link.kind.toUpperCase(),
            resourceId: link.resourceId,
            label: link.label ?? null,
            url: link.url ?? null,
            metadataJson: link.metadata ? JSON.stringify(link.metadata) : null,
          })),
        });
      }
      await transaction.workflowRun.update({
        where: { id: attempt.runId },
        data: {
          sessionDataJson: serialized,
          sessionRevision: { increment: 1 },
          status: "RUNNING",
          phase: "SCHEDULING",
        },
      });
      await transaction.workflowResourceLease.deleteMany({
        where: { attemptId: attempt.id },
      });
    });
    await this.appendEvent(
      attempt.runId,
      attempt.id,
      "STEP_SUCCEEDED",
      `Step ${node.name ?? node.id} completed`,
    );
    publishRunChanged(attempt.runId);
  }

  private async failAttempt(
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition | null,
    error: Error,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const definitionNode =
      node ??
      (
        await prisma.workflowRun.findUnique({
          where: { id: attempt.runId },
          include: { version: true },
        })
      )?.version.definitionJson;
    const resolvedNode =
      typeof definitionNode === "string"
        ? (parseWorkflowDefinition(json(definitionNode)).nodes.find(
            ({ id }) => id === attempt.nodeId,
          ) ?? null)
        : definitionNode;
    const retry = resolvedNode?.retry;
    const shouldRetry = Boolean(
      retry && attempt.attempt + 1 < retry.maxAttempts,
    );
    const delaySeconds = retry
      ? Math.min(
          86_400,
          retry.strategy === "EXPONENTIAL"
            ? retry.delaySeconds * 2 ** attempt.attempt
            : retry.delaySeconds,
        )
      : 0;
    await prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findUnique({
        where: { id: attempt.runId },
      });
      if (!run) return;
      let sessionData = workflowSessionData(run.sessionDataJson);
      if (!attempt.iterationKey) {
        sessionData = setSessionValue(sessionData, `steps.${attempt.nodeId}`, {
          status: "FAILED",
          error: error.message,
        });
      }
      await transaction.workflowStepAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "FAILED",
          phase: shouldRetry ? "RETRY_SCHEDULED" : "FAILED",
          error: error.message.slice(0, 20_000),
          finishedAt: new Date(),
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      if (shouldRetry) {
        await transaction.workflowWait.create({
          data: {
            id: randomUUID(),
            runId: attempt.runId,
            attemptId: attempt.id,
            kind: "RETRY",
            resumeAfter: new Date(Date.now() + delaySeconds * 1_000),
          },
        });
      }
      await transaction.workflowRun.update({
        where: { id: attempt.runId },
        data: {
          sessionDataJson: JSON.stringify(sessionData),
          sessionRevision: { increment: 1 },
          status: shouldRetry ? "WAITING" : "RUNNING",
          phase: shouldRetry ? "RETRY_WAIT" : "SCHEDULING",
        },
      });
      await transaction.workflowResourceLease.deleteMany({
        where: { attemptId: attempt.id },
      });
    });
    await this.appendEvent(
      attempt.runId,
      attempt.id,
      shouldRetry ? "STEP_RETRY_SCHEDULED" : "STEP_FAILED",
      shouldRetry
        ? `Step failed and will retry in ${delaySeconds} seconds`
        : `Step failed: ${error.message}`,
      { error: error.message, retry: shouldRetry },
    );
    publishRunChanged(attempt.runId);
  }

  private async resolveDueWaits(): Promise<void> {
    const prisma = await getPrismaClient();
    const now = new Date();
    const waits = await prisma.workflowWait.findMany({
      where: {
        status: "PENDING",
        OR: [{ resumeAfter: { lte: now } }, { timeoutAt: { lte: now } }],
      },
      include: {
        attempt: { include: { run: { include: { version: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const wait of waits) {
      if (
        wait.timeoutAt &&
        wait.timeoutAt <= now &&
        wait.kind !== "RETRY" &&
        wait.kind !== "DELAY"
      ) {
        await prisma.workflowWait.update({
          where: { id: wait.id },
          data: { status: "TIMED_OUT", resolvedAt: now },
        });
        await this.failAttempt(
          wait.attempt,
          parseWorkflowDefinition(
            json(wait.attempt.run.version.definitionJson),
          ).nodes.find(({ id }) => id === wait.attempt.nodeId) ?? null,
          new Error("Workflow wait timed out"),
        );
        continue;
      }
      if (wait.kind === "RETRY") {
        const nextAttempt = wait.attempt.attempt + 1;
        await prisma.$transaction([
          prisma.workflowWait.update({
            where: { id: wait.id },
            data: { status: "RESOLVED", resolvedAt: now },
          }),
          prisma.workflowStepAttempt.create({
            data: {
              id: randomUUID(),
              runId: wait.runId,
              nodeId: wait.attempt.nodeId,
              kind: wait.attempt.kind,
              generation: wait.attempt.generation,
              iterationKey: wait.attempt.iterationKey,
              attempt: nextAttempt,
              status: "PENDING",
              phase: "RETRY_PENDING",
              inputJson: wait.attempt.inputJson,
              requiredPathsJson: wait.attempt.requiredPathsJson,
              providedPathsJson: wait.attempt.providedPathsJson,
              idempotencyKey: `${wait.runId}:${wait.attempt.nodeId}:${wait.attempt.generation}:${wait.attempt.iterationKey}:${nextAttempt}`,
              replayedFromId: wait.attempt.id,
            },
          }),
          prisma.workflowRun.update({
            where: { id: wait.runId },
            data: { status: "RUNNING", phase: "SCHEDULING" },
          }),
        ]);
        publishRunChanged(wait.runId);
      } else if (wait.kind === "DELAY") {
        await prisma.workflowWait.update({
          where: { id: wait.id },
          data: { status: "RESOLVED", resolvedAt: now },
        });
        await this.completeWaitingAttempt(wait.attemptId, { delayed: true });
      } else if (wait.kind === "PREDICATE") {
        const predicate = wait.predicateJson
          ? parseObject(json(wait.predicateJson), "Wait predicate")
          : {};
        const condition = predicate.condition as WorkflowCondition | undefined;
        const data = workflowSessionData(wait.attempt.run.sessionDataJson);
        if (condition && evaluateWorkflowCondition(condition, data)) {
          await prisma.workflowWait.update({
            where: { id: wait.id },
            data: {
              status: "RESOLVED",
              resultJson: JSON.stringify({ matched: true }),
              resolvedAt: now,
            },
          });
          await this.completeWaitingAttempt(wait.attemptId, { matched: true });
        } else {
          const cadenceSeconds = Math.max(
            1,
            Number(predicate.cadenceSeconds ?? 15),
          );
          await prisma.workflowWait.update({
            where: { id: wait.id },
            data: {
              resumeAfter: new Date(Date.now() + cadenceSeconds * 1_000),
            },
          });
        }
      } else if (wait.externalKey && this.waitPollers.has(wait.kind)) {
        const polled = await this.waitPollers.get(wait.kind)!(wait.externalKey);
        if (polled.pending) {
          await prisma.workflowWait.update({
            where: { id: wait.id },
            data: {
              resumeAfter: new Date(
                Date.now() + Math.max(1, polled.pollAfterSeconds ?? 15) * 1_000,
              ),
            },
          });
        } else {
          await prisma.workflowWait.update({
            where: { id: wait.id },
            data: {
              status: polled.error ? "FAILED" : "RESOLVED",
              resultJson: JSON.stringify(polled.result ?? {}),
              resolvedAt: new Date(),
            },
          });
          if (polled.error) {
            const node = parseWorkflowDefinition(
              json(wait.attempt.run.version.definitionJson),
            ).nodes.find(({ id }) => id === wait.attempt.nodeId);
            await this.failAttempt(
              wait.attempt,
              node ?? null,
              new Error(polled.error),
            );
          } else {
            await this.completeWaitingAttempt(
              wait.attemptId,
              polled.result ?? {},
            );
          }
        }
      }
    }
  }

  private async completeWaitingAttempt(
    attemptId: string,
    output: unknown,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const attempt = await prisma.workflowStepAttempt.findUnique({
      where: { id: attemptId },
      include: { run: { include: { version: true } } },
    });
    if (!attempt || attempt.status !== "WAITING") return;
    const node = parseWorkflowDefinition(
      json(attempt.run.version.definitionJson),
    ).nodes.find(({ id }) => id === attempt.nodeId);
    if (!node) throw new Error("Workflow step definition is missing");
    const pending = this.attemptOutput(attempt) as {
      value?: unknown;
      selectedHandles?: string[];
      sessionPatch?: SessionData;
    };
    let sessionPatch = pending.sessionPatch;
    if (
      node.kind === "TERMINAL_RUN" &&
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      (output as Record<string, unknown>).sessionData &&
      typeof (output as Record<string, unknown>).sessionData === "object" &&
      !Array.isArray((output as Record<string, unknown>).sessionData)
    ) {
      const terminalData = structuredClone(
        (output as Record<string, unknown>).sessionData,
      ) as SessionData;
      const identity = getSessionValue(
        workflowSessionData(attempt.run.sessionDataJson),
        "workflow",
      );
      sessionPatch = identity
        ? setSessionValue(terminalData, "workflow", identity)
        : terminalData;
    }
    if (
      output &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      (output as Record<string, unknown>).sessionPatch &&
      typeof (output as Record<string, unknown>).sessionPatch === "object" &&
      !Array.isArray((output as Record<string, unknown>).sessionPatch)
    ) {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        (output as Record<string, unknown>).sessionPatch as SessionData,
      );
    }
    if (
      node.kind.startsWith("RUN_") &&
      output &&
      typeof output === "object" &&
      !Array.isArray(output)
    ) {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        setSessionValue({}, `run.${node.id}`, output),
      );
    }
    if (
      node.kind === "BUILD_START" &&
      output &&
      typeof output === "object" &&
      !Array.isArray(output)
    ) {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        setSessionValue({}, "build", output),
      );
    }
    if (
      node.kind === "WORKTREE_WAIT_PUSH_READY" &&
      output &&
      typeof output === "object" &&
      !Array.isArray(output)
    ) {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        setSessionValue({}, "worktree", output),
      );
    }
    if (node.kind === "HUMAN_CONFIRM" || node.kind === "HUMAN_CHOICE") {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        setSessionValue({}, `steps.${node.id}.answer`, output),
      );
    }
    await this.completeAttempt(attempt, node, {
      output: output ?? pending.value,
      selectedHandles: pending.selectedHandles,
      sessionPatch,
    });
  }

  async resolveExternalWait(
    kind: string,
    externalKey: string,
    result: Record<string, unknown>,
    error: string | null = null,
  ): Promise<number> {
    const prisma = await getPrismaClient();
    const waits = await prisma.workflowWait.findMany({
      where: {
        kind,
        externalKey,
        status: "PENDING",
      },
      include: {
        attempt: { include: { run: { include: { version: true } } } },
      },
    });
    for (const wait of waits) {
      await prisma.workflowWait.update({
        where: { id: wait.id },
        data: {
          status: error ? "FAILED" : "RESOLVED",
          resultJson: JSON.stringify(result),
          resolvedAt: new Date(),
        },
      });
      if (error) {
        const node = parseWorkflowDefinition(
          json(wait.attempt.run.version.definitionJson),
        ).nodes.find(({ id }) => id === wait.attempt.nodeId);
        await this.failAttempt(wait.attempt, node ?? null, new Error(error));
      } else {
        await this.completeWaitingAttempt(wait.attemptId, result);
      }
    }
    return waits.length;
  }

  private descendants(
    definition: WorkflowDefinition,
    nodeId: string,
  ): string[] {
    const outgoing = new Map<string, string[]>();
    for (const edge of definition.edges) {
      outgoing.set(edge.source, [
        ...(outgoing.get(edge.source) ?? []),
        edge.target,
      ]);
    }
    const found = new Set<string>([nodeId]);
    const pending = [nodeId];
    while (pending.length) {
      const current = pending.shift()!;
      for (const target of outgoing.get(current) ?? []) {
        if (found.has(target)) continue;
        found.add(target);
        pending.push(target);
      }
    }
    return [...found];
  }

  async prepareReplay(
    runId: string,
    nodeId: string,
  ): Promise<WorkflowReplayPreview> {
    const prisma = await getPrismaClient();
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: {
        version: true,
        attempts: {
          include: { checkpoints: true, resourceLinks: true },
        },
      },
    });
    if (!run) throw new Error("Workflow run not found");
    if (
      !new Set(["PAUSED", "BLOCKED", "FAILED", "SUCCEEDED", "CANCELLED"]).has(
        run.status,
      )
    ) {
      throw new Error("Pause the workflow before replaying a step");
    }
    const definition = parseWorkflowDefinition(
      json(run.version.definitionJson),
    );
    if (!definition.nodes.some(({ id }) => id === nodeId)) {
      throw new Error("Workflow step not found");
    }
    const affectedNodeIds = this.descendants(definition, nodeId);
    const attempts = run.attempts.filter(
      ({ generation, nodeId: candidate }) =>
        generation === run.generation && affectedNodeIds.includes(candidate),
    );
    const selected = attempts
      .filter((attempt) => attempt.nodeId === nodeId)
      .sort((left, right) => right.attempt - left.attempt)[0];
    const checkpoint = selected?.checkpoints
      .slice()
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )[0];
    const externalEffects = attempts.flatMap((attempt) =>
      attempt.resourceLinks
        .filter(({ kind }) => kind !== "CHECKPOINT")
        .map(({ kind, resourceId, label, url }) => ({
          kind,
          resourceId,
          label,
          url,
        })),
    );
    let gitComparison: Record<string, unknown> | null = null;
    let comparisonWarning: string | null = null;
    if (checkpoint && this.agentControl) {
      try {
        gitComparison = await this.compareCheckpointWithAgent(checkpoint.id);
      } catch (error) {
        comparisonWarning = `Git comparison unavailable: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      runId,
      nodeId,
      affectedNodeIds,
      affectedAttemptIds: attempts.map(({ id }) => id),
      externalEffects,
      checkpointId: checkpoint?.id ?? null,
      gitComparison,
      warning:
        [
          externalEffects.length
            ? "External Jira, GitHub, build, deployment, and notification effects will not be undone."
            : null,
          comparisonWarning,
        ]
          .filter(Boolean)
          .join(" ") || null,
    };
  }

  async replay(
    runId: string,
    nodeId: string,
    options: { restore?: boolean | null; stash?: boolean | null } = {},
  ) {
    const preview = await this.prepareReplay(runId, nodeId);
    if (options.restore) {
      if (!preview.checkpointId) {
        throw new Error(
          "No restorable Git checkpoint is available for this step",
        );
      }
      if (this.checkpointRestorer) {
        await this.checkpointRestorer(preview.checkpointId, {
          stash: Boolean(options.stash),
        });
      } else {
        await this.restoreCheckpointWithAgent(preview.checkpointId, {
          stash: Boolean(options.stash),
        });
      }
    }
    const prisma = await getPrismaClient();
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      include: { version: true, attempts: true },
    });
    if (!run) throw new Error("Workflow run not found");
    const definition = parseWorkflowDefinition(
      json(run.version.definitionJson),
    );
    const selected = run.attempts
      .filter(
        (attempt) =>
          attempt.generation === run.generation && attempt.nodeId === nodeId,
      )
      .sort((left, right) => right.attempt - left.attempt)[0];
    if (!selected) throw new Error("Selected step has no execution history");
    const snapshot = selected.inputJson
      ? parseObject(json(selected.inputJson), "Step input snapshot")
      : workflowSessionData(run.sessionDataJson);
    const nextGeneration = run.generation + 1;
    const currentByNode = new Map<string, WorkflowStepAttempt>();
    for (const attempt of run.attempts.filter(
      ({ generation, iterationKey }) =>
        generation === run.generation && !iterationKey,
    )) {
      const existing = currentByNode.get(attempt.nodeId);
      if (!existing || existing.attempt < attempt.attempt) {
        currentByNode.set(attempt.nodeId, attempt);
      }
    }
    const sessionData = setSessionValue(snapshot, "workflow.replay", {
      generation: nextGeneration,
      fromNodeId: nodeId,
      replayedAt: new Date().toISOString(),
    });
    await prisma.$transaction(async (transaction) => {
      await transaction.workflowStepAttempt.updateMany({
        where: {
          runId,
          generation: run.generation,
          nodeId: { in: preview.affectedNodeIds },
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });
      await transaction.workflowStepAttempt.createMany({
        data: definition.nodes.map((node) => {
          const affected = preview.affectedNodeIds.includes(node.id);
          const previous = currentByNode.get(node.id);
          return {
            id: randomUUID(),
            runId,
            nodeId: node.id,
            kind: node.kind,
            generation: nextGeneration,
            iterationKey: "",
            attempt: 0,
            status: affected
              ? "PENDING"
              : previous?.status === "SKIPPED"
                ? "SKIPPED"
                : "SUCCEEDED",
            phase: affected ? "REPLAY_PENDING" : "REUSED_FROM_PRIOR_GENERATION",
            inputJson: affected ? null : previous?.inputJson,
            outputJson: affected ? null : previous?.outputJson,
            error: null,
            startedAt: affected ? null : previous?.startedAt,
            finishedAt: affected ? null : new Date(),
            requiredPathsJson: JSON.stringify(nodeRequiredPaths(node)),
            providedPathsJson: JSON.stringify(nodeProvidedPaths(node)),
            idempotencyKey: `${runId}:${node.id}:${nextGeneration}::0`,
            replayedFromId: previous?.id ?? null,
          };
        }),
      });
      await transaction.workflowWait.updateMany({
        where: { runId, status: "PENDING" },
        data: { status: "SUPERSEDED", resolvedAt: new Date() },
      });
      await transaction.workflowRun.update({
        where: { id: runId },
        data: {
          generation: nextGeneration,
          sessionDataJson: JSON.stringify(sessionData),
          sessionRevision: { increment: 1 },
          status: "RUNNING",
          phase: "REPLAYING",
          blockedReason: null,
          error: null,
          pausedAt: null,
          finishedAt: null,
        },
      });
    });
    await this.appendEvent(
      runId,
      null,
      "RUN_REPLAYED",
      `Replaying from step ${nodeId}`,
      { generation: nextGeneration, affectedNodeIds: preview.affectedNodeIds },
    );
    publishRunChanged(runId);
    return this.run(runId);
  }

  private async appendEvent(
    runId: string,
    attemptId: string | null,
    type: string,
    message: string,
    detail: Record<string, unknown> | null = null,
  ) {
    const prisma = await getPrismaClient();
    const event = await prisma.$transaction(async (transaction) => {
      const last = await transaction.workflowRunEvent.findFirst({
        where: { runId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      return transaction.workflowRunEvent.create({
        data: {
          id: randomUUID(),
          runId,
          attemptId,
          sequence: (last?.sequence ?? -1) + 1,
          type,
          message: message.slice(0, 20_000),
          detailJson: detail ? JSON.stringify(detail) : null,
        },
      });
    });
    agentEventBus.publish(runEventTopic(runId), {
      workflowRunEventAdded: event,
    });
    return event;
  }

  subscribeWorkflows() {
    return agentEventBus.iterate<{ workflowChanged: { id: string } }>(
      WORKFLOWS_CHANGED_TOPIC,
    );
  }

  subscribeRun(runId: string) {
    return agentEventBus.iterate<{ workflowRunChanged: { id: string } }>(
      runTopic(runId),
    );
  }

  subscribeRunEvents(runId: string) {
    return agentEventBus.iterate<{ workflowRunEventAdded: unknown }>(
      runEventTopic(runId),
    );
  }

  subscribeRunQuestions(runId: string) {
    return agentEventBus.iterate<{
      workflowQuestionChanged: { id: string; runId: string };
    }>(runQuestionTopic(runId));
  }
}
