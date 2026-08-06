import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { BUILD_CONFIGURATION_ICON_KEYS } from "@ai-development-environment/agent-contract/builds";

import type {
  Prisma,
  Workflow,
  WorkflowRun,
  WorkflowStepAttempt,
  WorkflowTrigger,
  WorkflowVersion,
  WorkflowWait,
} from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import {
  emptyWorkflowDefinition,
  hasWorkflowErrors,
  isChoiceTriggerKind,
  isResourceTriggerKind,
  parseWorkflowDefinition,
  sanitizeWorkflowExportDefinition,
  validateWorkflowDefinition,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_STEP_BY_KIND,
  WORKFLOW_STEP_CATALOG,
  WORKFLOW_TRIGGER_CATALOG,
  workflowResourceKind,
  workflowTriggerChoices,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowNodeDefinition,
} from "@/lib/workflows/definition";
import {
  COMMAND_OUTPUT_MATCH_BUFFER_BYTES,
  commandOutputMatchMode,
  commandOutputPattern,
  type CommandOutputMatchMode,
} from "@/lib/workflows/command-output-match";
import { compileCommandOutputPattern } from "@/lib/workflows/command-output-match.server";
import {
  evaluateWorkflowCondition,
  getSessionValue,
  hasSessionValue,
  mergeSessionData,
  resolveWorkflowValue,
  setSessionValue,
  workflowSessionData,
  type SessionData,
  type WorkflowCondition,
} from "@/lib/workflows/session";
import { isCodebaseBusyError } from "@/lib/codebase-busy";
import { requiredConfigSessionPaths } from "@/lib/workflows/config-descriptors";
import {
  waitCadenceSeconds,
  waitElapsedText,
  waitKindText,
  waitResumeAfter,
  waitTimeoutAt,
} from "@/lib/workflows/wait-timing";
import { workflowTriggerResourceLink } from "@/lib/workflows/resources";
import {
  WORKFLOW_QUICK_ACTION_KINDS,
  type WorkflowQuickActionKind,
} from "@/lib/workflows/kinds";
import {
  agentOnlineWindowMs,
  agentEventBus,
  COMMAND_RUN_OUTPUT_CHANGED_TOPIC,
  SIDEBAR_STATUS_CHANGED_TOPIC,
  type AgentControlService,
} from "@/services/agent-control";
import type { CredentialService } from "@/services/credentials";
import type { NotificationsService } from "@/services/notifications";
import type { RunsService } from "@/services/runs";
import type { CommandsService } from "@/services/commands";
import type { JiraService } from "@/services/jira";
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
  type WorkflowWaitInput,
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
const SCHEDULING_RUN_STATUSES = new Set(["RUNNING", "WAITING"]);
const MAX_DEFINITION_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_BYTES = 2 * 1024 * 1024;
const GLOBAL_CONCURRENCY = 4;
const CLAIM_TTL_MS = 5 * 60_000;
const RESOURCE_HOLD_TIMEOUT_MS = 10 * 60_000;
const ANSWER_REVISION_LEASE_PURPOSE = "ANSWER_REVISION";
const EXCLUSIVE_WORKTREE_IDENTITY_MUTATION_STEPS = new Set([
  "WORKTREE_CREATE",
  "WORKTREE_DELETE",
  "WORKTREE_MOVE",
  "WORKTREE_MOVE_CONTROL",
]);

type CommandMatchCursor = {
  pattern: string;
  mode: CommandOutputMatchMode;
  matchCount: number;
  matched: boolean;
  scanAttempt: number;
  scanCharacterOffset: number;
  observedAttempt: number;
  observedSequence: number;
};

type CommandMatchResult = {
  ordinal: number;
  text: string;
  captures: Array<string | null>;
  namedCaptures: Record<string, string | null>;
  commandRunId: string;
  commandAttempt: number;
  start: { sequence: number; offset: number };
  end: { sequence: number; offset: number };
};

type CommandOutputRow = {
  sequence: number;
  stream: string;
  dataBase64: string;
  byteLength: number;
  attempt: { attempt: number; runId: string };
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function commandMatchCursor(
  predicateJson: string | null,
): CommandMatchCursor | null {
  if (!predicateJson) return null;
  const predicate = recordValue(json<unknown>(predicateJson));
  const raw = recordValue(predicate.outputMatch);
  if (typeof raw.pattern !== "string" || !raw.pattern) return null;
  return {
    pattern: raw.pattern,
    mode: commandOutputMatchMode({ outputMatchMode: raw.mode }),
    matchCount: Number.isInteger(raw.matchCount) ? Number(raw.matchCount) : 0,
    matched: raw.matched === true,
    scanAttempt:
      Number.isInteger(raw.scanAttempt) && Number(raw.scanAttempt) > 0
        ? Number(raw.scanAttempt)
        : 1,
    scanCharacterOffset:
      Number.isInteger(raw.scanCharacterOffset) &&
      Number(raw.scanCharacterOffset) >= 0
        ? Number(raw.scanCharacterOffset)
        : 0,
    observedAttempt:
      Number.isInteger(raw.observedAttempt) && Number(raw.observedAttempt) >= 0
        ? Number(raw.observedAttempt)
        : 0,
    observedSequence: Number.isInteger(raw.observedSequence)
      ? Number(raw.observedSequence)
      : -1,
  };
}

function commandMatchPredicate(
  predicateJson: string | null,
  cursor: CommandMatchCursor,
): string {
  const predicate = predicateJson
    ? recordValue(json<unknown>(predicateJson))
    : {};
  return JSON.stringify({
    ...predicate,
    outputMatch: cursor,
  });
}

function sessionWorktreeId(sessionData: SessionData): string | null {
  const value = getSessionValue(sessionData, "worktree.id");
  return typeof value === "string" && value ? value : null;
}

function assertExclusiveWorktreeUnchanged(
  run: Pick<WorkflowRun, "exclusiveWorktree" | "worktreeId">,
  sessionData: SessionData,
): void {
  if (
    run.exclusiveWorktree &&
    sessionWorktreeId(sessionData) !== run.worktreeId
  ) {
    throw new Error(
      "Exclusive workflows cannot change worktrees; start a new workflow on the target worktree instead",
    );
  }
}

function queueEntryPrecedes(
  leftAt: Date,
  leftId: string,
  rightAt: Date,
  rightId: string,
): boolean {
  const difference = leftAt.getTime() - rightAt.getTime();
  return difference < 0 || (difference === 0 && leftId < rightId);
}

type WorkflowWithActiveVersion = Workflow & {
  activeVersion: WorkflowVersion | null;
};

export type CreateWorkflowInput = {
  name: string;
  description?: string | null;
  definition?: unknown;
  overlapPolicy?: string | null;
  overlapScope?: string | null;
  maxConcurrentRuns?: number | null;
  completionNotificationsEnabled?: boolean | null;
  exclusiveWorktree?: boolean | null;
  worktreeConcurrency?: string | null;
  blocksGitOperations?: boolean | null;
};

export type SaveWorkflowDraftInput = {
  id: string;
  definition: unknown;
  overlapPolicy?: string | null;
  overlapScope?: string | null;
  maxConcurrentRuns?: number | null;
  completionNotificationsEnabled?: boolean | null;
  exclusiveWorktree?: boolean | null;
  worktreeConcurrency?: string | null;
  blocksGitOperations?: boolean | null;
};

export type TriggerWorkflowInput = {
  workflowId: string;
  sessionData?: Record<string, unknown> | null;
  resourceKind?: string | null;
  resourceId?: string | null;
  subjectKey?: string | null;
  /** Key of the option picked on a choice trigger; null runs the plain one. */
  choice?: string | null;
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
  worktreeConcurrency: string;
  worktreeConcurrencyLimit: number | null;
};

export type WorkflowWaitPollResult = {
  pending: boolean;
  result?: Record<string, unknown>;
  error?: string | null;
  pollAfterSeconds?: number;
};

const json = <T>(value: string): T => JSON.parse(value) as T;

type SessionAgentSource = {
  id: string;
  name: string;
  hostname: string;
  lastSeenAt?: Date | null;
  disconnectedAt?: Date | null;
  heartbeatIntervalSeconds?: number | null;
  diskFreeBytes?: number | null;
  memoryFreeBytes?: number | null;
};

type SessionCodebaseSource = {
  id: string;
  folder: string;
  agentId: string;
  branch: string | null;
  headSha: string | null;
  defaultBranch: string | null;
  agent: SessionAgentSource;
  repository: {
    id: string;
    name: string;
    canonicalOrigin: string;
    displayOrigin: string;
  };
};

function agentSessionData(agent: SessionAgentSource): SessionData {
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      hostname: agent.hostname,
      ...(agent.lastSeenAt !== undefined && agent.disconnectedAt !== undefined
        ? {
            connected:
              agent.lastSeenAt !== null &&
              agent.disconnectedAt === null &&
              Date.now() - agent.lastSeenAt.getTime() <=
                agentOnlineWindowMs(agent),
          }
        : {}),
      ...(agent.diskFreeBytes !== undefined
        ? { diskFreeBytes: agent.diskFreeBytes }
        : {}),
      ...(agent.memoryFreeBytes !== undefined
        ? { memoryFreeBytes: agent.memoryFreeBytes }
        : {}),
    },
  };
}

function codebaseSessionData(codebase: SessionCodebaseSource): SessionData {
  return mergeSessionData(agentSessionData(codebase.agent), {
    codebase: {
      id: codebase.id,
      folder: codebase.folder,
      agentId: codebase.agentId,
      branch: codebase.branch,
      headSha: codebase.headSha,
    },
    repo: {
      id: codebase.repository.id,
      name: codebase.repository.name,
      url: codebase.repository.displayOrigin,
      canonicalOrigin: codebase.repository.canonicalOrigin,
      displayOrigin: codebase.repository.displayOrigin,
      defaultBranch: codebase.defaultBranch,
    },
  });
}

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

function overlapScope(value: string | null | undefined): string {
  const normalized = value?.trim().toUpperCase() || "WORKTREE";
  if (!new Set(["WORKTREE", "GLOBAL"]).has(normalized)) {
    throw new Error("Workflow overlap scope is not supported");
  }
  return normalized;
}

const WORKTREE_CONCURRENCY_MODES = [
  "EXCLUSIVE",
  "NON_EXCLUSIVE",
  "EXCLUDED",
] as const;

function worktreeConcurrency(
  value: string | null | undefined,
  legacyExclusive?: boolean | null,
): (typeof WORKTREE_CONCURRENCY_MODES)[number] {
  const normalized =
    value?.trim().toUpperCase() ||
    (legacyExclusive === true ? "EXCLUSIVE" : "NON_EXCLUSIVE");
  if (!WORKTREE_CONCURRENCY_MODES.includes(normalized as never)) {
    throw new Error("Workflow worktree concurrency is not supported");
  }
  return normalized as (typeof WORKTREE_CONCURRENCY_MODES)[number];
}

function workflowGitBlocking(
  mode: string,
  requested?: boolean | null,
): boolean {
  return mode === "EXCLUSIVE" ? true : (requested ?? false);
}

/**
 * The runs an overlap policy is measured against. `WORKTREE` keeps each
 * worktree's runs in their own queue — two worktrees never wait on each other,
 * and runs that belong to no worktree share a queue of their own.
 */
function overlapScopeFilter(
  scope: string,
  worktreeId: string | null,
): { worktreeId?: string | null } {
  return scope === "WORKTREE" ? { worktreeId } : {};
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
  agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
    sidebarStatusChanged: true,
  });
}

/**
 * What must be in session data before the step may run. Config bindings count
 * only where the descriptor marks the key required — an optional one resolves to
 * nothing and the adapter carries on, so blocking on it would strand a run over
 * a value the step never needed (see `requiredConfigSessionPaths`).
 */
