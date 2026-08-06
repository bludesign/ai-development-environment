import "server-only";

import { randomUUID } from "node:crypto";

import {
  COMMAND_RUN_JOB_KIND,
  MAX_COMMAND_OUTPUT_BATCH_CHUNKS,
} from "@ai-development-environment/agent-contract/commands";

import { getPrismaClient } from "@/data/prisma-client";
import { isCodebaseBusyError } from "@/lib/codebase-busy";
import {
  COMMAND_RUNS_CHANGED_TOPIC,
  COMMAND_RUN_OUTPUT_CHANGED_TOPIC,
  COMMANDS_CHANGED_TOPIC,
  SIDEBAR_STATUS_CHANGED_TOPIC,
  agentEventBus,
  agentOnlineWindowMs,
  commandRunChangedTopic,
  commandRunOutputTopic,
  type AgentControlService,
} from "@/services/agent-control";
import type { NotificationsService } from "@/services/notifications";

const TARGETS = [
  "ANY_AGENT_HOME",
  "SPECIFIC_AGENT_HOME",
  "ANY_WORKTREE",
  "REPOSITORY_WORKTREE",
] as const;
const RESTART_POLICIES = ["NEVER", "ON_FAILURE", "ALWAYS"] as const;
const CONCURRENCY_MODES = ["EXCLUSIVE", "NON_EXCLUSIVE", "EXCLUDED"] as const;
const ACTIVE_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "RESTARTING",
  "CANCELLING",
] as const;
const FINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
const TERMINAL_JOB_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;

/**
 * A stop request can only be carried out by the agent while its job is still
 * live. Once the job has reported back — or was never created — there is
 * nothing left to cancel and the run has to be finished directly, otherwise it
 * sits in `CANCELLING` waiting for a completion that will never arrive.
 */
const cancellableJob = (job: { status: string } | null | undefined) =>
  Boolean(job && !TERMINAL_JOB_STATUSES.includes(job.status as never));
const RESTART_DELAY_MS = 1_000;
const STABLE_ATTEMPT_MS = 60_000;
const EXPORT_FORMAT = "aide.command.export";
const EXPORT_SCHEMA_VERSION = 1;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export type CommandDefinitionInput = {
  name: string;
  description?: string | null;
  script: string;
  targetKind: string;
  targetAgentId?: string | null;
  targetRepositoryId?: string | null;
  restartPolicy?: string | null;
  restartLimit?: number | null;
  concurrency?: string | null;
  blocksGitOperations?: boolean | null;
  quickActionEnabled?: boolean | null;
  quickActionIconKey?: string | null;
  quickActionButtonVariant?: string | null;
  notificationsEnabled?: boolean | null;
};

export type StartCommandRunInput = {
  commandId: string;
  agentId?: string | null;
  worktreeId?: string | null;
  origin?: string | null;
  idempotencyKey?: string | null;
  blocksGitOperations?: boolean | null;
};

export type StartCustomCommandRunInput = {
  script: string;
  agentId?: string | null;
  worktreeId?: string | null;
  origin?: string | null;
  idempotencyKey?: string | null;
  blocksGitOperations?: boolean | null;
};

type RunResult = {
  exitCode?: number | null;
  signal?: string | null;
  cancelled?: boolean;
  timedOut?: boolean;
};

export function evaluateCommandRestart(input: {
  policy: string;
  limit: number | null;
  restartCount: number;
  durationMs: number;
  clean: boolean;
  manualStop: boolean;
}): { restart: boolean; restartCount: number; exhausted: boolean } {
  if (input.manualStop) {
    return {
      restart: false,
      restartCount: input.restartCount,
      exhausted: false,
    };
  }
  const eligible =
    input.policy === "ALWAYS" ||
    (input.policy === "ON_FAILURE" && !input.clean);
  if (!eligible) {
    return {
      restart: false,
      restartCount: input.restartCount,
      exhausted: false,
    };
  }
  const restartCount =
    (input.durationMs >= STABLE_ATTEMPT_MS ? 0 : input.restartCount) + 1;
  const exhausted = input.limit !== null && restartCount > input.limit;
  return { restart: !exhausted, restartCount, exhausted };
}

export type CommandConcurrencyPeer = {
  id: string;
  concurrency: string;
  queuedAt: Date;
};

/**
 * Decides whether a waiting run may take its target now.
 *
 * A target is either one worktree or one agent home, and the modes behave like
 * a reader-writer lock over it: `EXCLUSIVE` runs alone, `NON_EXCLUSIVE` runs
 * alongside other `NON_EXCLUSIVE` runs, and `EXCLUDED` neither waits nor makes
 * anything else wait.
 *
 * `holders` are runs that already own the target — they have a dispatched
 * attempt that has not reported back. `waiting` are runs queued for the same
 * target with nothing dispatched yet, including the candidate itself.
 *
 * Queue order breaks the two ways this could starve. An `EXCLUSIVE` run waits
 * until it is the oldest waiter, so two of them cannot both decide the target
 * is free; a `NON_EXCLUSIVE` run yields to any `EXCLUSIVE` run queued ahead of
 * it, so a steady stream of shared work cannot hold the target forever.
 */
export function admitCommandRun(input: {
  candidate: CommandConcurrencyPeer;
  holders: Array<Pick<CommandConcurrencyPeer, "id" | "concurrency">>;
  waiting: CommandConcurrencyPeer[];
}): boolean {
  if (input.candidate.concurrency === "EXCLUDED") return true;
  const holders = input.holders.filter(
    (peer) => peer.concurrency !== "EXCLUDED" && peer.id !== input.candidate.id,
  );
  // Ties on the queue timestamp are broken by id so every waiter agrees on the
  // same order; SQLite timestamps are coarse enough for runs started together
  // to share one.
  const ahead = input.waiting
    .filter(
      (peer) =>
        peer.concurrency !== "EXCLUDED" && peer.id !== input.candidate.id,
    )
    .filter((peer) => {
      const delta =
        peer.queuedAt.getTime() - input.candidate.queuedAt.getTime();
      return delta !== 0 ? delta < 0 : peer.id < input.candidate.id;
    });
  if (input.candidate.concurrency === "EXCLUSIVE") {
    return holders.length === 0 && ahead.length === 0;
  }
  return (
    !holders.some((peer) => peer.concurrency === "EXCLUSIVE") &&
    !ahead.some((peer) => peer.concurrency === "EXCLUSIVE")
  );
}

/** One run competing for a target, as shown in a run's queue. */
export type CommandQueueMember = CommandConcurrencyPeer & {
  displayNumber: number;
  name: string;
  status: string;
  /** True once the run owns the target: its attempt has a job still in flight. */
  holdingTarget: boolean;
};

export type CommandRunQueueReason =
  | "NOT_QUEUED"
  | "WAITING_FOR_AGENT"
  | "AGENT_OFFLINE"
  | "WAITING_FOR_PREDECESSOR"
  | "RESTART_DELAY"
  | "TARGET_BUSY"
  | "QUEUED_BEHIND"
  | "READY";

