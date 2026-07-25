import "server-only";

import { randomUUID } from "node:crypto";

import { COMMAND_RUN_JOB_KIND } from "@ai-development-environment/agent-contract/commands";

import { getPrismaClient } from "@/data/prisma-client";
import {
  COMMANDS_CHANGED_TOPIC,
  agentEventBus,
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
const ACTIVE_RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "RESTARTING",
  "CANCELLING",
] as const;
const FINAL_RUN_STATUSES = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;
const RESTART_DELAY_MS = 1_000;
const STABLE_ATTEMPT_MS = 60_000;

export type CommandDefinitionInput = {
  name: string;
  description?: string | null;
  script: string;
  targetKind: string;
  targetAgentId?: string | null;
  targetRepositoryId?: string | null;
  restartPolicy?: string | null;
  restartLimit?: number | null;
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
  agentEventBus.publish(commandRunChangedTopic(run.id), {
    commandRunChanged: run,
  });
}

export class CommandsService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciliation: Promise<void> | null = null;

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
    return {
      name: text(input.name, "Name", 120),
      description: (input.description ?? "").trim().slice(0, 2_000),
      script: text(input.script, "Script", 1_000_000),
      targetKind,
      targetAgentId: input.targetAgentId ?? null,
      targetRepositoryId: input.targetRepositoryId ?? null,
      restartPolicy,
      restartLimit,
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
  }) {
    const prisma = await getPrismaClient();
    const take = Math.max(1, Math.min(input.first ?? 50, 200));
    const search = input.search?.trim();
    const where = {
      ...(input.includeArchived ? {} : { archivedAt: null }),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
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
    input: StartCommandRunInput,
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
        "The selected agent must be upgraded before it can run saved commands",
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

  private async dispatch(runId: string): Promise<void> {
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
    if (worktreeTarget && (!run.worktreeId || !run.worktree)) {
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
    const attemptNumber = run.attempts.length + 1;
    let attempt = await prisma.commandRunAttempt.findUnique({
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
      const job = await this.agentControl.createJob({
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
      });
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
    const jobId = run.attempts[0]?.agentJobId;
    if (jobId) await this.agentControl.cancelJob(jobId);
    else await this.finishCancelled(id);
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
    if (!chunks.length || chunks.length > 200) {
      throw new Error("Output batches must contain 1 to 200 chunks");
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
      agentEventBus.publish(commandRunOutputTopic(attempt.runId), {
        commandRunOutputAdded: { ...chunk, attemptNumber: attempt.attempt },
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
        if (
          attempt?.agentJobId &&
          attempt.agentJob &&
          !["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(
            attempt.agentJob.status,
          )
        ) {
          await this.agentControl.cancelJob(attempt.agentJobId);
        } else if (!attempt || attempt.agentJob?.status === "CANCELLED") {
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
      if (!attempt && run.status === "QUEUED") await this.dispatch(run.id);
    }
  }
}