function nodeRequiredPaths(node: WorkflowNodeDefinition): string[] {
  const catalog = WORKFLOW_STEP_BY_KIND.get(node.kind)!;
  return [
    ...catalog.requiredPaths.map((path) =>
      path.replaceAll("<stepId>", node.id),
    ),
    ...node.requiredPaths,
    ...requiredConfigSessionPaths(node.kind, "step", node.config),
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

/**
 * What freed a parked step: the external actor's own completion callback
 * (`PUSH`), the runtime's poll sweep (`POLL`), an operator answering a question
 * (`HUMAN`), or the delay simply elapsing (`TIMER`).
 */
type WaitResolutionSource = "PUSH" | "POLL" | "HUMAN" | "TIMER";

/**
 * What the run timeline says when a step parks on something external.
 *
 * The step is named the same way {@link WorkflowsService.completeAttempt} names
 * it, so a reader scanning the timeline sees one step's story rather than an
 * anonymous "step is waiting" between two named completions. Time-based waits
 * also name their target instant: "waiting for delay" on its own leaves a
 * reader counting against a number the event never showed.
 */
function waitingMessage(
  node: WorkflowNodeDefinition,
  wait: WorkflowWaitInput,
): string {
  const step = node.name ?? node.id;
  const target = waitKindText(wait.kind);
  return wait.kind === "DELAY" && wait.resumeAfter
    ? `Step ${step} is waiting for ${target} until ${wait.resumeAfter.toISOString()}`
    : `Step ${step} is waiting for ${target}`;
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

function workflowTriggerDeliveryId(
  dedupeKey: string,
  workflowId: string,
  triggerNodeId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([dedupeKey, workflowId, triggerNodeId]))
    .digest("hex");
}

export class WorkflowsService {
  private runtimeTimer?: ReturnType<typeof setInterval>;
  private commandOutputStream?: AsyncIterableIterator<unknown>;
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
    private readonly worktrees?: {
      ticketKeyForWorktree(id: string): Promise<string | null>;
      workflowSessionDataForWorktree?(
        id: string,
        options?: { includeMissing?: boolean },
      ): Promise<Record<string, unknown>>;
      workflowSessionDataForPullRequest?(
        owner: string,
        repository: string,
        number: number,
      ): Promise<Record<string, unknown>>;
    },
    private readonly commandsService?: CommandsService,
    private readonly jiraService?: JiraService,
  ) {
    this.runsService?.setWorktreeAdmissionPromoter(async () => {
      await this.startQueuedRuns();
    });
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

  private async cancelWaitingCommandRuns(workflowRunId: string): Promise<void> {
    if (!this.commandsService) return;
    const prisma = await getPrismaClient();
    const links = await prisma.workflowRunResourceLink.findMany({
      where: {
        runId: workflowRunId,
        kind: "COMMAND_RUN",
        attempt: { status: "WAITING" },
      },
      select: { resourceId: true },
      distinct: ["resourceId"],
    });
    await Promise.allSettled(
      links.map(({ resourceId }) =>
        this.commandsService!.terminateRun(resourceId),
      ),
    );
  }

  private async promoteWorktreeAdmissions(
    worktreeId: string | null,
  ): Promise<void> {
    if (!worktreeId) return;
    try {
      await this.runsService?.reconcileQueuedRuns();
      await this.startQueuedRuns();
    } catch (error) {
      console.error(
        `Could not promote worktree queue for ${worktreeId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * A run reaches its worktree through session data rather than a column, so
   * the tint has to be resolved from `worktree.id` on demand. Reading the
   * worktree live rather than snapshotting the colour into session data keeps
   * recolouring a worktree from stranding its runs on the old tint.
   */
  async runWorktree(sessionDataJson: string) {
    const worktreeId = getSessionValue(
      json<SessionData>(sessionDataJson),
      "worktree.id",
    );
    if (typeof worktreeId !== "string" || !worktreeId) return null;
    const prisma = await getPrismaClient();
    return prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: { id: true, folder: true, branch: true, highlightColor: true },
    });
  }

  /**
   * Prefer the agent snapshot placed in session data when the workflow was
   * triggered. Worktrees can subsequently move, so their current owner is only
   * a fallback for older runs whose session did not include agent metadata.
   */
  async runAgent(sessionDataJson: string) {
    const sessionData = json<SessionData>(sessionDataJson);
    const sessionAgentId =
      getSessionValue(sessionData, "agent.id") ??
      getSessionValue(sessionData, "codebase.agentId");
    const prisma = await getPrismaClient();
    if (typeof sessionAgentId === "string" && sessionAgentId) {
      return prisma.agent.findUnique({ where: { id: sessionAgentId } });
    }
    const worktreeId = getSessionValue(sessionData, "worktree.id");
    if (typeof worktreeId !== "string" || !worktreeId) return null;
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: { codebase: { select: { agent: true } } },
    });
    return worktree?.codebase.agent ?? null;
  }

  private async queueForWorktree(
    worktreeId: string,
  ): Promise<WorktreeRunQueueEntry[]> {
    const prisma = await getPrismaClient();
    const [workflowRuns, agentRuns, exclusiveLease] = await Promise.all([
      prisma.workflowRun.findMany({
        where: { worktreeId, status: "QUEUED" },
        orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          displayNumber: true,
          status: true,
          phase: true,
          queuedAt: true,
          exclusiveWorktree: true,
          worktreeConcurrency: true,
          worktreeLeaseOwnerRunId: true,
          workflowId: true,
          workflow: { select: { name: true } },
          worktree: {
            select: {
              id: true,
              folder: true,
              branch: true,
              highlightColor: true,
            },
          },
        },
      }),
      prisma.agentRun.findMany({
        where: {
          worktreeId,
          origin: "MANAGED",
          status: "QUEUED",
          kind: { in: ["PLAN", "SESSION"] },
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          kind: true,
          displayNumber: true,
          status: true,
          phase: true,
          createdAt: true,
          initialPrompt: true,
          worktreeConcurrencyLimit: true,
          worktree: {
            select: {
              id: true,
              folder: true,
              branch: true,
              highlightColor: true,
            },
          },
          workflowRun: {
            select: {
              id: true,
              workflowId: true,
              worktreeLeaseOwnerRunId: true,
            },
          },
        },
      }),
      prisma.worktreeWorkflowLease.findUnique({
        where: { worktreeId },
        select: { workflowRunId: true },
      }),
    ]);
    const entries = [
      ...workflowRuns.map((run) => ({
        id: run.id,
        kind: "WORKFLOW" as const,
        displayNumber: run.displayNumber,
        name: run.workflow.name,
        status: run.status,
        phase: run.phase,
        worktreeId,
        worktree: run.worktree,
        workflowId: run.workflowId,
        workflowRunId: run.id,
        queuedAt: run.queuedAt,
        exclusiveWorktree: run.exclusiveWorktree,
        worktreeConcurrency: run.worktreeConcurrency,
        worktreeConcurrencyLimit: null,
        leaseOwnerRunId: run.worktreeLeaseOwnerRunId,
      })),
      ...agentRuns.map((run) => ({
        id: run.id,
        kind: run.kind as "PLAN" | "SESSION",
        displayNumber: run.displayNumber,
        name: run.initialPrompt,
        status: run.status,
        phase: run.phase,
        worktreeId,
        worktree: run.worktree,
        workflowId: run.workflowRun?.workflowId ?? null,
        workflowRunId: run.workflowRun?.id ?? null,
        queuedAt: run.createdAt,
        exclusiveWorktree: false,
        worktreeConcurrency: "NON_EXCLUSIVE",
        worktreeConcurrencyLimit: run.worktreeConcurrencyLimit,
        leaseOwnerRunId: run.workflowRun?.worktreeLeaseOwnerRunId ?? null,
      })),
    ].sort((left, right) => {
      if (exclusiveLease) {
        const leftOwned = left.leaseOwnerRunId === exclusiveLease.workflowRunId;
        const rightOwned =
          right.leaseOwnerRunId === exclusiveLease.workflowRunId;
        if (leftOwned !== rightOwned) return leftOwned ? -1 : 1;
      }
      return (
        left.queuedAt.getTime() - right.queuedAt.getTime() ||
        left.id.localeCompare(right.id)
      );
    });
    return entries.map(
      ({ leaseOwnerRunId: _leaseOwnerRunId, ...entry }, index) => ({
        ...entry,
        position: index + 1,
        queuedAt: entry.queuedAt.toISOString(),
      }),
    );
  }

  async runQueue(input: {
    worktreeId?: string | null;
    workflowId?: string | null;
  }): Promise<WorktreeRunQueueEntry[]> {
    if (input.worktreeId) return this.queueForWorktree(input.worktreeId);
    if (!input.workflowId) {
      throw new Error("A worktree or workflow is required to read its queue");
    }
    const prisma = await getPrismaClient();
    const [workflowRuns, agentRuns] = await Promise.all([
      prisma.workflowRun.findMany({
        where: { workflowId: input.workflowId, status: "QUEUED" },
        select: {
          id: true,
          worktreeId: true,
          displayNumber: true,
          status: true,
          phase: true,
          queuedAt: true,
          exclusiveWorktree: true,
          worktreeConcurrency: true,
          workflow: { select: { name: true } },
        },
      }),
      prisma.agentRun.findMany({
        where: {
          origin: "MANAGED",
          status: "QUEUED",
          workflowRun: { workflowId: input.workflowId },
        },
        select: { id: true, worktreeId: true },
      }),
    ]);
    const workflowRunIds = new Set(workflowRuns.map(({ id }) => id));
    const agentRunIds = new Set(agentRuns.map(({ id }) => id));
    const worktreeIds = [
      ...new Set(
        [...workflowRuns, ...agentRuns]
          .map(({ worktreeId }) => worktreeId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const scoped = (
      await Promise.all(worktreeIds.map((id) => this.queueForWorktree(id)))
    )
      .flat()
      .filter((entry) =>
        entry.kind === "WORKFLOW"
          ? workflowRunIds.has(entry.id)
          : agentRunIds.has(entry.id),
      );
    const withoutWorktree = workflowRuns
      .filter(({ worktreeId }) => !worktreeId)
      .sort(
        (left, right) =>
          left.queuedAt.getTime() - right.queuedAt.getTime() ||
          left.id.localeCompare(right.id),
      )
      .map((run, index) => ({
        position: index + 1,
        id: run.id,
        kind: "WORKFLOW" as const,
        displayNumber: run.displayNumber,
        name: run.workflow.name,
        status: run.status,
        phase: run.phase,
        worktreeId: null,
        worktree: null,
        workflowId: input.workflowId!,
        workflowRunId: run.id,
        queuedAt: run.queuedAt.toISOString(),
        exclusiveWorktree: run.exclusiveWorktree,
        worktreeConcurrency: run.worktreeConcurrency,
        worktreeConcurrencyLimit: null,
      }));
    return [...scoped, ...withoutWorktree].sort(
      (left, right) =>
        new Date(left.queuedAt).getTime() -
          new Date(right.queuedAt).getTime() || left.id.localeCompare(right.id),
    );
  }

  async runQueueForWorkflowRun(
    workflowRunId: string,
  ): Promise<WorktreeRunQueueEntry[]> {
    const prisma = await getPrismaClient();
    const run = await prisma.workflowRun.findUnique({
      where: { id: workflowRunId },
      select: { status: true, worktreeId: true, workflowId: true },
    });
    if (!run || run.status !== "QUEUED") return [];
    if (run.worktreeId) return this.queueForWorktree(run.worktreeId);
    return (await this.runQueue({ workflowId: run.workflowId })).filter(
      ({ worktreeId }) => !worktreeId,
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
    const run = await prisma.workflowRun.findUnique({
      where: { id: runId },
      select: {
        sessionDataJson: true,
        workflow: { select: { completionNotificationsEnabled: true } },
      },
    });
    if (
      typeKey === "WORKFLOW_COMPLETED" &&
      run?.workflow.completionNotificationsEnabled === false
    )
      return;
    const worktree = run ? await this.runWorktree(run.sessionDataJson) : null;
    const notification = await prisma.$transaction((transaction) =>
      this.notifications!.recordInTransaction(transaction, {
        dedupeKey: `workflow:${runId}:${dedupeSuffix}`,
        typeKey,
        title,
        body,
        href: `/workflows/runs/${runId}`,
        resourceKind: "WORKFLOW_RUN",
        resourceId: runId,
        worktreeId: worktree?.id ?? null,
        highlightColor: worktree?.highlightColor ?? null,
      }),
    );
    this.notifications.created(notification);
  }

  startRuntime(): void {
    if (this.runtimeTimer) return;
    void this.consumeCommandOutputMatches();
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
    void this.commandOutputStream?.return?.();
    this.commandOutputStream = undefined;
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
        quickActionRepositories: { include: { repository: true } },
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
        quickActionRepositories: { include: { repository: true } },
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
    const concurrency = worktreeConcurrency(
      input.worktreeConcurrency,
      input.exclusiveWorktree,
    );
    const prisma = await getPrismaClient();
    const workflow = await prisma.workflow.create({
      data: {
        id: randomUUID(),
        name,
        description: input.description?.trim() ?? definition.description,
        draftDefinitionJson: serialized,
        draftSchemaVersion: WORKFLOW_SCHEMA_VERSION,
        overlapPolicy: policy,
        overlapScope: overlapScope(input.overlapScope),
        maxConcurrentRuns: concurrentRuns(input.maxConcurrentRuns, policy),
        completionNotificationsEnabled:
          input.completionNotificationsEnabled ?? true,
        exclusiveWorktree: concurrency === "EXCLUSIVE",
        worktreeConcurrency: concurrency,
        blocksGitOperations: workflowGitBlocking(
          concurrency,
          input.blocksGitOperations,
        ),
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
    const concurrency = worktreeConcurrency(
      input.worktreeConcurrency ??
        (input.exclusiveWorktree === null ||
        input.exclusiveWorktree === undefined
          ? current.worktreeConcurrency
          : null),
      input.exclusiveWorktree ?? current.exclusiveWorktree,
    );
    const prisma = await getPrismaClient();
    await prisma.workflow.update({
      where: { id: input.id },
      data: {
        name: definition.name,
        description: definition.description,
        draftDefinitionJson: serialized,
        draftSchemaVersion: definition.schemaVersion,
        overlapPolicy: policy,
        overlapScope: overlapScope(input.overlapScope ?? current.overlapScope),
        maxConcurrentRuns: concurrentRuns(
          input.maxConcurrentRuns ?? current.maxConcurrentRuns,
          policy,
        ),
        completionNotificationsEnabled:
          input.completionNotificationsEnabled ??
          current.completionNotificationsEnabled,
        exclusiveWorktree: concurrency === "EXCLUSIVE",
        worktreeConcurrency: concurrency,
        blocksGitOperations: workflowGitBlocking(
          concurrency,
          input.blocksGitOperations ?? current.blocksGitOperations,
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
      for (const node of validation.definition.nodes) {
        if (node.kind !== "SAVED_COMMAND" && node.kind !== "CUSTOM_COMMAND") {
          continue;
        }
        const pattern = commandOutputPattern(node.config);
        if (!pattern) continue;
        try {
          compileCommandOutputPattern(pattern);
        } catch (error) {
          if (
            !diagnostics.some(
              ({ code, nodeId }) =>
                code === "COMMAND_MATCH_PATTERN_INVALID" && nodeId === node.id,
            )
          ) {
            diagnostics.push({
              severity: "ERROR",
              code: "COMMAND_MATCH_PATTERN_INVALID",
              message: error instanceof Error ? error.message : String(error),
              nodeId: node.id,
            });
          }
        }
      }
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

  async setQuickAction(input: {
    id: string;
    kind: WorkflowQuickActionKind;
    quickActionIconKey: string;
    quickActionButtonVariant: string;
    repositoryIds: string[];
  }) {
    const prisma = await getPrismaClient();
    const repositoryIds = [
      ...new Set(input.repositoryIds.map((id) => id.trim()).filter(Boolean)),
    ];
    const [workflow, repositoryCount] = await Promise.all([
      prisma.workflow.findUnique({
        where: { id: input.id },
        select: { id: true },
      }),
      prisma.codebaseRepository.count({ where: { id: { in: repositoryIds } } }),
    ]);
    if (!workflow) throw new Error("Workflow not found");
    if (repositoryCount !== repositoryIds.length) {
      throw new Error("One or more repositories were not found");
    }
    const quickActionIconKey = input.quickActionIconKey.trim();
    if (!WORKFLOW_QUICK_ACTION_KINDS.includes(input.kind)) {
      throw new Error("Quick action kind is invalid");
    }
    if (
      quickActionIconKey !== "none" &&
      !(BUILD_CONFIGURATION_ICON_KEYS as readonly string[]).includes(
        quickActionIconKey,
      )
    ) {
      throw new Error("Quick action icon is invalid");
    }
    const quickActionButtonVariant = input.quickActionButtonVariant.trim();
    if (
      !["default", "outline", "secondary", "destructive"].includes(
        quickActionButtonVariant,
      )
    ) {
      throw new Error("Quick action button style is invalid");
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.workflow.update({
        where: { id: input.id },
        data: {
          quickActionKind: input.kind,
          quickActionIconKey,
          quickActionButtonVariant,
        },
      });
      await transaction.workflowQuickActionRepository.deleteMany({
        where: { workflowId: input.id },
      });
      if (repositoryIds.length) {
        await transaction.workflowQuickActionRepository.createMany({
          data: repositoryIds.map((repositoryId) => ({
            workflowId: input.id,
            repositoryId,
          })),
        });
      }
    });
    publishWorkflowChanged(input.id);
    return this.get(input.id);
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
        overlapScope: workflow.overlapScope,
        maxConcurrentRuns: workflow.maxConcurrentRuns,
        completionNotificationsEnabled: workflow.completionNotificationsEnabled,
        exclusiveWorktree: workflow.exclusiveWorktree,
        worktreeConcurrency: workflow.worktreeConcurrency,
        blocksGitOperations: workflow.blocksGitOperations,
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
      // Exports taken before the scope existed reserved worktrees per worktree
      // and counted everything else globally, so they import that way.
      overlapScope:
        typeof workflow.overlapScope === "string"
          ? workflow.overlapScope
          : workflow.exclusiveWorktree === true
            ? "WORKTREE"
            : "GLOBAL",
      maxConcurrentRuns:
        typeof workflow.maxConcurrentRuns === "number"
          ? workflow.maxConcurrentRuns
          : 1,
      completionNotificationsEnabled:
        typeof workflow.completionNotificationsEnabled === "boolean"
          ? workflow.completionNotificationsEnabled
          : true,
      worktreeConcurrency:
        typeof workflow.worktreeConcurrency === "string"
          ? workflow.worktreeConcurrency
          : workflow.exclusiveWorktree === true
            ? "EXCLUSIVE"
            : "NON_EXCLUSIVE",
      blocksGitOperations:
        typeof workflow.blocksGitOperations === "boolean"
          ? workflow.blocksGitOperations
          : workflow.exclusiveWorktree === true,
      exclusiveWorktree:
        typeof workflow.exclusiveWorktree === "boolean"
          ? workflow.exclusiveWorktree
          : false,
    });
  }

  async runs(
    input: {
      workflowId?: string | null;
      status?: string | null;
      search?: string | null;
      archive?: string | null;
      first?: number | null;
      after?: string | null;
    } = {},
  ) {
    const prisma = await getPrismaClient();
    const first = Math.min(Math.max(input.first ?? 100, 1), 200);
    const searchNumber = Number(input.search);
    const archive = input.archive?.toUpperCase() ?? "ACTIVE";
    const archiveWhere =
      archive === "ALL"
        ? {}
        : archive === "ARCHIVED"
          ? { archivedAt: { not: null } }
          : { archivedAt: null };
    const items = await prisma.workflowRun.findMany({
      where: {
        ...archiveWhere,
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
        where: {
          ...archiveWhere,
          ...(input.workflowId ? { workflowId: input.workflowId } : {}),
        },
      }),
    };
  }

  async archiveRuns(ids: string[], archived: boolean) {
    const prisma = await getPrismaClient();
    const unique = [...new Set(ids)];
    const result = await prisma.workflowRun.updateMany({
      where: { id: { in: unique } },
      data: { archivedAt: archived ? new Date() : null },
    });
    for (const id of unique) publishRunChanged(id);
    return result.count;
  }

  /**
   * Child runs point at their parent with `onDelete: SetNull`, and every other
   * row hanging off a run cascades, so a plain `deleteMany` is enough. The one
   * thing worth guarding is a run that has not finished: the scheduler would
   * keep holding a lease on a row that no longer exists.
   */
  async deleteRuns(ids: string[]) {
    const prisma = await getPrismaClient();
    const unique = [...new Set(ids)];
    const unfinished = await prisma.workflowRun.count({
      where: {
        id: { in: unique },
        status: { notIn: ["SUCCEEDED", "FAILED", "CANCELLED"] },
      },
    });
    if (unfinished) {
      throw new Error(
        "Cancel runs that have not finished before deleting them",
      );
    }
    const result = await prisma.workflowRun.deleteMany({
      where: { id: { in: unique } },
    });
    for (const id of unique) publishRunChanged(id);
    return result.count;
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
      blocksGitOperations: context.run.blocksGitOperations,
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
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config, 900),
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
      wait: {
        kind: "AGENT_JOB",
        externalKey: job.id,
        resumeAfter: waitResumeAfter(context.node.config),
        timeoutAt: waitTimeoutAt(context.node.config),
      },
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
            include: {
              codebase: { include: { repository: true, agent: true } },
            },
          })
        : null;
      const codebase =
        worktree?.codebase ??
        (job.codebaseId
          ? await prisma.codebase.findUnique({
              where: { id: job.codebaseId },
              include: { repository: true, agent: true },
            })
          : null);
      let sessionPatch: SessionData = {};
      if (worktree && this.worktrees?.workflowSessionDataForWorktree) {
        try {
          sessionPatch = (await this.worktrees.workflowSessionDataForWorktree(
            worktree.id,
            {
              includeMissing: true,
            },
          )) as SessionData;
        } catch {
          // The local projection below still gives the waiting workflow enough
          // context to continue when an optional external lookup fails.
        }
      }
      if (codebase && !sessionPatch.codebase) {
        sessionPatch.repo = {
          id: codebase.repository.id,
          name: codebase.repository.name,
          url: codebase.repository.displayOrigin,
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
        sessionPatch.agent = {
          id: codebase.agent.id,
          name: codebase.agent.name,
          hostname: codebase.agent.hostname,
        };
      }
      if (worktree && !sessionPatch.worktree) {
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
        const currentPatch =
          result.sessionPatch &&
          typeof result.sessionPatch === "object" &&
          !Array.isArray(result.sessionPatch)
            ? (result.sessionPatch as SessionData)
            : {};
        result = {
          ...result,
          sessionPatch: mergeSessionData(currentPatch, sessionPatch),
        };
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
        attempts: {
          orderBy: [{ generation: "asc" }, { createdAt: "asc" }],
          include: {
            resourceLinks: { orderBy: { createdAt: "asc" } },
            questionBatches: {
              orderBy: { createdAt: "asc" },
              include: {
                questions: {
                  orderBy: { position: "asc" },
                  include: { options: { orderBy: { position: "asc" } } },
                },
              },
            },
          },
        },
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
      return definition.triggers.some(
        (trigger) =>
          isResourceTriggerKind(trigger.kind) &&
          workflowResourceKind(trigger.config) === normalized,
      );
    });
  }

  async quickActions(input: {
    kind: WorkflowQuickActionKind;
    resourceKind: string;
    repositoryId?: string | null;
  }) {
    const prisma = await getPrismaClient();
    if (!WORKFLOW_QUICK_ACTION_KINDS.includes(input.kind)) {
      throw new Error("Quick action kind is invalid");
    }
    const normalizedResourceKind = input.resourceKind.trim().toUpperCase();
    const repositoryId = input.repositoryId?.trim() || null;
    const workflows = await prisma.workflow.findMany({
      where: {
        enabled: true,
        archivedAt: null,
        activeVersionId: { not: null },
        quickActionKind: input.kind,
        OR: [
          { quickActionRepositories: { none: {} } },
          {
            quickActionRepositories: {
              some: { repositoryId: repositoryId ?? "" },
            },
          },
        ],
      },
      include: { activeVersion: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    return workflows.filter((workflow) => {
      if (!workflow.activeVersion) return false;
      const definition = parseWorkflowDefinition(
        json(workflow.activeVersion.definitionJson),
      );
      return definition.triggers.some(
        (trigger) =>
          isResourceTriggerKind(trigger.kind) &&
          workflowResourceKind(trigger.config) === normalizedResourceKind,
      );
    });
  }

  async recordEvent(input: RecordWorkflowEventInput) {
    return this.events.record(input);
  }

  /**
   * Enriches a resource-launched run with locally persisted metadata and
   * related resources. GitHub reads are deliberately excluded: a workflow must
   * use an explicit GitHub step to add live provider data. Any caller-provided
   * value wins over the derived context.
   */
  private async hydrateResourceSessionData(
    resourceKind: string | null | undefined,
    resourceId: string | null | undefined,
    sessionData: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const normalized = resourceKind?.toUpperCase() ?? null;
    const prisma = await getPrismaClient();
    let derived: SessionData = {};
    let relatedWorktreeId: string | null = null;

    if (normalized === "CODEBASE" && resourceId) {
      const codebase = await prisma.codebase.findUnique({
        where: { id: resourceId },
        select: {
          id: true,
          folder: true,
          agentId: true,
          branch: true,
          headSha: true,
          defaultBranch: true,
          agent: {
            select: {
              id: true,
              name: true,
              hostname: true,
              lastSeenAt: true,
              disconnectedAt: true,
              heartbeatIntervalSeconds: true,
              diskFreeBytes: true,
              memoryFreeBytes: true,
            },
          },
          repository: {
            select: {
              id: true,
              name: true,
              canonicalOrigin: true,
              displayOrigin: true,
            },
          },
        },
      });
      if (codebase) derived = codebaseSessionData(codebase);
    }

    if (normalized === "BUILD" && resourceId) {
      const build = await prisma.build.findUnique({
        where: { id: resourceId },
        select: {
          id: true,
          status: true,
          action: true,
          error: true,
          artifactDirectory: true,
          worktreeId: true,
          agent: {
            select: {
              id: true,
              name: true,
              hostname: true,
              lastSeenAt: true,
              disconnectedAt: true,
              heartbeatIntervalSeconds: true,
              diskFreeBytes: true,
              memoryFreeBytes: true,
            },
          },
          codebase: {
            select: {
              id: true,
              folder: true,
              agentId: true,
              branch: true,
              headSha: true,
              defaultBranch: true,
              agent: {
                select: {
                  id: true,
                  name: true,
                  hostname: true,
                  lastSeenAt: true,
                  disconnectedAt: true,
                  heartbeatIntervalSeconds: true,
                  diskFreeBytes: true,
                  memoryFreeBytes: true,
                },
              },
              repository: {
                select: {
                  id: true,
                  name: true,
                  canonicalOrigin: true,
                  displayOrigin: true,
                },
              },
            },
          },
          artifacts: {
            select: {
              id: true,
              kind: true,
              relativePath: true,
              sizeBytes: true,
              checksum: true,
            },
          },
          reports: {
            where: { status: "READY" },
            select: { kind: true, summaryJson: true },
          },
        },
      });
      if (build) {
        relatedWorktreeId = build.worktreeId;
        const reportSummary = (kind: string) => {
          const report = build.reports.find((entry) => entry.kind === kind);
          if (!report) return undefined;
          try {
            return workflowSessionData(report.summaryJson);
          } catch {
            return undefined;
          }
        };
        const testSummary = reportSummary("TEST_RESULTS");
        const coverageSummary = reportSummary("CODE_COVERAGE");
        derived = mergeSessionData(
          build.codebase
            ? codebaseSessionData(build.codebase)
            : build.agent
              ? agentSessionData(build.agent)
              : {},
          {
            build: {
              id: build.id,
              status: build.status,
              action: build.action,
              error: build.error,
              artifactDirectory: build.artifactDirectory,
              artifacts: build.artifacts,
              ...(testSummary ? { testSummary } : {}),
              ...(coverageSummary ? { coverageSummary } : {}),
            },
          },
        );
      }
    }

    if (normalized === "AGENT_RUN" && resourceId) {
      const run = await prisma.agentRun.findUnique({
        where: { id: resourceId },
        select: {
          id: true,
          kind: true,
          status: true,
          phase: true,
          origin: true,
          provider: true,
          model: true,
          branch: true,
          finalOutput: true,
          error: true,
          jiraIssueKey: true,
          worktreeId: true,
          agent: {
            select: {
              id: true,
              name: true,
              hostname: true,
              disconnectedAt: true,
              diskFreeBytes: true,
              memoryFreeBytes: true,
            },
          },
          inputTokens: true,
          outputTokens: true,
          reasoningTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          toolCallCount: true,
          estimatedCost: true,
        },
      });
      if (run) {
        relatedWorktreeId = run.worktreeId;
        derived = mergeSessionData(
          run.agent ? agentSessionData(run.agent) : {},
          {
            run: {
              id: run.id,
              kind: run.kind,
              status: run.status,
              phase: run.phase,
              origin: run.origin,
              provider: run.provider,
              model: run.model,
              branch: run.branch,
              finalOutput: run.finalOutput,
              error: run.error,
              usage: {
                inputTokens: run.inputTokens,
                outputTokens: run.outputTokens,
                reasoningTokens: run.reasoningTokens,
                cacheReadTokens: run.cacheReadTokens,
                cacheWriteTokens: run.cacheWriteTokens,
                toolCallCount: run.toolCallCount,
                estimatedCost: run.estimatedCost,
              },
            },
            ...(run.jiraIssueKey ? { ticket: { key: run.jiraIssueKey } } : {}),
          },
        );
      }
    }

    if (
      normalized === "PULL_REQUEST" &&
      resourceId &&
      this.worktrees?.workflowSessionDataForPullRequest
    ) {
      const match = /^([^/]+)\/([^#]+)#([1-9]\d*)$/.exec(resourceId);
      if (match) {
        derived = mergeSessionData(
          derived,
          (await this.worktrees.workflowSessionDataForPullRequest(
            match[1]!,
            match[2]!,
            Number(match[3]),
          )) as SessionData,
        );
      }
    }

    if (normalized === "JIRA_TICKET" && resourceId && this.jiraService) {
      try {
        const ticket = await this.jiraService.ticket(resourceId);
        const latestComment = ticket.comments.at(-1) ?? null;
        derived = mergeSessionData(derived, {
          ticket: {
            ...ticket,
            title: ticket.summary,
            type: ticket.issueType,
            url: ticket.jiraUrl,
          },
          ...(latestComment
            ? {
                comment: {
                  id: latestComment.id,
                  body: latestComment.content?.rawText ?? "",
                  author: latestComment.author,
                },
              }
            : {}),
        });
      } catch {
        // Keep the key supplied by the Jira page when metadata cannot load.
      }
    }

    const sessionWorktreeId = getSessionValue(sessionData, "worktree.id");
    const worktreeId =
      normalized === "WORKTREE"
        ? resourceId
        : normalized === "GITHUB_PIPELINE" || normalized === "GITHUB_JOB"
          ? typeof sessionWorktreeId === "string"
            ? sessionWorktreeId
            : null
          : relatedWorktreeId;
    if (worktreeId && this.worktrees) {
      if (this.worktrees.workflowSessionDataForWorktree) {
        derived = mergeSessionData(
          (await this.worktrees.workflowSessionDataForWorktree(
            worktreeId,
          )) as SessionData,
          derived,
        );
      } else {
        const key = await this.worktrees.ticketKeyForWorktree(worktreeId);
        if (key) derived = mergeSessionData({ ticket: { key } }, derived);
      }
    }
    const associatedPullRequests = getSessionValue(
      sessionData,
      "pipeline.pullRequests",
    );
    if (
      !getSessionValue(derived, "pr") &&
      !getSessionValue(sessionData, "pr") &&
      Array.isArray(associatedPullRequests) &&
      associatedPullRequests[0] &&
      typeof associatedPullRequests[0] === "object" &&
      !Array.isArray(associatedPullRequests[0])
    ) {
      derived = mergeSessionData(derived, {
        pr: associatedPullRequests[0] as Record<string, unknown>,
      });
    }
    const jiraKey =
      getSessionValue(sessionData, "pr.jiraKey") ??
      getSessionValue(sessionData, "pipeline.jiraKey");
    if (
      typeof getSessionValue(derived, "ticket.key") !== "string" &&
      typeof jiraKey === "string" &&
      jiraKey.trim()
    ) {
      derived = mergeSessionData(derived, { ticket: { key: jiraKey } });
    }
    return mergeSessionData(derived, sessionData);
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
    const resourceKind = input.resourceKind?.toUpperCase() ?? null;
    const choice = input.choice?.trim() || null;
    const { triggers } = workflow.activeVersion;
    // Each manual entry point comes in a plain and a choice flavour. The caller
    // naming an option picks the choice flavour; otherwise the plain one runs,
    // and a workflow that only offers choices refuses rather than starting a run
    // that no edge would carry.
    const plainKind = resourceKind ? "RESOURCE_MANUAL" : "MANUAL";
    const choiceKind = resourceKind
      ? "RESOURCE_MANUAL_CHOICE"
      : "MANUAL_CHOICE";
    const find = (kind: string) =>
      triggers.find(
        (candidate) =>
          candidate.kind === kind &&
          (!resourceKind ||
            workflowResourceKind(
              parseObject(json(candidate.configJson), "Trigger configuration"),
            ) === resourceKind),
      ) ?? null;
    const choiceTrigger = find(choiceKind);
    const plainTrigger = find(plainKind);
    const trigger = choice ? choiceTrigger : plainTrigger;
    if (choice && !choiceTrigger) {
      throw new Error(
        resourceKind
          ? `No resource trigger offers choices for ${resourceKind} resources`
          : "This workflow has no manual trigger with choices",
      );
    }
    if (!choice && !plainTrigger && choiceTrigger) {
      const options = workflowTriggerChoices(
        parseObject(json(choiceTrigger.configJson), "Trigger configuration"),
      );
      throw new Error(
        `This workflow needs a choice: ${options.map(({ key }) => key).join(", ")}`,
      );
    }
    if (resourceKind && !trigger) {
      throw new Error(
        `No resource trigger accepts ${input.resourceKind} resources`,
      );
    }
    if (choice && choiceTrigger) {
      const options = workflowTriggerChoices(
        parseObject(json(choiceTrigger.configJson), "Trigger configuration"),
      );
      if (!options.some(({ key }) => key === choice))
        throw new Error(`Unknown choice ${choice}`);
    }
    const wantedKind = choice ? choiceKind : plainKind;
    const subjectKey =
      input.subjectKey?.trim() ||
      (resourceKind && input.resourceId
        ? `${resourceKind}:${input.resourceId}`
        : `manual:${randomUUID()}`);
    const payload = {
      sessionData: await this.hydrateResourceSessionData(
        input.resourceKind,
        input.resourceId,
        input.sessionData ?? {},
      ),
      resourceKind: input.resourceKind ?? null,
      resourceId: input.resourceId ?? null,
      choice,
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
    deliveryId: string | null = null,
  ): Promise<WorkflowRun> {
    const prisma = await getPrismaClient();
    return prisma.$transaction(async (transaction) => {
      if (deliveryId) {
        const delivered = await transaction.workflowTriggerDelivery.findUnique({
          where: { id: deliveryId },
          include: { run: true },
        });
        if (delivered) return delivered.run;
      }
      const attachDelivery = async (run: WorkflowRun) => {
        if (deliveryId) {
          await transaction.workflowTriggerDelivery.create({
            data: { id: deliveryId, runId: run.id },
          });
        }
        return run;
      };
      const existing = await transaction.workflowRun.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return attachDelivery(existing);
      const sessionSeed = parseObject(
        payload.sessionData ?? {},
        "Session data",
      );
      const requestedWorktreeId = getSessionValue(sessionSeed, "worktree.id");
      const worktreeId =
        typeof requestedWorktreeId === "string" && requestedWorktreeId
          ? ((
              await transaction.worktree.findUnique({
                where: { id: requestedWorktreeId },
                select: { id: true },
              })
            )?.id ?? null)
          : null;
      if (workflow.overlapPolicy === "COALESCE_LATEST") {
        const queued = await transaction.workflowRun.findFirst({
          where: {
            workflowId: workflow.id,
            triggerSubjectKey: subjectKey,
            status: "QUEUED",
            ...overlapScopeFilter(workflow.overlapScope, worktreeId),
          },
          orderBy: { queuedAt: "desc" },
        });
        if (queued) {
          const updated = await transaction.workflowRun.update({
            where: { id: queued.id },
            data: {
              triggerId: trigger?.id ?? null,
              triggerEventId,
              triggerKind,
              triggerPayloadJson: JSON.stringify(payload),
              queuedAt: new Date(),
            },
          });
          return attachDelivery(updated);
        }
      }
      const id = randomUUID();
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
              // Steps can branch on which option started the run without
              // needing an edge per option — `workflow.trigger.choice` is null
              // for every trigger that does not offer a choice.
              choice:
                typeof payload.choice === "string" ? payload.choice : null,
            },
          },
          steps: {},
        },
        sessionSeed,
      );
      const serializedSession = JSON.stringify(sessionData);
      assertSize(serializedSession, "Workflow session data", MAX_SESSION_BYTES);
      const parent = parentRunId
        ? await transaction.workflowRun.findUnique({
            where: { id: parentRunId },
            select: { worktreeId: true, worktreeLeaseOwnerRunId: true },
          })
        : null;
      const inheritedLeaseOwner =
        parent?.worktreeId === worktreeId
          ? parent.worktreeLeaseOwnerRunId
          : null;
      const worktreeLeaseOwnerRunId =
        inheritedLeaseOwner ??
        (!parentRunId &&
        workflow.worktreeConcurrency === "EXCLUSIVE" &&
        worktreeId
          ? id
          : null);
      const run = await transaction.workflowRun.create({
        data: {
          id,
          displayNumber: await nextDisplayNumber(transaction),
          workflowId: workflow.id,
          versionId: version.id,
          triggerId: trigger?.id ?? null,
          triggerEventId,
          parentRunId,
          worktreeId,
          worktreeLeaseOwnerRunId,
          exclusiveWorktree: workflow.worktreeConcurrency === "EXCLUSIVE",
          worktreeConcurrency: workflow.worktreeConcurrency,
          blocksGitOperations: workflow.blocksGitOperations,
          idempotencyKey,
          triggerKind,
          triggerSubjectKey: subjectKey,
          triggerPayloadJson: JSON.stringify(payload),
          sessionDataJson: serializedSession,
          phase: worktreeLeaseOwnerRunId ? "WAITING_FOR_WORKTREE" : "QUEUED",
        },
      });
      const triggerLink = workflowTriggerResourceLink(triggerKind, payload);
      if (triggerLink) {
        await transaction.workflowRunResourceLink.create({
          data: {
            id: randomUUID(),
            runId: run.id,
            kind: triggerLink.kind.toUpperCase(),
            resourceId: triggerLink.resourceId,
            label: triggerLink.label ?? null,
            url: triggerLink.url ?? null,
            metadataJson: triggerLink.metadata
              ? JSON.stringify(triggerLink.metadata)
              : null,
          },
        });
      }
      return attachDelivery(run);
    });
  }

  private async processTriggerEvents(): Promise<void> {
    const prisma = await getPrismaClient();
    const pending = await prisma.workflowTriggerEvent.findMany({
      where: { status: "PENDING" },
      orderBy: { receivedAt: "asc" },
      take: 50,
    });
    if (!pending.length) return;
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
    for (const event of pending) {
      try {
        const payload = parseObject(json(event.payloadJson), "Trigger payload");
        for (const workflow of workflows) {
          if (!workflow.activeVersion) continue;
          const matching = workflow.activeVersion.triggers.filter(
            ({ kind }) => kind === event.kind,
          );
          for (const trigger of matching) {
            if (
              payload.workflowCorrelation &&
              typeof payload.workflowCorrelation === "object" &&
              (payload.workflowCorrelation as Record<string, unknown>)
                .workflowId === workflow.id
            ) {
              continue;
            }
            const deliveryId = workflowTriggerDeliveryId(
              event.dedupeKey,
              workflow.id,
              trigger.nodeId,
            );
            const delivered = await prisma.workflowTriggerDelivery.findUnique({
              where: { id: deliveryId },
              select: { id: true },
            });
            if (delivered) continue;
            if (
              !(await this.triggerMatches(trigger, event.subjectKey, payload))
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
              deliveryId,
              null,
              deliveryId,
            );
            publishRunChanged(run.id);
          }
        }
        await prisma.workflowTriggerEvent.delete({
          where: { id: event.id },
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
    // Resolved against the event payload the same way a step's config is
    // resolved against session data, so a filter, a threshold, or a command
    // pattern can carry `{{path}}` tokens and session bindings rather than only
    // constants.
    const config = resolveWorkflowValue(
      parseObject(json(trigger.configJson), "Trigger configuration"),
      payload,
    ) as Record<string, unknown>;
    let cursorChanged: boolean | null = null;
    let previousCursor: unknown;
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
      previousCursor = previous?.cursorJson
        ? parseObject(json(previous.cursorJson), "Trigger cursor").value
        : undefined;
      cursorChanged =
        canonical(previousCursor) !== canonical(payload.cursorValue);
      if (trigger.kind === "WORKTREE_CLEAN") {
        cursorChanged =
          previousCursor === true && payload.cursorValue === false;
      }
      if (
        trigger.kind === "JIRA_SPRINT_STARTED" ||
        trigger.kind === "JIRA_SPRINT_ENDED"
      ) {
        const previousSprints = Array.isArray(previousCursor)
          ? previousCursor
          : null;
        const currentSprints = Array.isArray(payload.cursorValue)
          ? payload.cursorValue
          : null;
        cursorChanged =
          previousSprints !== null &&
          currentSprints !== null &&
          currentSprints.some(
            (value) =>
              !previousSprints.some(
                (previousValue) =>
                  canonical(previousValue) === canonical(value),
              ),
          );
      }
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
    if (trigger.kind === "JIRA_ISSUE_COMMAND") {
      // Jira has no stable handle, so the allow-list is keyed on account ID.
      const accountId = getSessionValue(payload, "comment.author.accountId");
      const body = getSessionValue(payload, "comment.body");
      const allow = Array.isArray(config.allowedAccountIds)
        ? config.allowedAccountIds
        : [];
      if (typeof accountId !== "string" || !allow.includes(accountId)) {
        return false;
      }
      if (
        typeof body !== "string" ||
        typeof config.commandPattern !== "string" ||
        !new RegExp(config.commandPattern).test(body)
      ) {
        return false;
      }
    }
    if (trigger.kind === "COMMAND_OUTPUT_MATCH") {
      const output = getSessionValue(payload, "output.data");
      if (
        typeof output !== "string" ||
        typeof config.outputPattern !== "string" ||
        !new RegExp(config.outputPattern).test(output)
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
      const requested = await prisma.$transaction(async (transaction) => {
        const updated = await transaction.workflowRun.updateMany({
          where: {
            id: runId,
            status: { in: ["RUNNING", "WAITING", "BLOCKED"] },
          },
          data: { status: "PAUSING", phase: "DRAINING" },
        });
        if (!updated.count) return false;
        await transaction.workflowStepAttempt.updateMany({
          where: { runId, status: "READY" },
          data: { status: "PENDING", phase: "PAUSED_PENDING" },
        });
        return true;
      });
      if (!requested) return this.run(runId);
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
      const resumed = await prisma.workflowRun.updateMany({
        where: { id: runId, status: "PAUSED" },
        data: { status: "RUNNING", phase: "SCHEDULING", pausedAt: null },
      });
      if (!resumed.count) return this.run(runId);
      await this.controlLinkedAgentRuns(runId, "CONTINUE");
      await this.appendEvent(runId, null, "RUN_RESUMED", "Workflow resumed");
    } else {
      if (TERMINAL_RUN_STATUSES.has(run.status)) return this.run(runId);
      await this.controlLinkedAgentRuns(runId, "CANCEL");
      await this.cancelWaitingCommandRuns(runId);
      for (const [attemptId, controller] of this.activeExecutions) {
        const attempt = await prisma.workflowStepAttempt.findUnique({
          where: { id: attemptId },
          select: { runId: true },
        });
        if (attempt?.runId === runId) controller.abort();
      }
      const cancelled = await prisma.$transaction(async (transaction) => {
        const updated = await transaction.workflowRun.updateMany({
          where: {
            id: runId,
            status: { notIn: [...TERMINAL_RUN_STATUSES] },
          },
          data: {
            status: "CANCELLED",
            phase: "CANCELLED",
            finishedAt: new Date(),
          },
        });
        if (!updated.count) return false;
        await transaction.workflowStepAttempt.updateMany({
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
        });
        await transaction.workflowWait.updateMany({
          where: { runId, status: "PENDING" },
          data: { status: "CANCELLED", resolvedAt: new Date() },
        });
        await transaction.workflowResourceLease.deleteMany({
          where: { runId },
        });
        await transaction.worktreeWorkflowLease.deleteMany({
          where: { workflowRunId: runId },
        });
        return true;
      });
      if (!cancelled) return this.run(runId);
      await this.appendEvent(
        runId,
        null,
        "RUN_CANCELLED",
        "Workflow cancelled",
      );
      await this.promoteWorktreeAdmissions(run.worktreeId);
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
    assertExclusiveWorktreeUnchanged(run, next);
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
    await this.completeWaitingAttempt(result.id, { answers }, "HUMAN");
    agentEventBus.publish(runQuestionTopic(result.runId), {
      workflowQuestionChanged: { id: batchId, runId: result.runId },
    });
    return this.run(result.runId);
  }

  private async consumeCommandOutputMatches(): Promise<void> {
    if (this.commandOutputStream || !this.commandsService) return;
    const stream = agentEventBus.iterate<{
      commandRunOutputAdded: { runId: string };
    }>(COMMAND_RUN_OUTPUT_CHANGED_TOPIC);
    this.commandOutputStream = stream;
    try {
      for await (const payload of stream) {
        if (this.commandOutputStream !== stream) break;
        await this.reconcileCommandOutputMatches(
          payload.commandRunOutputAdded.runId,
        ).catch((error) =>
          console.error("Could not process workflow command output:", error),
        );
      }
    } finally {
      if (this.commandOutputStream === stream) {
        this.commandOutputStream = undefined;
      }
      await stream.return?.();
    }
  }

  private async commandOutputRows(
    runId: string,
    afterAttempt: number,
    afterSequence: number,
  ): Promise<CommandOutputRow[]> {
    if (!this.commandsService) return [];
    const result: CommandOutputRow[] = [];
    let attempt = afterAttempt;
    let sequence = afterSequence;
    while (true) {
      const page = (await this.commandsService.listOutput(
        runId,
        attempt,
        sequence,
        5_000,
      )) as CommandOutputRow[];
      result.push(...page);
      if (page.length < 5_000) return result;
      const last = page.at(-1)!;
      attempt = last.attempt.attempt;
      sequence = last.sequence;
    }
  }

  private commandMatchBranchNodes(
    definition: WorkflowDefinition,
    sourceNodeId: string,
  ): WorkflowNodeDefinition[] {
    const outgoing = new Map<string, WorkflowDefinition["edges"]>();
    for (const edge of definition.edges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    }
    const pending = (outgoing.get(sourceNodeId) ?? [])
      .filter(({ sourceHandle }) => sourceHandle === "match")
      .map(({ target }) => target);
    const ids = new Set<string>();
    while (pending.length) {
      const id = pending.shift()!;
      if (ids.has(id)) continue;
      ids.add(id);
      pending.push(...(outgoing.get(id) ?? []).map(({ target }) => target));
    }
    return definition.nodes.filter(({ id }) => ids.has(id));
  }

  private async persistCommandMatches(
    wait: WorkflowWait & {
      attempt: WorkflowStepAttempt & {
        run: WorkflowRun & { version: WorkflowVersion };
      };
    },
    cursor: CommandMatchCursor,
    matches: CommandMatchResult[],
  ): Promise<boolean> {
    const prisma = await getPrismaClient();
    const nextPredicateJson = commandMatchPredicate(wait.predicateJson, cursor);
    if (!matches.length) {
      const updated = await prisma.workflowWait.updateMany({
        where: {
          id: wait.id,
          status: "PENDING",
          predicateJson: wait.predicateJson,
        },
        data: { predicateJson: nextPredicateJson },
      });
      return Boolean(updated.count);
    }
    const definition = parseWorkflowDefinition(
      json(wait.attempt.run.version.definitionJson),
    );
    const sourceNode = definition.nodes.find(
      ({ id }) => id === wait.attempt.nodeId,
    );
    if (!sourceNode) throw new Error("Workflow command step is missing");
    const branchNodes = this.commandMatchBranchNodes(definition, sourceNode.id);
    const persisted = await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.workflowWait.updateMany({
        where: {
          id: wait.id,
          status: "PENDING",
          predicateJson: wait.predicateJson,
        },
        data: { predicateJson: nextPredicateJson },
      });
      if (!claimed.count) return false;
      const run = await transaction.workflowRun.findUnique({
        where: { id: wait.runId },
      });
      if (!run || !SCHEDULING_RUN_STATUSES.has(run.status)) return false;
      let sessionData = workflowSessionData(run.sessionDataJson ?? "{}");
      const stepPath = `steps.${sourceNode.id}`;
      const existingStep = recordValue(getSessionValue(sessionData, stepPath));
      const previousMatches = Array.isArray(existingStep.matches)
        ? existingStep.matches
        : [];
      const aggregate = [...previousMatches, ...matches];
      sessionData = setSessionValue(sessionData, stepPath, {
        ...existingStep,
        matches: aggregate,
        latestMatch: matches.at(-1)!,
      });
      assertExclusiveWorktreeUnchanged(run, sessionData);
      const serialized = JSON.stringify(sessionData);
      assertSize(serialized, "Workflow session data", MAX_SESSION_BYTES);

      const attempts = branchNodes.length
        ? matches.flatMap((match, matchIndex) => {
            const iterationKey = `match.${wait.attempt.id}.${match.ordinal}`;
            const iterationPatch = setSessionValue({}, stepPath, {
              ...existingStep,
              matches: [
                ...previousMatches,
                ...matches.slice(0, matchIndex + 1),
              ],
              latestMatch: match,
            });
            const common = {
              runId: wait.runId,
              generation: wait.attempt.generation,
              iterationKey,
              attempt: 0,
            };
            return [
              {
                id: randomUUID(),
                ...common,
                nodeId: sourceNode.id,
                kind: sourceNode.kind,
                status: "SUCCEEDED",
                phase: "MATCH_EMITTED",
                inputJson: JSON.stringify(iterationPatch),
                outputJson: JSON.stringify({
                  value: match,
                  selectedHandles: ["match"],
                  sessionPatch: iterationPatch,
                }),
                requiredPathsJson: JSON.stringify(
                  nodeRequiredPaths(sourceNode),
                ),
                providedPathsJson: JSON.stringify(
                  nodeProvidedPaths(sourceNode),
                ),
                idempotencyKey: `${wait.runId}:${sourceNode.id}:${wait.attempt.generation}:${iterationKey}:0`,
                startedAt: new Date(),
                finishedAt: new Date(),
              },
              ...branchNodes.map((node) => ({
                id: randomUUID(),
                ...common,
                nodeId: node.id,
                kind: node.kind,
                status: "PENDING",
                phase: "MATCH_PENDING",
                inputJson: JSON.stringify(iterationPatch),
                requiredPathsJson: JSON.stringify(nodeRequiredPaths(node)),
                providedPathsJson: JSON.stringify(nodeProvidedPaths(node)),
                idempotencyKey: `${wait.runId}:${node.id}:${wait.attempt.generation}:${iterationKey}:0`,
              })),
            ];
          })
        : [];
      if (attempts.length) {
        await transaction.workflowStepAttempt.createMany({ data: attempts });
      }
      await transaction.workflowRun.update({
        where: { id: wait.runId },
        data: {
          sessionDataJson: serialized,
          sessionRevision: { increment: 1 },
        },
      });
      return true;
    });
    if (!persisted) return false;
    for (const match of matches) {
      await this.appendEvent(
        wait.runId,
        wait.attemptId,
        "STEP_OUTPUT_MATCHED",
        `Step ${sourceNode.name ?? sourceNode.id} matched command output`,
        { nodeId: sourceNode.id, match },
      );
    }
    publishRunChanged(wait.runId);
    await this.progressRun(wait.runId);
    await this.dispatchReadyAttempts();
    return true;
  }

  private async failCommandMatchWait(
    wait: WorkflowWait & {
      attempt: WorkflowStepAttempt & {
        run: WorkflowRun & { version: WorkflowVersion };
      };
    },
    error: Error,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const failed = await prisma.workflowWait.updateMany({
      where: {
        id: wait.id,
        status: "PENDING",
        predicateJson: wait.predicateJson,
      },
      data: { status: "FAILED", resolvedAt: new Date() },
    });
    if (!failed.count) return;
    await this.commandsService?.terminateRun(wait.externalKey!);
    const node = parseWorkflowDefinition(
      json(wait.attempt.run.version.definitionJson),
    ).nodes.find(({ id }) => id === wait.attempt.nodeId);
    await this.failAttempt(wait.attempt, node ?? null, error);
  }

  private async processCommandMatchWait(
    wait: WorkflowWait & {
      attempt: WorkflowStepAttempt & {
        run: WorkflowRun & { version: WorkflowVersion };
      };
    },
  ): Promise<void> {
    if (!wait.externalKey || !this.commandsService) return;
    const cursor = commandMatchCursor(wait.predicateJson);
    if (!cursor) return;
    try {
      const newRows = await this.commandOutputRows(
        wait.externalKey,
        cursor.observedAttempt,
        cursor.observedSequence,
      );
      if (!newRows.length) return;
      const observed = newRows.at(-1)!;
      cursor.observedAttempt = observed.attempt.attempt;
      cursor.observedSequence = observed.sequence;
      if (cursor.mode === "ONCE" && cursor.matched) {
        await this.persistCommandMatches(wait, cursor, []);
        return;
      }

      const rows = await this.commandOutputRows(
        wait.externalKey,
        cursor.scanAttempt - 1,
        -1,
      );
      const grouped = new Map<number, CommandOutputRow[]>();
      for (const row of rows) {
        const attempt = row.attempt.attempt;
        if (attempt < cursor.scanAttempt) continue;
        grouped.set(attempt, [...(grouped.get(attempt) ?? []), row]);
      }
      const attemptNumbers = [...grouped.keys()].sort(
        (left, right) => left - right,
      );
      const matches: CommandMatchResult[] = [];
      const regex = compileCommandOutputPattern(cursor.pattern, true);
      for (
        let groupIndex = 0;
        groupIndex < attemptNumbers.length;
        groupIndex += 1
      ) {
        const attemptNumber = attemptNumbers[groupIndex]!;
        const chunks = grouped.get(attemptNumber)!;
        let output = "";
        const decoders = new Map<string, TextDecoder>();
        const segments: Array<{
          sequence: number;
          start: number;
          end: number;
        }> = [];
        for (const chunk of chunks) {
          if (chunk.stream !== "STDOUT" && chunk.stream !== "STDERR") continue;
          const decoder =
            decoders.get(chunk.stream) ??
            new TextDecoder("utf-8", { fatal: false });
          decoders.set(chunk.stream, decoder);
          const decoded = decoder.decode(
            Buffer.from(chunk.dataBase64, "base64"),
            { stream: true },
          );
          const start = output.length;
          output += decoded;
          segments.push({
            sequence: chunk.sequence,
            start,
            end: output.length,
          });
        }
        const offset =
          attemptNumber === cursor.scanAttempt
            ? Math.min(cursor.scanCharacterOffset, output.length)
            : 0;
        const unmatched = output.slice(offset);
        if (
          Buffer.byteLength(unmatched, "utf8") >
          COMMAND_OUTPUT_MATCH_BUFFER_BYTES
        ) {
          throw new Error(
            "Command output matcher exceeded its 16 MiB unmatched-output limit",
          );
        }
        regex.lastIndex = offset;
        let match: ReturnType<typeof regex.exec>;
        while ((match = regex.exec(output))) {
          const matchedText = match[0]!;
          if (!matchedText.length) {
            throw new Error(
              "Command output patterns must consume at least one character",
            );
          }
          const startOffset = match.index;
          const endOffset = startOffset + matchedText.length;
          const coordinate = (characterOffset: number, end: boolean) => {
            const segment =
              segments.find(({ start, end: segmentEnd }) =>
                end
                  ? characterOffset > start && characterOffset <= segmentEnd
                  : characterOffset >= start && characterOffset < segmentEnd,
              ) ?? segments.at(-1)!;
            return {
              sequence: segment.sequence,
              offset: Math.max(0, characterOffset - segment.start),
            };
          };
          cursor.matchCount += 1;
          const result: CommandMatchResult = {
            ordinal: cursor.matchCount,
            text: matchedText,
            captures: match.slice(1).map((value) => value ?? null),
            namedCaptures: Object.fromEntries(
              Object.entries(match.groups ?? {}).map(([name, value]) => [
                name,
                value ?? null,
              ]),
            ),
            commandRunId: wait.externalKey,
            commandAttempt: attemptNumber,
            start: coordinate(startOffset, false),
            end: coordinate(endOffset, true),
          };
          matches.push(result);
          cursor.scanAttempt = attemptNumber;
          cursor.scanCharacterOffset = endOffset;
          if (cursor.mode === "ONCE") {
            cursor.matched = true;
            break;
          }
        }
        if (cursor.matched) break;
        const nextAttempt = attemptNumbers[groupIndex + 1];
        if (nextAttempt !== undefined) {
          cursor.scanAttempt = nextAttempt;
          cursor.scanCharacterOffset = 0;
        } else if (attemptNumber > cursor.scanAttempt) {
          cursor.scanAttempt = attemptNumber;
          cursor.scanCharacterOffset = 0;
        }
      }
      await this.persistCommandMatches(wait, cursor, matches);
    } catch (error) {
      await this.failCommandMatchWait(
        wait,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private async reconcileCommandOutputMatches(
    commandRunId?: string,
  ): Promise<void> {
    if (!this.commandsService) return;
    const prisma = await getPrismaClient();
    const waits = await prisma.workflowWait.findMany({
      where: {
        kind: "COMMAND_RUN",
        status: "PENDING",
        predicateJson: { not: null },
        ...(commandRunId ? { externalKey: commandRunId } : {}),
        run: { status: { in: [...SCHEDULING_RUN_STATUSES] } },
      },
      include: {
        attempt: { include: { run: { include: { version: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const wait of waits) await this.processCommandMatchWait(wait);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.recoverExpiredClaims();
      await this.processSchedules();
      await this.processTriggerEvents();
      await this.events.maintain();
      await this.reconcileCommandOutputMatches();
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
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      take: 200,
    });
    for (const run of queued) {
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
        const limit =
          run.workflow.overlapPolicy === "CONCURRENT"
            ? run.workflow.maxConcurrentRuns
            : 1;
        const active = await transaction.workflowRun.count({
          where: {
            workflowId: run.workflowId,
            id: { not: run.id },
            ...overlapScopeFilter(run.workflow.overlapScope, run.worktreeId),
            status: {
              in: ACTIVE_RUN_STATUSES.filter((status) => status !== "QUEUED"),
            },
          },
        });
        if (active >= limit) return false;

        if (run.worktreeId && run.worktreeConcurrency !== "EXCLUDED") {
          await transaction.worktreeAdmissionLane.upsert({
            where: { worktreeId: run.worktreeId },
            create: { worktreeId: run.worktreeId },
            update: { updatedAt: startedAt },
          });
          await transaction.worktreeWorkflowLease.deleteMany({
            where: {
              worktreeId: run.worktreeId,
              workflowRun: { status: { in: [...TERMINAL_RUN_STATUSES] } },
            },
          });
          await transaction.worktreeRunLease.deleteMany({
            where: {
              worktreeId: run.worktreeId,
              purpose: { not: ANSWER_REVISION_LEASE_PURPOSE },
              run: { status: { in: ["COMPLETED", "FAILED", "CANCELLED"] } },
            },
          });

          const lease = await transaction.worktreeWorkflowLease.findUnique({
            where: { worktreeId: run.worktreeId },
          });
          if (lease && run.worktreeLeaseOwnerRunId !== lease.workflowRunId) {
            await transaction.workflowRun.updateMany({
              where: { id: run.id, status: "QUEUED" },
              data: { phase: "WAITING_FOR_WORKTREE" },
            });
            return false;
          }

          if (!lease) {
            const barrier = await transaction.workflowRun.findFirst({
              where: {
                worktreeId: run.worktreeId,
                status: "QUEUED",
                parentRunId: null,
                worktreeConcurrency: "EXCLUSIVE",
              },
              orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
              select: { id: true, queuedAt: true },
            });
            if (
              barrier &&
              barrier.id !== run.id &&
              queueEntryPrecedes(
                barrier.queuedAt,
                barrier.id,
                run.queuedAt,
                run.id,
              )
            ) {
              await transaction.workflowRun.updateMany({
                where: { id: run.id, status: "QUEUED" },
                data: { phase: "WAITING_FOR_WORKTREE" },
              });
              return false;
            }

            if (run.worktreeLeaseOwnerRunId === run.id) {
              const [
                activeAgentRuns,
                activeWorkflows,
                earlierAgentRun,
                earlierWorkflow,
              ] = await Promise.all([
                transaction.worktreeRunLease.count({
                  where: { worktreeId: run.worktreeId },
                }),
                transaction.workflowRun.count({
                  where: {
                    worktreeId: run.worktreeId,
                    id: { not: run.id },
                    worktreeConcurrency: { not: "EXCLUDED" },
                    status: {
                      in: ACTIVE_RUN_STATUSES.filter(
                        (status) => status !== "QUEUED",
                      ),
                    },
                  },
                }),
                transaction.agentRun.findFirst({
                  where: {
                    worktreeId: run.worktreeId,
                    origin: "MANAGED",
                    status: "QUEUED",
                    OR: [
                      { createdAt: { lt: run.queuedAt } },
                      { createdAt: run.queuedAt, id: { lt: run.id } },
                    ],
                  },
                  select: { id: true },
                }),
                transaction.workflowRun.findFirst({
                  where: {
                    worktreeId: run.worktreeId,
                    status: "QUEUED",
                    id: { not: run.id },
                    worktreeConcurrency: { not: "EXCLUDED" },
                    OR: [
                      { queuedAt: { lt: run.queuedAt } },
                      { queuedAt: run.queuedAt, id: { lt: run.id } },
                    ],
                  },
                  select: { id: true },
                }),
              ]);
              if (
                activeAgentRuns ||
                activeWorkflows ||
                earlierAgentRun ||
                earlierWorkflow
              ) {
                await transaction.workflowRun.updateMany({
                  where: { id: run.id, status: "QUEUED" },
                  data: { phase: "WAITING_FOR_WORKTREE" },
                });
                return false;
              }
              await transaction.worktreeWorkflowLease.create({
                data: {
                  worktreeId: run.worktreeId,
                  workflowRunId: run.id,
                },
              });
            }
          }
        }

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
        const existingAttempts = await transaction.workflowStepAttempt.count({
          where: { runId: run.id, generation: run.generation },
        });
        if (!existingAttempts) {
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
        }
        return true;
      });
      if (started) {
        if (!run.startedAt) {
          await this.appendEvent(
            run.id,
            null,
            "RUN_STARTED",
            "Workflow started",
          );
        }
        publishRunChanged(run.id);
      }
    }
  }

  /**
   * The trigger the run entered through, and — for a choice trigger — the
   * option that was picked. The option names the trigger's output handle, so
   * `edgeState` uses it to leave every other entry path inactive.
   */
  private selectedTrigger(
    run: WorkflowRun & { trigger?: WorkflowTrigger | null },
    definition: WorkflowDefinition,
  ): { id: string | null; choice: string | null } {
    const id =
      run.trigger?.nodeId ??
      definition.triggers.find(({ kind }) => kind === run.triggerKind)?.id ??
      null;
    if (!isChoiceTriggerKind(run.triggerKind)) return { id, choice: null };
    const payload = parseObject(
      json(run.triggerPayloadJson),
      "Trigger payload",
    );
    return {
      id,
      choice: typeof payload.choice === "string" ? payload.choice : null,
    };
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
    selectedTrigger: { id: string | null; choice: string | null },
    attempts: Map<string, WorkflowStepAttempt>,
    nodeById: Map<string, WorkflowNodeDefinition>,
  ): "ACTIVE" | "INACTIVE" | "PENDING" {
    if (!nodeById.has(edge.source)) {
      if (edge.source !== selectedTrigger.id) return "INACTIVE";
      // Triggers without a choice fan out of every handle they are wired from,
      // as they always have; a choice run takes only the option's own path.
      return !selectedTrigger.choice ||
        edge.sourceHandle === selectedTrigger.choice
        ? "ACTIVE"
        : "INACTIVE";
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
      await prisma.workflowStepAttempt.updateMany({
        where: { runId, status: "READY" },
        data: { status: "PENDING", phase: "PAUSED_PENDING" },
      });
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
          status === "RUNNING" ||
          (status === "WAITING" && drainingAttemptIds.has(id)),
      );
      if (!active) {
        const paused = await prisma.workflowRun.updateMany({
          where: { id: runId, status: "PAUSING" },
          data: {
            status: "PAUSED",
            phase: "PAUSED",
            pausedAt: new Date(),
          },
        });
        if (paused.count) {
          await this.appendEvent(runId, null, "RUN_PAUSED", "Workflow paused");
          publishRunChanged(runId);
        }
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
      const selectedTrigger = this.selectedTrigger(run, definition);
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
    if (pendingWaits || unfinished) {
      const nextStatus = pendingWaits ? "WAITING" : "RUNNING";
      if (run.status !== nextStatus) {
        const updated = await prisma.workflowRun.updateMany({
          where: {
            id: runId,
            status: { in: [...SCHEDULING_RUN_STATUSES] },
          },
          data: {
            status: nextStatus,
            phase: pendingWaits ? "WAITING" : "SCHEDULING",
          },
        });
        if (updated.count) publishRunChanged(runId);
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
    const finished = await prisma.$transaction(async (transaction) => {
      const result = await transaction.workflowRun.updateMany({
        where: {
          id: run.id,
          status: { in: [...SCHEDULING_RUN_STATUSES] },
        },
        data: {
          status,
          phase: status,
          error,
          finishedAt: new Date(),
        },
      });
      if (!result.count) return false;
      await transaction.workflowResourceLease.deleteMany({
        where: { runId: run.id },
      });
      await transaction.worktreeWorkflowLease.deleteMany({
        where: { workflowRunId: run.id },
      });
      return true;
    });
    if (!finished) return;
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
    await this.promoteWorktreeAdmissions(run.worktreeId);
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
      where: {
        status: "READY",
        run: { status: { in: [...SCHEDULING_RUN_STATUSES] } },
      },
      orderBy: { createdAt: "asc" },
      take: slots * 2,
    });
    for (const attempt of candidates) {
      if (slots <= 0) break;
      const claimed = await prisma.workflowStepAttempt.updateMany({
        where: {
          id: attempt.id,
          status: "READY",
          run: { status: { in: [...SCHEDULING_RUN_STATUSES] } },
        },
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
    if (
      attempt.run.exclusiveWorktree &&
      EXCLUSIVE_WORKTREE_IDENTITY_MUTATION_STEPS.has(node.kind)
    ) {
      await this.failAttempt(
        attempt,
        node,
        new Error(
          "Exclusive workflows cannot run steps that create, delete, or move their worktree",
        ),
      );
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
        await this.parkAttempt(attempt, node, result);
      } else {
        await this.completeAttempt(attempt, node, result);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (await this.holdForBusyCodebase(attempt, failure)) return;
      await this.failAttempt(attempt, node, failure);
    }
  }

  /**
   * Puts a step back in the queue when the codebase it needs is momentarily
   * occupied, instead of failing the run.
   *
   * The codebase allows one active agent job at a time, so a step can lose the
   * race to unrelated work — a diff the UI happens to be refreshing, a sync
   * someone started by hand. That contention says nothing about the step, and
   * the error is raised before any agent job exists, so re-running it is safe.
   * The step holds in `WAITING_FOR_RESOURCE` and the runtime re-dispatches it
   * every tick until the codebase frees up or {@link RESOURCE_HOLD_TIMEOUT_MS}
   * passes, at which point the failure is real and the run fails as before.
   */
  private async holdForBusyCodebase(
    attempt: WorkflowStepAttempt,
    error: Error,
  ): Promise<boolean> {
    if (!isCodebaseBusyError(error)) return false;
    const holdingSince = attempt.startedAt ?? attempt.createdAt;
    if (Date.now() - holdingSince.getTime() > RESOURCE_HOLD_TIMEOUT_MS) {
      return false;
    }
    const prisma = await getPrismaClient();
    const held = await prisma.workflowStepAttempt.updateMany({
      where: { id: attempt.id, status: "RUNNING", claimOwner: this.workerId },
      data: {
        status: "READY",
        phase: "WAITING_FOR_RESOURCE",
        error: error.message,
        claimOwner: null,
        claimExpiresAt: null,
      },
    });
    if (!held.count) return false;
    await prisma.workflowResourceLease.deleteMany({
      where: { attemptId: attempt.id },
    });
    const existingWaitEvent = await prisma.workflowRunEvent.findFirst({
      where: {
        attemptId: attempt.id,
        type: "STEP_WAITING_FOR_RESOURCE",
      },
      select: { id: true },
    });
    if (!existingWaitEvent) {
      await this.appendEvent(
        attempt.runId,
        attempt.id,
        "STEP_WAITING_FOR_RESOURCE",
        "Step is waiting for the codebase to become available",
        { error: error.message },
      );
    }
    publishRunChanged(attempt.runId);
    return true;
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
        const cadenceSeconds = waitCadenceSeconds(node.config, 15);
        return {
          wait: {
            kind: "PREDICATE",
            predicate: {
              condition: condition as unknown as Record<string, unknown>,
              cadenceSeconds,
            },
            resumeAfter: new Date(Date.now() + cadenceSeconds * 1_000),
            timeoutAt: waitTimeoutAt(node.config),
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
    selectedTrigger: { id: string | null; choice: string | null },
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
      wait: {
        kind: "WORKFLOW_RUN",
        externalKey: child.id,
        resumeAfter: waitResumeAfter(node.config),
        timeoutAt: waitTimeoutAt(node.config),
      },
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
    return {
      output: { questionBatchId: batchId },
      wait: {
        kind: "HUMAN",
        externalKey: batchId,
        timeoutAt: waitTimeoutAt(node.config),
      },
    };
  }

  private async parkAttempt(
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    result: WorkflowExecutionResult,
  ): Promise<void> {
    const wait = result.wait;
    if (!wait) throw new Error("Workflow wait is missing");
    const prisma = await getPrismaClient();
    const waitId = randomUUID();
    const parked = await prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findUnique({
        where: { id: attempt.runId },
      });
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;
      let sessionData = workflowSessionData(run.sessionDataJson ?? "{}");
      const applySessionPatchEarly =
        !attempt.iterationKey &&
        (node.kind === "SAVED_COMMAND" || node.kind === "CUSTOM_COMMAND");
      if (applySessionPatchEarly && result.sessionPatch) {
        sessionData = mergeSessionData(sessionData, result.sessionPatch);
      }
      assertExclusiveWorktreeUnchanged(run, sessionData);
      const serializedSession = JSON.stringify(sessionData);
      assertSize(serializedSession, "Workflow session data", MAX_SESSION_BYTES);
      const claimed = await transaction.workflowStepAttempt.updateMany({
        where: { id: attempt.id, status: "RUNNING" },
        data: {
          status: "WAITING",
          phase: wait.kind,
          outputJson: JSON.stringify({
            value: result.output,
            selectedHandles: result.selectedHandles,
            sessionPatch: applySessionPatchEarly
              ? undefined
              : result.sessionPatch,
          }),
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      if (!claimed.count) return false;
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
      await transaction.workflowRun.updateMany({
        where: {
          id: attempt.runId,
          status: { in: [...SCHEDULING_RUN_STATUSES] },
        },
        data: {
          status: "WAITING",
          phase: wait.kind,
          sessionDataJson: serializedSession,
          sessionRevision: { increment: 1 },
        },
      });
      await transaction.workflowResourceLease.deleteMany({
        where: { attemptId: attempt.id },
      });
      return true;
    });
    if (!parked) return;
    await this.appendEvent(
      attempt.runId,
      attempt.id,
      "STEP_WAITING",
      waitingMessage(node, wait),
      {
        waitId,
        kind: wait.kind,
        nodeId: node.id,
        externalKey: wait.externalKey ?? null,
        resumeAfter: wait.resumeAfter?.toISOString() ?? null,
        timeoutAt: wait.timeoutAt?.toISOString() ?? null,
      },
    );
    publishRunChanged(attempt.runId);
  }

  private async completeAttempt(
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    result: WorkflowExecutionResult,
    beforeSuccessEvent?: () => Promise<void>,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const completed = await prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findUnique({
        where: { id: attempt.runId },
      });
      if (!run) throw new Error("Workflow run disappeared");
      if (TERMINAL_RUN_STATUSES.has(run.status)) return false;
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
        const stepPath = `steps.${node.id}`;
        const existingStep = recordValue(
          getSessionValue(sessionData, stepPath),
        );
        sessionData = setSessionValue(sessionData, stepPath, {
          ...existingStep,
          status: "SUCCEEDED",
          output: result.output ?? null,
          snapshotId:
            result.links?.find(({ kind }) => kind === "CHECKPOINT")
              ?.resourceId ?? null,
        });
      }
      assertExclusiveWorktreeUnchanged(run, sessionData);
      const serialized = JSON.stringify(sessionData);
      assertSize(serialized, "Workflow session data", MAX_SESSION_BYTES);
      const claimed = await transaction.workflowStepAttempt.updateMany({
        where: {
          id: attempt.id,
          status: { in: ["RUNNING", "WAITING"] },
        },
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
      if (!claimed.count) return false;
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
        },
      });
      await transaction.workflowRun.updateMany({
        where: {
          id: attempt.runId,
          status: { in: [...SCHEDULING_RUN_STATUSES] },
        },
        data: { status: "RUNNING", phase: "SCHEDULING" },
      });
      await transaction.workflowResourceLease.deleteMany({
        where: { attemptId: attempt.id },
      });
      return true;
    });
    if (!completed) return;
    if (beforeSuccessEvent) {
      try {
        await beforeSuccessEvent();
      } catch (error) {
        // The state transition already succeeded. Timeline diagnostics must not
        // turn an observability failure into a permanently parked workflow.
        console.error(
          `Failed to append completion diagnostics for workflow attempt ${attempt.id}:`,
          error,
        );
      }
    }
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
    result: WorkflowExecutionResult = {},
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
    const failed = await prisma.$transaction(async (transaction) => {
      const run = await transaction.workflowRun.findUnique({
        where: { id: attempt.runId },
      });
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return false;
      let sessionData = workflowSessionData(run.sessionDataJson);
      if (!attempt.iterationKey) {
        if (result.sessionPatch) {
          sessionData = mergeSessionData(sessionData, result.sessionPatch);
        }
        const stepPath = `steps.${attempt.nodeId}`;
        const existingStep = recordValue(
          getSessionValue(sessionData, stepPath),
        );
        sessionData = setSessionValue(sessionData, stepPath, {
          ...existingStep,
          status: "FAILED",
          error: error.message,
          ...(result.output !== undefined ? { output: result.output } : {}),
        });
      }
      assertExclusiveWorktreeUnchanged(run, sessionData);
      const serializedSession = JSON.stringify(sessionData);
      assertSize(serializedSession, "Workflow session data", MAX_SESSION_BYTES);
      const claimed = await transaction.workflowStepAttempt.updateMany({
        where: {
          id: attempt.id,
          status: { in: ["RUNNING", "WAITING"] },
        },
        data: {
          status: "FAILED",
          phase: shouldRetry ? "RETRY_SCHEDULED" : "FAILED",
          error: error.message.slice(0, 20_000),
          finishedAt: new Date(),
          claimOwner: null,
          claimExpiresAt: null,
        },
      });
      if (!claimed.count) return false;
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
          sessionDataJson: serializedSession,
          sessionRevision: { increment: 1 },
        },
      });
      await transaction.workflowRun.updateMany({
        where: {
          id: attempt.runId,
          status: { in: [...SCHEDULING_RUN_STATUSES] },
        },
        data: {
          status: shouldRetry ? "WAITING" : "RUNNING",
          phase: shouldRetry ? "RETRY_WAIT" : "SCHEDULING",
        },
      });
      await transaction.workflowResourceLease.deleteMany({
        where: { attemptId: attempt.id },
      });
      return true;
    });
    if (!failed) return;
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
    const updatePendingWait = (
      id: string,
      data: Parameters<typeof prisma.workflowWait.updateMany>[0]["data"],
    ) =>
      prisma.workflowWait.updateMany({
        where: {
          id,
          status: "PENDING",
          run: { status: { in: [...SCHEDULING_RUN_STATUSES] } },
        },
        data,
      });
    const waits = await prisma.workflowWait.findMany({
      where: {
        status: "PENDING",
        run: { status: { in: [...SCHEDULING_RUN_STATUSES] } },
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
        const timedOut = await updatePendingWait(wait.id, {
          status: "TIMED_OUT",
          resolvedAt: now,
        });
        if (!timedOut.count) continue;
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
        const resumed = await prisma.$transaction(async (transaction) => {
          const resolved = await transaction.workflowWait.updateMany({
            where: {
              id: wait.id,
              status: "PENDING",
              run: { status: { in: [...SCHEDULING_RUN_STATUSES] } },
            },
            data: { status: "RESOLVED", resolvedAt: now },
          });
          if (!resolved.count) return false;
          await transaction.workflowStepAttempt.create({
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
          });
          const run = await transaction.workflowRun.updateMany({
            where: {
              id: wait.runId,
              status: { in: [...SCHEDULING_RUN_STATUSES] },
            },
            data: { status: "RUNNING", phase: "SCHEDULING" },
          });
          if (!run.count) {
            throw new Error("Workflow lifecycle changed while resuming retry");
          }
          return true;
        });
        if (resumed) publishRunChanged(wait.runId);
      } else if (wait.kind === "DELAY") {
        const resolved = await updatePendingWait(wait.id, {
          status: "RESOLVED",
          resolvedAt: now,
        });
        if (!resolved.count) continue;
        await this.completeWaitingAttempt(
          wait.attemptId,
          { delayed: true },
          "TIMER",
        );
      } else if (wait.kind === "PREDICATE") {
        const predicate = wait.predicateJson
          ? parseObject(json(wait.predicateJson), "Wait predicate")
          : {};
        const condition = predicate.condition as WorkflowCondition | undefined;
        const data = workflowSessionData(wait.attempt.run.sessionDataJson);
        if (condition && evaluateWorkflowCondition(condition, data)) {
          const resolved = await updatePendingWait(wait.id, {
            status: "RESOLVED",
            resultJson: JSON.stringify({ matched: true }),
            resolvedAt: now,
          });
          if (!resolved.count) continue;
          await this.completeWaitingAttempt(
            wait.attemptId,
            { matched: true },
            "POLL",
          );
        } else {
          const cadenceSeconds = Math.max(
            1,
            Number(predicate.cadenceSeconds ?? 15),
          );
          await updatePendingWait(wait.id, {
            resumeAfter: new Date(Date.now() + cadenceSeconds * 1_000),
          });
        }
      } else if (wait.externalKey && this.waitPollers.has(wait.kind)) {
        const polled = await this.waitPollers.get(wait.kind)!(wait.externalKey);
        if (wait.kind === "COMMAND_RUN" && !polled.pending) {
          // Command completion is reported only after output upload, but that
          // upload and this poll can still interleave. Scan once more before
          // resolving the wait so the terminal edge never outruns its final
          // match emission.
          await this.reconcileCommandOutputMatches(wait.externalKey);
        }
        if (polled.pending) {
          // The poller proposes a cadence for its resource; an author who set
          // one on the step overrides it.
          const config =
            parseWorkflowDefinition(
              json(wait.attempt.run.version.definitionJson),
            ).nodes.find(({ id }) => id === wait.attempt.nodeId)?.config ?? {};
          await updatePendingWait(wait.id, {
            resumeAfter: new Date(
              Date.now() +
                waitCadenceSeconds(config, polled.pollAfterSeconds ?? 15) *
                  1_000,
            ),
          });
        } else {
          const resolved = await updatePendingWait(wait.id, {
            status: polled.error ? "FAILED" : "RESOLVED",
            resultJson: JSON.stringify(polled.result ?? {}),
            resolvedAt: new Date(),
          });
          if (!resolved.count) continue;
          if (polled.error) {
            const node = parseWorkflowDefinition(
              json(wait.attempt.run.version.definitionJson),
            ).nodes.find(({ id }) => id === wait.attempt.nodeId);
            const pending = this.attemptOutput(wait.attempt) as {
              value?: unknown;
              sessionPatch?: SessionData;
            };
            const output = recordValue(polled.result);
            const finalPatch =
              output.sessionPatch &&
              typeof output.sessionPatch === "object" &&
              !Array.isArray(output.sessionPatch)
                ? mergeSessionData(
                    pending.sessionPatch ?? {},
                    output.sessionPatch as SessionData,
                  )
                : pending.sessionPatch;
            await this.failAttempt(
              wait.attempt,
              node ?? null,
              new Error(polled.error),
              {
                output: polled.result ?? pending.value,
                sessionPatch: finalPatch,
              },
            );
          } else {
            await this.completeWaitingAttempt(
              wait.attemptId,
              polled.result ?? {},
              "POLL",
            );
          }
        }
      }
    }
  }

  private async completeWaitingAttempt(
    attemptId: string,
    output: unknown,
    resolvedBy: WaitResolutionSource = "PUSH",
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
        setSessionValue({}, "worktree", {
          id: (output as Record<string, unknown>).id,
          pushStatus: (output as Record<string, unknown>).pushStatus,
        }),
      );
    }
    if (
      node.kind === "SKILL_APPLY" &&
      output &&
      typeof output === "object" &&
      !Array.isArray(output)
    ) {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        setSessionValue({}, `steps.${node.id}`, output),
      );
    }
    if (node.kind === "HUMAN_CONFIRM" || node.kind === "HUMAN_CHOICE") {
      sessionPatch = mergeSessionData(
        sessionPatch ?? {},
        setSessionValue({}, `steps.${node.id}.answer`, output),
      );
    }
    try {
      await this.completeAttempt(
        attempt,
        node,
        {
          output: output ?? pending.value,
          selectedHandles: pending.selectedHandles,
          sessionPatch,
        },
        () => this.appendWaitResolvedEvent(attempt, node, resolvedBy),
      );
    } catch (error) {
      await this.failAttempt(
        attempt,
        node,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
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
        await this.completeWaitingAttempt(wait.attemptId, result, "PUSH");
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
    assertExclusiveWorktreeUnchanged(run, sessionData);
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
          status: run.worktreeId ? "QUEUED" : "RUNNING",
          phase: run.worktreeId ? "WAITING_FOR_WORKTREE" : "REPLAYING",
          queuedAt: run.worktreeId ? new Date() : run.queuedAt,
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
    if (run.worktreeId) await this.startQueuedRuns();
    publishRunChanged(runId);
    return this.run(runId);
  }

  /**
   * Records that a parked step is moving again, and what freed it.
   *
   * Until this event existed a wait ended silently — the row flipped to
   * `RESOLVED` and the next thing in the timeline was the step succeeding, so
   * the only readable trace of a two-second wait and a fifty-minute one was the
   * gap between timestamps. `resolvedBy` carries the diagnostic that matters:
   * an `AGENT_JOB` wait that consistently resolves by `POLL` rather than the
   * `PUSH` from {@link resolveExternalWait} means the completion callback is
   * not firing, and the run is only finishing because the poller swept it up.
   */
  private async appendWaitResolvedEvent(
    attempt: WorkflowStepAttempt,
    node: WorkflowNodeDefinition,
    resolvedBy: WaitResolutionSource,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    const wait = await prisma.workflowWait.findFirst({
      where: { attemptId: attempt.id },
      orderBy: { createdAt: "desc" },
    });
    if (!wait) return;
    const waitedMs = Math.max(
      0,
      (wait.resolvedAt ?? new Date()).getTime() - wait.createdAt.getTime(),
    );
    await this.appendEvent(
      attempt.runId,
      attempt.id,
      "STEP_WAIT_RESOLVED",
      `Step ${node.name ?? node.id} resumed after waiting ${waitElapsedText(waitedMs)} for ${waitKindText(wait.kind)}`,
      {
        waitId: wait.id,
        kind: wait.kind,
        nodeId: node.id,
        externalKey: wait.externalKey,
        waitedMs,
        resolvedBy,
      },
    );
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