export type CommandRunQueueEntry = CommandQueueMember & {
  blocking: boolean;
  currentRun: boolean;
};

export type CommandRunQueue = {
  reason: CommandRunQueueReason;
  position: number;
  waitingCount: number;
  entries: CommandRunQueueEntry[];
};

const QUEUEABLE_RUN_STATUSES = ["QUEUED", "RESTARTING"];

// The same order {@link admitCommandRun} uses to decide who goes first, so the
// list the run detail page renders is the order the dispatcher will follow.
const byQueueOrder = (left: CommandQueueMember, right: CommandQueueMember) =>
  left.queuedAt.getTime() - right.queuedAt.getTime() ||
  left.id.localeCompare(right.id);

/**
 * Explains why a run has not started and reconstructs the wait line for its
 * target. The blocking peers are exactly the ones {@link admitCommandRun}
 * consults, so a run reported as `TARGET_BUSY` or `QUEUED_BEHIND` names the
 * runs that will actually be waited on.
 *
 * A run that already handed its work to an agent is no longer in the line: it
 * is either waiting for that agent to pick the job up or waiting for an agent
 * that is not connected, which is the difference between `WAITING_FOR_AGENT`
 * and `AGENT_OFFLINE`.
 */
export function evaluateCommandRunQueue(input: {
  candidate: CommandQueueMember & { stopRequested: boolean };
  peers: CommandQueueMember[];
  agentOnline: boolean;
  predecessorPending: boolean;
  restartPending: boolean;
}): CommandRunQueue {
  const { candidate } = input;
  const competing = candidate.concurrency !== "EXCLUDED";
  const heldByPeers = input.peers.filter((peer) => peer.holdingTarget);
  // The candidate belongs to whichever group it is in, so the rendered list is
  // the whole picture for the target rather than everyone except the run being
  // looked at.
  const holders = [
    ...heldByPeers,
    ...(candidate.holdingTarget ? [candidate] : []),
  ].sort(byQueueOrder);
  const line = [
    ...input.peers.filter((peer) => !peer.holdingTarget),
    ...(candidate.holdingTarget ? [] : [candidate]),
  ].sort(byQueueOrder);
  const index = line.findIndex((peer) => peer.id === candidate.id);
  const ahead = index < 0 ? [] : line.slice(0, index);
  const blocks = (peer: CommandQueueMember) =>
    competing &&
    peer.concurrency !== "EXCLUDED" &&
    (candidate.concurrency === "EXCLUSIVE" || peer.concurrency === "EXCLUSIVE");
  const blockingHolders = heldByPeers.filter(blocks);
  const blockingAhead = ahead.filter(blocks);
  const reason = ((): CommandRunQueueReason => {
    if (
      candidate.stopRequested ||
      !QUEUEABLE_RUN_STATUSES.includes(candidate.status)
    ) {
      return "NOT_QUEUED";
    }
    if (candidate.holdingTarget)
      return input.agentOnline ? "WAITING_FOR_AGENT" : "AGENT_OFFLINE";
    if (input.predecessorPending) return "WAITING_FOR_PREDECESSOR";
    if (input.restartPending) return "RESTART_DELAY";
    if (blockingHolders.length) return "TARGET_BUSY";
    if (blockingAhead.length) return "QUEUED_BEHIND";
    if (!input.agentOnline) return "AGENT_OFFLINE";
    return "READY";
  })();
  const blocking = new Set(
    reason === "TARGET_BUSY" || reason === "QUEUED_BEHIND"
      ? [...blockingHolders, ...blockingAhead].map((peer) => peer.id)
      : [],
  );
  return {
    reason,
    position: index < 0 ? 0 : index + 1,
    waitingCount: line.length,
    entries: [...holders, ...line].map((peer) => ({
      ...peer,
      blocking: blocking.has(peer.id),
      currentRun: peer.id === candidate.id,
    })),
  };
}

function enumValue<T extends readonly string[]>(
  values: T,
  value: string,
  label: string,
): T[number] {
  const normalized = value.trim().toUpperCase();
  if (!values.includes(normalized as T[number])) {
    throw new Error(`${label} is not supported`);
  }
  return normalized as T[number];
}

function text(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function importObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

const importedText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function capabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseResult(value: string | null): RunResult {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as RunResult) : {};
  } catch {
    return {};
  }
}

function publishDefinition(definition: unknown): void {
  agentEventBus.publish(COMMANDS_CHANGED_TOPIC, {
    commandsChanged: definition,
  });
}

function publishRun(run: { id: string }): void {
  agentEventBus.publish(COMMAND_RUNS_CHANGED_TOPIC, {
    commandRunsChanged: run,
  });
  agentEventBus.publish(commandRunChangedTopic(run.id), {
    commandRunChanged: run,
  });
  agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
    sidebarStatusChanged: true,
  });
}

export class CommandsService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciliation: Promise<void> | null = null;
  private dispatchChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly agentControl: AgentControlService,
    private readonly notifications?: NotificationsService,
  ) {
    this.agentControl.registerCompletionHandler(COMMAND_RUN_JOB_KIND, (job) =>
      this.handleAttemptCompletion(job),
    );
    this.agentControl.registerConnectionHandler((agentId) =>
      this.reconcileWithReporting({ agentId }),
    );
  }

  startRuntime(): void {
    if (this.timer) return;
    void this.reconcileWithReporting();
    this.timer = setInterval(() => void this.reconcileWithReporting(), 1_000);
    this.timer.unref();
  }

  private async reconcileWithReporting(
    input: { agentId?: string } = {},
  ): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcile(input);
    try {
      await this.reconciliation;
    } catch (error) {
      if (process.env.NODE_ENV !== "test")
        console.error("Command runtime reconciliation failed:", error);
    } finally {
      this.reconciliation = null;
    }
  }

  async listDefinitions(includeArchived = false) {
    const prisma = await getPrismaClient();
    return prisma.commandDefinition.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      include: { targetAgent: true, targetRepository: true },
      orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    });
  }

  async getDefinition(id: string) {
    const prisma = await getPrismaClient();
    return prisma.commandDefinition.findUnique({
      where: { id },
      include: { targetAgent: true, targetRepository: true },
    });
  }

  private normalizeDefinition(input: CommandDefinitionInput) {
    const targetKind = enumValue(TARGETS, input.targetKind, "Target scope");
    const restartPolicy = enumValue(
      RESTART_POLICIES,
      input.restartPolicy ?? "NEVER",
      "Restart policy",
    );
    const restartLimit =
      input.restartLimit === undefined ? 3 : input.restartLimit;
    if (
      restartLimit !== null &&
      (!Number.isInteger(restartLimit) ||
        restartLimit < 0 ||
        restartLimit > 100)
    ) {
      throw new Error("Restart limit must be null or an integer from 0 to 100");
    }
    const needsAgent = targetKind === "SPECIFIC_AGENT_HOME";
    const needsRepository = targetKind === "REPOSITORY_WORKTREE";
    if (needsAgent !== Boolean(input.targetAgentId)) {
      throw new Error(
        needsAgent
          ? "A specific-agent command requires an agent"
          : "This target scope does not accept a specific agent",
      );
    }
    if (needsRepository !== Boolean(input.targetRepositoryId)) {
      throw new Error(
        needsRepository
          ? "A repository-worktree command requires a repository"
          : "This target scope does not accept a repository",
      );
    }
    const concurrency = enumValue(
      CONCURRENCY_MODES,
      input.concurrency ?? "NON_EXCLUSIVE",
      "Concurrency",
    );
    return {
      name: text(input.name, "Name", 120),
      description: (input.description ?? "").trim().slice(0, 2_000),
      script: text(input.script, "Script", 1_000_000),
      targetKind,
      targetAgentId: input.targetAgentId ?? null,
      targetRepositoryId: input.targetRepositoryId ?? null,
      restartPolicy,
      restartLimit,
      concurrency,
      blocksGitOperations:
        concurrency === "EXCLUSIVE"
          ? true
          : (input.blocksGitOperations ?? false),
      quickActionEnabled: input.quickActionEnabled ?? false,
      quickActionIconKey: text(
        input.quickActionIconKey ?? "terminal",
        "Quick action icon",
        40,
      ),
      quickActionButtonVariant: text(
        input.quickActionButtonVariant ?? "default",
        "Quick action style",
        40,
      ),
      notificationsEnabled: input.notificationsEnabled ?? true,
    };
  }

  async createDefinition(input: CommandDefinitionInput) {
    const prisma = await getPrismaClient();
    const definition = await prisma.commandDefinition.create({
      data: { id: randomUUID(), ...this.normalizeDefinition(input) },
      include: { targetAgent: true, targetRepository: true },
    });
    publishDefinition(definition);
    return definition;
  }

  async updateDefinition(id: string, input: CommandDefinitionInput) {
    const prisma = await getPrismaClient();
    const definition = await prisma.commandDefinition.update({
      where: { id },
      data: this.normalizeDefinition(input),
      include: { targetAgent: true, targetRepository: true },
    });
    publishDefinition(definition);
    return definition;
  }

  async deleteDefinition(id: string) {
    const prisma = await getPrismaClient();
    const definition = await prisma.commandDefinition.findUnique({
      where: { id },
    });
    if (!definition) return false;
    if (await prisma.commandRun.count({ where: { commandId: id } })) {
      throw new Error(
        "Archive commands that have run history instead of deleting them",
      );
    }
    await prisma.commandDefinition.delete({ where: { id } });
    publishDefinition(definition);
    return true;
  }

  async exportDefinition(id: string) {
    const definition = await this.getDefinition(id);
    if (!definition) throw new Error("Command not found");
    return {
      format: EXPORT_FORMAT,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      command: {
        name: definition.name,
        description: definition.description,
        script: definition.script,
        targetKind: definition.targetKind,
        // Identifiers are per-install, so a scoped target travels by name and
        // is resolved again on import.
        targetAgentName: definition.targetAgent?.name ?? null,
        targetRepositoryName: definition.targetRepository?.name ?? null,
        restartPolicy: definition.restartPolicy,
        restartLimit: definition.restartLimit,
        concurrency: definition.concurrency,
        blocksGitOperations: definition.blocksGitOperations,
        quickActionEnabled: definition.quickActionEnabled,
        quickActionIconKey: definition.quickActionIconKey,
        quickActionButtonVariant: definition.quickActionButtonVariant,
        notificationsEnabled: definition.notificationsEnabled,
      },
    };
  }

  /**
   * Matches an exported agent or repository target to a local record. A target
   * that no longer exists widens to the unscoped equivalent rather than
   * failing the import, which is the usual outcome across two installs.
   *
   * Widening is reported back because it changes where the script may run: a
   * command pinned to one machine becomes eligible on every agent, so the
   * caller has to decide whether it still deserves a one-click quick action.
   *
   * Names are not unique, so lookups are ordered to make the chosen record
   * deterministic instead of leaving it to whatever the database returns first.
   */
  private async resolveImportTarget(command: Record<string, unknown>) {
    const targetKind = enumValue(
      TARGETS,
      importedText(command.targetKind) ?? "ANY_AGENT_HOME",
      "Target scope",
    );
    const prisma = await getPrismaClient();
    if (targetKind === "SPECIFIC_AGENT_HOME") {
      const name = importedText(command.targetAgentName);
      const agent = name
        ? await prisma.agent.findFirst({
            where: { name },
            orderBy: { id: "asc" },
          })
        : null;
      return agent
        ? {
            targetKind,
            targetAgentId: agent.id,
            targetRepositoryId: null,
            widened: false,
          }
        : {
            targetKind: "ANY_AGENT_HOME" as const,
            targetAgentId: null,
            targetRepositoryId: null,
            widened: true,
          };
    }
    if (targetKind === "REPOSITORY_WORKTREE") {
      const name = importedText(command.targetRepositoryName);
      const repository = name
        ? await prisma.codebaseRepository.findFirst({
            where: { name },
            orderBy: { id: "asc" },
          })
        : null;
      return repository
        ? {
            targetKind,
            targetAgentId: null,
            targetRepositoryId: repository.id,
            widened: false,
          }
        : {
            targetKind: "ANY_WORKTREE" as const,
            targetAgentId: null,
            targetRepositoryId: null,
            widened: true,
          };
    }
    return {
      targetKind,
      targetAgentId: null,
      targetRepositoryId: null,
      widened: false,
    };
  }

  async importDefinition(input: { payload: unknown; name?: string | null }) {
    // Only a string payload is worth measuring: it is still unparsed, so the
    // limit saves the parse. An object payload came through the `JSON` scalar
    // already materialized, and measuring it would mean serializing the whole
    // thing back just to look at its size — `normalizeDefinition` bounds every
    // field that actually reaches the database anyway.
    let payload = input.payload;
    if (typeof payload === "string") {
      if (Buffer.byteLength(payload, "utf8") > MAX_IMPORT_BYTES) {
        throw new Error("Command import is too large");
      }
      payload = JSON.parse(payload);
    }
    const object = importObject(payload, "Command import");
    // A bare command definition is accepted alongside a wrapped export so a
    // hand-written file does not need the envelope.
    const command =
      object.format === EXPORT_FORMAT
        ? importObject(object.command, "Exported command")
        : object;
    const { widened, ...target } = await this.resolveImportTarget(command);
    const name = input.name?.trim() || importedText(command.name);
    if (!name) throw new Error("Name is required");
    const script = importedText(command.script);
    if (!script) throw new Error("Script is required");
    return this.createDefinition({
      name,
      description:
        typeof command.description === "string" ? command.description : "",
      script,
      ...target,
      restartPolicy: importedText(command.restartPolicy) ?? "NEVER",
      restartLimit:
        command.restartLimit === null ||
        typeof command.restartLimit === "number"
          ? (command.restartLimit as number | null)
          : 3,
      concurrency: importedText(command.concurrency) ?? "NON_EXCLUSIVE",
      blocksGitOperations: command.blocksGitOperations === true,
      // A widened target means this script was pinned to a machine or
      // repository that does not exist here. Running it anywhere is a decision
      // for whoever imported it, so the one-click button stays off until they
      // pick a target themselves.
      quickActionEnabled: !widened && command.quickActionEnabled === true,
      quickActionIconKey:
        importedText(command.quickActionIconKey) ?? "terminal",
      quickActionButtonVariant:
        importedText(command.quickActionButtonVariant) ?? "default",
      notificationsEnabled: command.notificationsEnabled !== false,
    });
  }

  async archiveDefinition(id: string, archived: boolean) {
    const prisma = await getPrismaClient();
    const definition = await prisma.commandDefinition.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
      include: { targetAgent: true, targetRepository: true },
    });
    publishDefinition(definition);
    return definition;
  }

  async eligibleForAgent(agentId: string) {
    const prisma = await getPrismaClient();
    return prisma.commandDefinition.findMany({
      where: {
        archivedAt: null,
        OR: [
          { targetKind: "ANY_AGENT_HOME" },
          { targetKind: "SPECIFIC_AGENT_HOME", targetAgentId: agentId },
        ],
      },
      include: { targetAgent: true, targetRepository: true },
      orderBy: { name: "asc" },
    });
  }

  async eligibleForWorktree(worktreeId: string) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: worktreeId },
      select: { codebase: { select: { repositoryId: true } } },
    });
    if (!worktree) throw new Error("Worktree not found");
    return prisma.commandDefinition.findMany({
      where: {
        archivedAt: null,
        OR: [
          { targetKind: "ANY_WORKTREE" },
          {
            targetKind: "REPOSITORY_WORKTREE",
            targetRepositoryId: worktree.codebase.repositoryId,
          },
        ],
      },
      include: { targetAgent: true, targetRepository: true },
      orderBy: { name: "asc" },
    });
  }

  async listRuns(input: {
    includeArchived?: boolean | null;
    search?: string | null;
    first?: number | null;
    after?: string | null;
    agentId?: string | null;
    worktreeId?: string | null;
    statuses?: string[] | null;
  }) {
    const prisma = await getPrismaClient();
    const take = Math.max(1, Math.min(input.first ?? 50, 200));
    const search = input.search?.trim();
    const where = {
      ...(input.includeArchived ? {} : { archivedAt: null }),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      ...(input.statuses?.length ? { status: { in: input.statuses } } : {}),
      ...(search
        ? {
            OR: [
              { snapshotName: { contains: search } },
              { agentName: { contains: search } },
              { worktreePath: { contains: search } },
            ],
          }
        : {}),
    };
    const [nodes, totalCount] = await Promise.all([
      prisma.commandRun.findMany({
        where,
        include: {
          command: true,
          agent: true,
          worktree: {
            include: { codebase: { include: { repository: true } } },
          },
          attempts: { orderBy: { attempt: "asc" } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: take + 1,
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
      }),
      prisma.commandRun.count({ where }),
    ]);
    const hasNextPage = nodes.length > take;
    const page = nodes.slice(0, take);
    return {
      nodes: page,
      totalCount,
      pageInfo: {
        hasNextPage,
        endCursor: page.at(-1)?.id ?? null,
      },
    };
  }

  async getRun(id: string) {
    const prisma = await getPrismaClient();
    return prisma.commandRun.findUnique({
      where: { id },
      include: {
        command: true,
        agent: true,
        worktree: { include: { codebase: { include: { repository: true } } } },
        attempts: {
          include: { agentJob: true },
          orderBy: { attempt: "asc" },
        },
        predecessor: true,
        successor: true,
      },
    });
  }

  /**
   * Explains why a run has not started yet. The queue is derived on read
   * rather than stored: it is a view of the same rows the dispatcher consults,
   * so it cannot drift from the decision the dispatcher will actually make.
   */
  async runQueue(runId: string): Promise<CommandRunQueue> {
    const prisma = await getPrismaClient();
    const run = await prisma.commandRun.findUnique({
      where: { id: runId },
      include: {
        agent: {
          select: {
            lastSeenAt: true,
            disconnectedAt: true,
            heartbeatIntervalSeconds: true,
          },
        },
        predecessor: { select: { status: true } },
        attempts: {
          select: { agentJobId: true, completionProcessedAt: true },
          orderBy: { attempt: "desc" },
          take: 1,
        },
      },
    });
    if (!run) {
      return {
        reason: "NOT_QUEUED",
        position: 0,
        waitingCount: 0,
        entries: [],
      };
    }
    const attempt = run.attempts[0];
    const agentOnline = Boolean(
      run.agent?.lastSeenAt &&
      !run.agent.disconnectedAt &&
      Date.now() - run.agent.lastSeenAt.getTime() <=
        agentOnlineWindowMs(run.agent),
    );
    return evaluateCommandRunQueue({
      candidate: {
        id: run.id,
        displayNumber: run.displayNumber,
        name: run.snapshotName,
        status: run.status,
        concurrency: run.snapshotConcurrency,
        queuedAt: run.queuedAt,
        stopRequested: run.stopRequested,
        holdingTarget: Boolean(
          attempt?.agentJobId && !attempt.completionProcessedAt,
        ),
      },
      peers:
        run.snapshotConcurrency === "EXCLUDED"
          ? []
          : await this.targetPeers(run),
      agentOnline,
      predecessorPending: Boolean(
        run.predecessor &&
        !FINAL_RUN_STATUSES.includes(run.predecessor.status as never),
      ),
      restartPending: Boolean(
        run.status === "RESTARTING" &&
        run.nextRestartAt &&
        run.nextRestartAt.getTime() > Date.now(),
      ),
    });
  }

  async listOutput(
    runId: string,
    afterAttempt = 0,
    afterSequence = -1,
    first = 1_000,
  ) {
    const prisma = await getPrismaClient();
    if (first < 1) return [];
    return prisma.commandRunOutputChunk.findMany({
      where: {
        OR: [
          {
            attempt: { runId, attempt: { gt: afterAttempt } },
          },
          {
            attempt: { runId, attempt: afterAttempt },
            sequence: { gt: afterSequence },
          },
        ],
      },
      include: { attempt: { select: { attempt: true, runId: true } } },
      orderBy: [{ attempt: { attempt: "asc" } }, { sequence: "asc" }],
      take: Math.max(1, Math.min(first, 5_000)),
    });
  }

  private async resolveTarget(
    definition: {
      targetKind: string;
      targetAgentId: string | null;
      targetRepositoryId: string | null;
    },
    input: Pick<StartCommandRunInput, "agentId" | "worktreeId">,
  ) {
    const prisma = await getPrismaClient();
    const home =
      definition.targetKind === "ANY_AGENT_HOME" ||
      definition.targetKind === "SPECIFIC_AGENT_HOME";
    if (home) {
      if (!input.agentId || input.worktreeId) {
        throw new Error("This command requires an agent-home target");
      }
      if (
        definition.targetKind === "SPECIFIC_AGENT_HOME" &&
        definition.targetAgentId !== input.agentId
      ) {
        throw new Error("This command is not eligible for the selected agent");
      }
      const agent = await prisma.agent.findUnique({
        where: { id: input.agentId },
      });
      if (!agent) throw new Error("Agent not found");
      this.requireCapability(agent.capabilitiesJson);
      return { agent, worktree: null };
    }
    if (!input.worktreeId || input.agentId) {
      throw new Error("This command requires a worktree target");
    }
    const worktree = await prisma.worktree.findUnique({
      where: { id: input.worktreeId },
      include: {
        codebase: { include: { agent: true, repository: true } },
      },
    });
    if (!worktree || worktree.missingAt)
      throw new Error("Worktree is unavailable");
    if (
      definition.targetKind === "REPOSITORY_WORKTREE" &&
      definition.targetRepositoryId !== worktree.codebase.repositoryId
    ) {
      throw new Error(
        "This command is not eligible for the selected repository",
      );
    }
    this.requireCapability(worktree.codebase.agent.capabilitiesJson);
    return { agent: worktree.codebase.agent, worktree };
  }

  private requireCapability(capabilitiesJson: string): void {
    if (!capabilities(capabilitiesJson).includes(COMMAND_RUN_JOB_KIND)) {
      throw new Error(
        "The selected agent must be upgraded before it can run commands",
      );
    }
  }

  async startRun(input: StartCommandRunInput) {
    const prisma = await getPrismaClient();
    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();
    const existing = await prisma.commandRun.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return this.getRun(existing.id);
    const definition = await prisma.commandDefinition.findUnique({
      where: { id: input.commandId },
    });
    if (!definition || definition.archivedAt)
      throw new Error("Command not found");
    const { agent, worktree } = await this.resolveTarget(definition, input);
    let run: Awaited<ReturnType<typeof prisma.commandRun.create>>;
    try {
      run = await prisma.$transaction(async (transaction) => {
        const sequence = await transaction.commandRunNumberSequence.upsert({
          where: { id: "default" },
          create: { id: "default", nextValue: 1 },
          update: { nextValue: { increment: 1 } },
        });
        return transaction.commandRun.create({
          data: {
            id: randomUUID(),
            displayNumber: sequence.nextValue,
            commandId: definition.id,
            idempotencyKey,
            origin: (input.origin ?? "MANUAL").trim().toUpperCase(),
            snapshotName: definition.name,
            snapshotDescription: definition.description,
            snapshotScript: definition.script,
            snapshotTargetKind: definition.targetKind,
            snapshotRestartPolicy: definition.restartPolicy,
            snapshotRestartLimit: definition.restartLimit,
            snapshotConcurrency: definition.concurrency,
            snapshotBlocksGitOperations:
              definition.blocksGitOperations ||
              input.blocksGitOperations === true,
            snapshotNotificationsEnabled: definition.notificationsEnabled,
            snapshotJson: JSON.stringify(definition),
            agentId: agent.id,
            worktreeId: worktree?.id ?? null,
            agentName: agent.name,
            agentHostname: agent.hostname,
            worktreePath: worktree?.folder ?? null,
            worktreeBranch: worktree?.branch ?? null,
          },
        });
      });
    } catch (error) {
      const concurrent = await prisma.commandRun.findUnique({
        where: { idempotencyKey },
      });
      if (!concurrent) throw error;
      return this.getRun(concurrent.id);
    }
    publishRun(run);
    await this.dispatch(run.id);
    return this.getRun(run.id);
  }

  async startCustomRun(input: StartCustomCommandRunInput) {
    const prisma = await getPrismaClient();
    const idempotencyKey = input.idempotencyKey?.trim() || randomUUID();
    const existing = await prisma.commandRun.findUnique({
      where: { idempotencyKey },
    });
    if (existing) return this.getRun(existing.id);
    const script = text(input.script, "Script", 1_000_000);
    const targetKind =
      input.agentId && !input.worktreeId
        ? "ANY_AGENT_HOME"
        : input.worktreeId && !input.agentId
          ? "ANY_WORKTREE"
          : null;
    if (!targetKind) {
      throw new Error(
        "A custom command requires exactly one agent-home or worktree target",
      );
    }
    const { agent, worktree } = await this.resolveTarget(
      {
        targetKind,
        targetAgentId: null,
        targetRepositoryId: null,
      },
      input,
    );
    const snapshot = {
      name: "Custom command",
      description: "",
      script,
      targetKind,
      restartPolicy: "NEVER",
      restartLimit: null,
      // A one-off script the user just typed should start rather than sit in a
      // queue, but it still yields to a command that asked for the target
      // alone.
      concurrency: "NON_EXCLUSIVE",
      blocksGitOperations: input.blocksGitOperations === true,
      notificationsEnabled: true,
    };
    let run: Awaited<ReturnType<typeof prisma.commandRun.create>>;
    try {
      run = await prisma.$transaction(async (transaction) => {
        const sequence = await transaction.commandRunNumberSequence.upsert({
          where: { id: "default" },
          create: { id: "default", nextValue: 1 },
          update: { nextValue: { increment: 1 } },
        });
        return transaction.commandRun.create({
          data: {
            id: randomUUID(),
            displayNumber: sequence.nextValue,
            commandId: null,
            idempotencyKey,
            origin: (input.origin ?? "MANUAL").trim().toUpperCase(),
            status: "QUEUED",
            snapshotName: snapshot.name,
            snapshotDescription: snapshot.description,
            snapshotScript: snapshot.script,
            snapshotTargetKind: snapshot.targetKind,
            snapshotRestartPolicy: snapshot.restartPolicy,
            snapshotRestartLimit: snapshot.restartLimit,
            snapshotConcurrency: snapshot.concurrency,
            snapshotBlocksGitOperations: snapshot.blocksGitOperations,
            snapshotNotificationsEnabled: snapshot.notificationsEnabled,
            snapshotJson: JSON.stringify(snapshot),
            agentId: agent.id,
            worktreeId: worktree?.id ?? null,
            agentName: agent.name,
            agentHostname: agent.hostname,
            worktreePath: worktree?.folder ?? null,
            worktreeBranch: worktree?.branch ?? null,
          },
        });
      });
    } catch (error) {
      const concurrent = await prisma.commandRun.findUnique({
        where: { idempotencyKey },
      });
      if (!concurrent) throw error;
      return this.getRun(concurrent.id);
    }
    publishRun(run);
    try {
      await this.dispatch(run.id);
    } catch (error) {
      await this.failDispatch(
        run.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return this.getRun(run.id);
  }

  /**
   * Reads the other active runs sharing this run's target. `EXCLUDED` runs are
   * left out because they neither wait nor make anything wait, so they are
   * absent from admission and from the queue the run detail page renders.
   */
  private async targetPeers(run: {
    id: string;
    agentId: string | null;
    worktreeId: string | null;
  }): Promise<CommandQueueMember[]> {
    const prisma = await getPrismaClient();
    const peers = await prisma.commandRun.findMany({
      where: {
        id: { not: run.id },
        status: { in: [...ACTIVE_RUN_STATUSES] },
        snapshotConcurrency: { not: "EXCLUDED" },
        // An agent-home run shares the home directory with other home runs on
        // the same agent; a worktree run shares only that worktree.
        ...(run.worktreeId
          ? { worktreeId: run.worktreeId }
          : { agentId: run.agentId, worktreeId: null }),
      },
      select: {
        id: true,
        displayNumber: true,
        snapshotName: true,
        status: true,
        snapshotConcurrency: true,
        queuedAt: true,
        attempts: {
          select: { agentJobId: true, completionProcessedAt: true },
          orderBy: { attempt: "desc" },
          take: 1,
        },
      },
    });
    return peers.map((peer) => {
      const attempt = peer.attempts[0];
      return {
        id: peer.id,
        displayNumber: peer.displayNumber,
        name: peer.snapshotName,
        status: peer.status,
        concurrency: peer.snapshotConcurrency,
        queuedAt: peer.queuedAt,
        holdingTarget: Boolean(
          attempt?.agentJobId && !attempt.completionProcessedAt,
        ),
      };
    });
  }

  /**
   * Reads the other runs sharing this run's target and asks
   * {@link admitCommandRun} whether the target is free. A run that is turned
   * away keeps its current status — `QUEUED` or `RESTARTING` — and the
   * reconcile loop offers it the target again on the next tick.
   */
  private async admitRun(run: {
    id: string;
    snapshotConcurrency: string;
    queuedAt: Date;
    agentId: string | null;
    worktreeId: string | null;
  }): Promise<boolean> {
    if (run.snapshotConcurrency === "EXCLUDED") return true;
    const peers = await this.targetPeers(run);
    const holders = peers.filter((peer) => peer.holdingTarget);
    const waiting = peers.filter((peer) => !peer.holdingTarget);
    return admitCommandRun({
      candidate: {
        id: run.id,
        concurrency: run.snapshotConcurrency,
        queuedAt: run.queuedAt,
      },
      holders,
      waiting,
    });
  }

  /**
   * Admission reads the runs sharing a target and then claims it by creating a
   * job. Two dispatches interleaving between those steps would both see a free
   * target and both start, so dispatches are serialized against each other.
   */
  private dispatch(runId: string): Promise<void> {
    const next = this.dispatchChain.then(
      () => this.dispatchRun(runId),
      () => this.dispatchRun(runId),
    );
    this.dispatchChain = next.catch(() => undefined);
    return next;
  }

  private async dispatchRun(runId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const run = await prisma.commandRun.findUnique({
      where: { id: runId },
      include: {
        agent: true,
        worktree: { include: { codebase: true } },
        attempts: true,
      },
    });
    if (!run || run.stopRequested) return;
    if (!run.agentId || !run.agent) {
      await this.failDispatch(
        run.id,
        "The command agent is no longer available",
      );
      return;
    }
    if (run.predecessorRunId) {
      const predecessor = await prisma.commandRun.findUnique({
        where: { id: run.predecessorRunId },
        select: { status: true },
      });
      if (
        predecessor &&
        !FINAL_RUN_STATUSES.includes(predecessor.status as never)
      )
        return;
    }
    const worktreeTarget = new Set(["ANY_WORKTREE", "REPOSITORY_WORKTREE"]).has(
      run.snapshotTargetKind,
    );
    if (
      worktreeTarget &&
      (!run.worktreeId || !run.worktree || run.worktree.missingAt)
    ) {
      await this.failDispatch(
        run.id,
        "The command worktree is no longer available",
      );
      return;
    }
    if (run.worktree && run.worktree.codebase.agentId !== run.agentId) {
      await this.failDispatch(
        run.id,
        "The worktree is no longer assigned to the command agent",
      );
      return;
    }
    try {
      this.requireCapability(run.agent.capabilitiesJson);
    } catch (error) {
      await this.failDispatch(
        run.id,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const latestAttempt = run.attempts.reduce<
      (typeof run.attempts)[number] | null
    >(
      (latest, candidate) =>
        !latest || candidate.attempt > latest.attempt ? candidate : latest,
      null,
    );
    // A run already owns its target once an attempt has a job that has not
    // reported back, so only work that is about to claim the target is
    // admitted. Checking before the attempt row is written matters for a
    // restart: its previous attempt is complete, so a blocked restart would
    // otherwise mint a fresh attempt on every reconcile tick.
    const holding = Boolean(
      latestAttempt?.agentJobId && !latestAttempt.completionProcessedAt,
    );
    if (!holding && !(await this.admitRun(run))) return;
    const reuseLatestAttempt =
      latestAttempt &&
      !latestAttempt.agentJobId &&
      !latestAttempt.completionProcessedAt &&
      !latestAttempt.finishedAt;
    const attemptNumber = reuseLatestAttempt
      ? latestAttempt.attempt
      : (latestAttempt?.attempt ?? 0) + 1;
    let attempt =
      latestAttempt?.attempt === attemptNumber
        ? latestAttempt
        : await prisma.commandRunAttempt.findUnique({
            where: { runId_attempt: { runId, attempt: attemptNumber } },
          });
    if (!attempt) {
      try {
        attempt = await prisma.commandRunAttempt.create({
          data: { id: randomUUID(), runId, attempt: attemptNumber },
        });
      } catch (error) {
        attempt = await prisma.commandRunAttempt.findUnique({
          where: { runId_attempt: { runId, attempt: attemptNumber } },
        });
        if (!attempt) throw error;
      }
    }
    if (!attempt.agentJobId) {
      let job;
      try {
        job = await this.agentControl.createJob({
          agentId: run.agentId,
          kind: COMMAND_RUN_JOB_KIND,
          payload: {
            commandRunId: run.id,
            attemptId: attempt.id,
            targetKind: run.worktreeId ? "WORKTREE" : "AGENT_HOME",
            cwd: run.worktree?.folder ?? null,
            script: run.snapshotScript,
          },
          idempotencyKey: `command-run:${run.id}:attempt:${attemptNumber}`,
          timeoutSeconds: 0,
          worktreeId: run.worktreeId,
          codebaseId: run.worktree?.codebaseId ?? null,
          visibility: "SYSTEM",
          blocksGitOperations: run.snapshotBlocksGitOperations,
        });
      } catch (error) {
        // The codebase can still be held by git or worktree work that the
        // command modes know nothing about. Waiting for it is the same answer
        // concurrency gives, so the run stays queued for the next tick rather
        // than failing on a busy repository.
        if (!isCodebaseBusyError(error)) throw error;
        return;
      }
      attempt = await prisma.commandRunAttempt.update({
        where: { id: attempt.id },
        data: { agentJobId: job.id, status: job.status },
      });
    }
    const updated = await prisma.commandRun.update({
      where: { id: run.id },
      data: {
        status: attempt.status === "RUNNING" ? "RUNNING" : "QUEUED",
        startedAt:
          attempt.status === "RUNNING" ? (run.startedAt ?? new Date()) : null,
        nextRestartAt: null,
        error: null,
      },
    });
    publishRun(updated);
  }

  private async failDispatch(runId: string, error: string): Promise<void> {
    const prisma = await getPrismaClient();
    const updated = await prisma.commandRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        error,
        finishedAt: new Date(),
        nextRestartAt: null,
      },
      include: { worktree: { select: { highlightColor: true } } },
    });
    publishRun(updated);
    await this.notifyFinishedRun(updated);
  }

  async terminateRun(id: string) {
    const prisma = await getPrismaClient();
    const run = await prisma.commandRun.findUnique({
      where: { id },
      include: { attempts: { orderBy: { attempt: "desc" }, take: 1 } },
    });
    if (!run) throw new Error("Command run not found");
    if (FINAL_RUN_STATUSES.includes(run.status as never)) return run;
    const updated = await prisma.commandRun.update({
      where: { id },
      data: { stopRequested: true, status: "CANCELLING", nextRestartAt: null },
    });
    // Between attempts — a run waiting to restart, or one still queued for its
    // target — the newest attempt is already finished or has no job at all, so
    // asking the agent to cancel it does nothing and the run has to be closed
    // out here.
    const jobId = run.attempts[0]?.agentJobId;
    const job = jobId ? await this.agentControl.cancelJob(jobId) : null;
    if (!cancellableJob(job)) await this.finishCancelled(id);
    publishRun(updated);
    return this.getRun(id);
  }

  async rerun(id: string) {
    const prisma = await getPrismaClient();
    const original = await prisma.commandRun.findUnique({ where: { id } });
    if (!original) throw new Error("Command run not found");
    const existingSuccessor = await prisma.commandRun.findUnique({
      where: { predecessorRunId: original.id },
    });
    if (existingSuccessor) return this.getRun(existingSuccessor.id);
    const successor = await prisma.$transaction(async (transaction) => {
      const sequence = await transaction.commandRunNumberSequence.upsert({
        where: { id: "default" },
        create: { id: "default", nextValue: 1 },
        update: { nextValue: { increment: 1 } },
      });
      return transaction.commandRun.create({
        data: {
          id: randomUUID(),
          displayNumber: sequence.nextValue,
          commandId: original.commandId,
          idempotencyKey: `rerun:${original.id}:${randomUUID()}`,
          origin: "RERUN",
          snapshotName: original.snapshotName,
          snapshotDescription: original.snapshotDescription,
          snapshotScript: original.snapshotScript,
          snapshotTargetKind: original.snapshotTargetKind,
          snapshotRestartPolicy: original.snapshotRestartPolicy,
          snapshotRestartLimit: original.snapshotRestartLimit,
          snapshotConcurrency: original.snapshotConcurrency,
          snapshotBlocksGitOperations: original.snapshotBlocksGitOperations,
          snapshotNotificationsEnabled: original.snapshotNotificationsEnabled,
          snapshotJson: original.snapshotJson,
          agentId: original.agentId,
          worktreeId: original.worktreeId,
          agentName: original.agentName,
          agentHostname: original.agentHostname,
          worktreePath: original.worktreePath,
          worktreeBranch: original.worktreeBranch,
          predecessorRunId: original.id,
        },
      });
    });
    publishRun(successor);
    if (FINAL_RUN_STATUSES.includes(original.status as never)) {
      await this.dispatch(successor.id);
    } else {
      await this.terminateRun(original.id);
    }
    return this.getRun(successor.id);
  }

  async archiveRuns(ids: string[], archived: boolean) {
    const prisma = await getPrismaClient();
    await prisma.commandRun.updateMany({
      where: { id: { in: ids }, status: { in: [...FINAL_RUN_STATUSES] } },
      data: { archivedAt: archived ? new Date() : null },
    });
    for (const id of ids) {
      const run = await prisma.commandRun.findUnique({ where: { id } });
      if (run) publishRun(run);
    }
    return true;
  }

  async deleteRuns(ids: string[]) {
    const prisma = await getPrismaClient();
    const deleted = await prisma.commandRun.deleteMany({
      where: { id: { in: ids }, status: { in: [...FINAL_RUN_STATUSES] } },
    });
    return deleted.count;
  }

  async appendOutput(
    agentId: string,
    jobId: string,
    attemptId: string,
    chunks: Array<{
      sequence: number;
      stream: string;
      dataBase64: string;
      byteLength: number;
      createdAt: string;
    }>,
  ) {
    if (!chunks.length || chunks.length > MAX_COMMAND_OUTPUT_BATCH_CHUNKS) {
      throw new Error(
        `Output batches must contain 1 to ${MAX_COMMAND_OUTPUT_BATCH_CHUNKS} chunks`,
      );
    }
    const prisma = await getPrismaClient();
    const attempt = await prisma.commandRunAttempt.findUnique({
      where: { id: attemptId },
      include: { run: true },
    });
    if (
      !attempt ||
      attempt.agentJobId !== jobId ||
      attempt.run.agentId !== agentId
    ) {
      throw new Error("Command attempt not found for this agent job");
    }
    const normalized = chunks.map((chunk) => {
      if (!Number.isInteger(chunk.sequence) || chunk.sequence < 0) {
        throw new Error("Output sequence must be a non-negative integer");
      }
      if (!["STDOUT", "STDERR", "SYSTEM"].includes(chunk.stream)) {
        throw new Error("Output stream is invalid");
      }
      const bytes = Buffer.from(chunk.dataBase64, "base64");
      if (bytes.length !== chunk.byteLength || bytes.length > 256 * 1024) {
        throw new Error("Output byte length is invalid");
      }
      const createdAt = new Date(chunk.createdAt);
      if (Number.isNaN(createdAt.valueOf()))
        throw new Error("Output date is invalid");
      return { ...chunk, createdAt };
    });
    await Promise.all(
      normalized.map((chunk) =>
        prisma.commandRunOutputChunk.upsert({
          where: {
            attemptId_sequence: { attemptId, sequence: chunk.sequence },
          },
          create: { id: randomUUID(), attemptId, ...chunk },
          update: {},
        }),
      ),
    );
    const persisted = await prisma.commandRunOutputChunk.findMany({
      where: {
        attemptId,
        sequence: { in: normalized.map((item) => item.sequence) },
      },
      orderBy: { sequence: "asc" },
    });
    for (const chunk of persisted) {
      const output = {
        ...chunk,
        runId: attempt.runId,
        attemptNumber: attempt.attempt,
      };
      agentEventBus.publish(commandRunOutputTopic(attempt.runId), {
        commandRunOutputAdded: output,
      });
      agentEventBus.publish(COMMAND_RUN_OUTPUT_CHANGED_TOPIC, {
        commandRunOutputAdded: output,
      });
    }
    return persisted;
  }

  private async finishCancelled(runId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const updated = await prisma.commandRun.update({
      where: { id: runId },
      data: {
        status: "CANCELLED",
        finishedAt: new Date(),
        nextRestartAt: null,
      },
    });
    publishRun(updated);
    const successor = await prisma.commandRun.findUnique({
      where: { predecessorRunId: runId },
    });
    if (successor) await this.dispatch(successor.id);
  }

  private async notifyFinishedRun(run: {
    id: string;
    status: string;
    snapshotName: string;
    snapshotNotificationsEnabled: boolean;
    agentName: string;
    agentHostname: string;
    worktreeId: string | null;
    worktreePath: string | null;
    worktreeBranch: string | null;
    worktree: { highlightColor: string | null } | null;
    error: string | null;
  }): Promise<void> {
    if (
      !this.notifications ||
      !run.snapshotNotificationsEnabled ||
      (run.status !== "SUCCEEDED" && run.status !== "FAILED")
    ) {
      return;
    }
    const target =
      run.worktreeBranch ??
      run.worktreePath ??
      `${run.agentName} · ${run.agentHostname}`;
    const body = [target, run.status === "FAILED" ? run.error : null]
      .filter((value): value is string => Boolean(value))
      .join(" · ")
      .slice(0, 1_000);
    try {
      const prisma = await getPrismaClient();
      const notification = await prisma.$transaction((transaction) =>
        this.notifications!.recordInTransaction(transaction, {
          dedupeKey: `command-run:${run.id}:${run.status}`,
          typeKey:
            run.status === "SUCCEEDED"
              ? "COMMAND_RUN_SUCCEEDED"
              : "COMMAND_RUN_FAILED",
          title: `${run.snapshotName} ${run.status.toLowerCase()}`,
          body,
          href: `/commands/runs/${run.id}`,
          resourceKind: "COMMAND_RUN",
          resourceId: run.id,
          worktreeId: run.worktreeId,
          highlightColor: run.worktree?.highlightColor ?? null,
        }),
      );
      this.notifications.created(notification);
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        console.error("Command run notification failed:", error);
      }
    }
  }

  private async handleAttemptCompletion(job: {
    id: string;
    status: string;
    resultJson: string | null;
    error: string | null;
  }): Promise<void> {
    const prisma = await getPrismaClient();
    const attempt = await prisma.commandRunAttempt.findUnique({
      where: { agentJobId: job.id },
      include: { run: true, agentJob: true },
    });
    if (!attempt || attempt.completionProcessedAt) return;
    const now = new Date();
    const result = parseResult(job.resultJson);
    const completed = await prisma.commandRunAttempt.updateMany({
      where: { id: attempt.id, completionProcessedAt: null },
      data: {
        status: job.status,
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        error: job.error,
        startedAt: attempt.agentJob?.startedAt ?? attempt.startedAt,
        finishedAt: attempt.agentJob?.finishedAt ?? now,
        completionProcessedAt: now,
      },
    });
    if (completed.count !== 1) return;
    if (attempt.run.stopRequested || job.status === "CANCELLED") {
      await this.finishCancelled(attempt.runId);
      return;
    }
    const clean = job.status === "SUCCEEDED" && result.exitCode === 0;
    const policy = enumValue(
      RESTART_POLICIES,
      attempt.run.snapshotRestartPolicy,
      "Restart policy",
    );
    const startedAt = attempt.agentJob?.startedAt ?? attempt.createdAt;
    const restart = evaluateCommandRestart({
      policy,
      limit: attempt.run.snapshotRestartLimit,
      restartCount: attempt.run.restartCount,
      durationMs: now.getTime() - startedAt.getTime(),
      clean,
      manualStop: attempt.run.stopRequested,
    });
    if (restart.restart) {
      const updated = await prisma.commandRun.update({
        where: { id: attempt.runId },
        data: {
          status: "RESTARTING",
          restartCount: restart.restartCount,
          nextRestartAt: new Date(now.getTime() + RESTART_DELAY_MS),
          exitCode: result.exitCode ?? null,
          signal: result.signal ?? null,
          error: job.error,
        },
      });
      publishRun(updated);
      return;
    }
    const updated = await prisma.commandRun.update({
      where: { id: attempt.runId },
      data: {
        status: clean ? "SUCCEEDED" : "FAILED",
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        error:
          job.error ??
          (restart.exhausted
            ? "Restart limit reached"
            : clean
              ? null
              : "Command failed"),
        finishedAt: now,
        nextRestartAt: null,
      },
      include: { worktree: { select: { highlightColor: true } } },
    });
    publishRun(updated);
    await this.notifyFinishedRun(updated);
  }

  async reconcile(input: { agentId?: string } = {}): Promise<void> {
    const prisma = await getPrismaClient();
    const now = new Date();
    const runs = await prisma.commandRun.findMany({
      where: {
        status: { in: [...ACTIVE_RUN_STATUSES] },
        ...(input.agentId ? { agentId: input.agentId } : {}),
      },
      include: {
        attempts: {
          include: { agentJob: true },
          orderBy: { attempt: "desc" },
          take: 1,
        },
      },
    });
    for (const run of runs) {
      const attempt = run.attempts[0];
      if (run.stopRequested) {
        const job = attempt?.agentJob ?? null;
        if (job && cancellableJob(job)) {
          await this.agentControl.cancelJob(job.id);
        } else {
          await this.finishCancelled(run.id);
        }
        continue;
      }
      if (
        run.status === "RESTARTING" &&
        (!run.nextRestartAt || run.nextRestartAt <= now)
      ) {
        await this.dispatch(run.id);
        continue;
      }
      if (
        attempt?.agentJob &&
        ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
          attempt.agentJob.status,
        )
      ) {
        await this.handleAttemptCompletion(attempt.agentJob);
        continue;
      }
      if (
        attempt?.agentJob &&
        ["QUEUED", "RUNNING"].includes(attempt.agentJob.status)
      ) {
        const status =
          attempt.agentJob.status === "RUNNING" ? "RUNNING" : "QUEUED";
        if (attempt.status !== attempt.agentJob.status) {
          await prisma.commandRunAttempt.update({
            where: { id: attempt.id },
            data: {
              status: attempt.agentJob.status,
              startedAt: attempt.agentJob.startedAt,
            },
          });
        }
        if (run.status !== status) {
          const updated = await prisma.commandRun.update({
            where: { id: run.id },
            data: {
              status,
              startedAt:
                status === "RUNNING"
                  ? (run.startedAt ?? attempt.agentJob.startedAt ?? now)
                  : run.startedAt,
            },
          });
          publishRun(updated);
        }
        continue;
      }
      if (
        run.status === "QUEUED" &&
        (!attempt ||
          (!attempt.agentJobId &&
            !attempt.completionProcessedAt &&
            !attempt.finishedAt))
      ) {
        await this.dispatch(run.id);
      }
    }
  }
}
