import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import {
  RUNS_CHANGED_TOPIC,
  agentOnlineWindowMs,
  agentEventBus,
  agentEventsTopic,
  runChangedTopic,
  runEventTopic,
  runQuestionTopic,
} from "@/services/agent-control";
import type { NotificationsService } from "@/services/notifications";

import {
  MAX_RUN_INPUT_ATTACHMENT_BYTES,
  cloneRunAttachments,
  removeRunAttachmentFiles,
} from "./attachment-store";

const RUN_KINDS = ["PLAN", "SESSION"] as const;
const PROVIDERS = ["CODEX", "CLAUDE", "OPENCODE"] as const;
const TERMINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "FAILED"]);
const MAX_LIST_SIZE = 200;

type RunKind = (typeof RUN_KINDS)[number];
type Provider = (typeof PROVIDERS)[number];

export type RunConfigurationInput = {
  kind: string;
  worktreeId: string;
  jiraIssueKey?: string | null;
  jiraSummary?: string | null;
  provider: string;
  model: string;
  effort?: string | null;
  webSearchEnabled?: boolean | null;
  prompt: string;
  attachmentIds?: string[] | null;
  draftId?: string | null;
  sourcePlanId?: string | null;
  parentRunId?: string | null;
  followUpMode?: string | null;
  contextMode?: string | null;
};

export type SaveRunDraftInput = Omit<
  RunConfigurationInput,
  "draftId" | "sourcePlanId" | "parentRunId" | "followUpMode" | "contextMode"
> & { id?: string | null };

export type RunEventInput = {
  id: string;
  sequence: number;
  type: string;
  summary: string;
  searchText?: string | null;
  detailMarkdown?: string | null;
  raw?: unknown;
  createdAt?: string | null;
};

export type RunQuestionInput = {
  id?: string | null;
  header?: string | null;
  prompt: string;
  multiSelect?: boolean | null;
  allowCustom?: boolean | null;
  options?: Array<{ label: string; description?: string | null }> | null;
};

export type ImportedRunInput = {
  nativeId: string;
  worktreeId: string;
  kind?: string | null;
  status?: string | null;
  archived?: boolean | null;
  model?: string | null;
  effort?: string | null;
  prompt?: string | null;
  finalOutput?: string | null;
  branch?: string | null;
  jiraIssueKey?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  rawMetadata?: unknown;
};

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

function requiredText(value: string, label: string, maximum: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  if (result.length > maximum) throw new Error(`${label} is too long`);
  return result;
}

function optionalText(
  value: string | null | undefined,
  maximum: number,
): string | null {
  const result = value?.trim() || null;
  if (result && result.length > maximum) throw new Error("Value is too long");
  return result;
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function runHref(run: { id: string; kind: string }): string {
  return `/${run.kind === "PLAN" ? "plans" : "sessions"}/${encodeURIComponent(run.id)}`;
}

function publishRun(runId: string): void {
  const payload = { runChanged: { id: runId } };
  agentEventBus.publish(runChangedTopic(runId), payload);
  agentEventBus.publish(RUNS_CHANGED_TOPIC, payload);
}

function publishCommand(command: unknown, agentId: string): void {
  agentEventBus.publish(agentEventsTopic(agentId), {
    agentEvents: {
      type: "RUN_COMMAND_AVAILABLE",
      job: null,
      runCommand: command,
    },
  });
}

export async function nextDisplayNumber(
  transaction: Prisma.TransactionClient,
  kind: RunKind,
): Promise<number> {
  const sequence = await transaction.runNumberSequence.upsert({
    where: { kind },
    create: { kind, nextValue: 1 },
    update: { nextValue: { increment: 1 } },
  });
  return sequence.nextValue - 1;
}

async function nextCommandSequence(
  transaction: Prisma.TransactionClient,
  runId: string,
): Promise<number> {
  const last = await transaction.runCommand.findFirst({
    where: { runId },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return (last?.sequence ?? -1) + 1;
}

const runCommandInclude = {
  run: {
    include: {
      worktree: true,
      inputs: { include: { attachments: true } },
      attempts: true,
      sourcePlan: { include: { attempts: true } },
      parentRun: { include: { attempts: true } },
    },
  },
} as const;

async function enqueueCommand(
  transaction: Prisma.TransactionClient,
  input: {
    runId: string;
    agentId: string;
    type: string;
    payload?: unknown;
    idempotencyKey?: string;
  },
) {
  const sequence = await nextCommandSequence(transaction, input.runId);
  return transaction.runCommand.create({
    data: {
      id: randomUUID(),
      runId: input.runId,
      agentId: input.agentId,
      sequence,
      type: input.type,
      payloadJson: JSON.stringify(input.payload ?? {}),
      idempotencyKey:
        input.idempotencyKey ?? `${input.runId}:${sequence}:${input.type}`,
    },
    include: runCommandInclude,
  });
}

const runInclude = {
  worktree: {
    include: {
      codebase: { include: { repository: true, agent: true } },
    },
  },
  attempts: { orderBy: { generation: "asc" as const } },
  inputs: {
    orderBy: { sequence: "asc" as const },
    include: { attachments: true },
  },
  modelUsage: { orderBy: { model: "asc" as const } },
  toolCalls: { orderBy: { sequence: "asc" as const } },
  questionBatches: {
    orderBy: { createdAt: "asc" as const },
    include: {
      questions: {
        orderBy: { position: "asc" as const },
        include: { options: { orderBy: { position: "asc" as const } } },
      },
      answerRevisions: { orderBy: { revision: "asc" as const } },
      checkpoint: true,
    },
  },
  sourcePlan: true,
  playedSession: true,
  parentRun: true,
  followUps: { orderBy: { createdAt: "asc" as const } },
  checkpoints: { orderBy: { createdAt: "asc" as const } },
} as const;

export class RunsService {
  constructor(private readonly notifications?: NotificationsService) {}

  async list(input: {
    kind: string;
    search?: string | null;
    archive?: string | null;
    provider?: string | null;
    origin?: string | null;
    first?: number | null;
    after?: string | null;
  }) {
    const kind = enumValue(RUN_KINDS, input.kind, "Run kind");
    const first = Math.max(1, Math.min(input.first ?? 100, MAX_LIST_SIZE));
    const search = input.search?.trim();
    const archive = input.archive?.toUpperCase() ?? "ACTIVE";
    const where: Prisma.AgentRunWhereInput = {
      kind,
      ...(archive === "ARCHIVED"
        ? { archivedAt: { not: null } }
        : archive === "ALL"
          ? {}
          : { archivedAt: null }),
      ...(input.provider
        ? { provider: input.provider.trim().toUpperCase() }
        : {}),
      ...(input.origin ? { origin: input.origin.trim().toUpperCase() } : {}),
      ...(search
        ? {
            OR: [
              { initialPrompt: { contains: search } },
              { repositoryName: { contains: search } },
              { branch: { contains: search } },
              { jiraIssueKey: { contains: search } },
              { model: { contains: search } },
            ],
          }
        : {}),
    };
    const prisma = await getPrismaClient();
    const [rows, totalCount] = await Promise.all([
      prisma.agentRun.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: first + 1,
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
        include: {
          worktree: true,
          sourcePlan: true,
          playedSession: true,
        },
      }),
      prisma.agentRun.count({ where }),
    ]);
    return {
      items: rows.slice(0, first),
      nextCursor: rows.length > first ? rows[first - 1]!.id : null,
      totalCount,
    };
  }

  async get(id: string) {
    const prisma = await getPrismaClient();
    return prisma.agentRun.findUnique({ where: { id }, include: runInclude });
  }

  async events(input: {
    runId: string;
    search?: string | null;
    afterSequence?: number | null;
    first?: number | null;
    includeSuperseded?: boolean | null;
  }) {
    const prisma = await getPrismaClient();
    const first = Math.max(1, Math.min(input.first ?? 200, 500));
    return prisma.runEvent.findMany({
      where: {
        runId: input.runId,
        sequence: { gt: input.afterSequence ?? -1 },
        ...(input.includeSuperseded ? {} : { supersededAt: null }),
        ...(input.search?.trim()
          ? { searchText: { contains: input.search.trim() } }
          : {}),
      },
      orderBy: { sequence: "asc" },
      take: first,
    });
  }

  async questions(input: {
    runId: string;
    first?: number | null;
    after?: string | null;
  }) {
    const prisma = await getPrismaClient();
    const first = Math.max(1, Math.min(input.first ?? 100, MAX_LIST_SIZE));
    const where = { runId: input.runId };
    const [rows, totalCount] = await Promise.all([
      prisma.runQuestionBatch.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: first + 1,
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
        include: {
          questions: {
            orderBy: { position: "asc" },
            include: { options: { orderBy: { position: "asc" } } },
          },
          answerRevisions: { orderBy: { revision: "asc" } },
          checkpoint: true,
        },
      }),
      prisma.runQuestionBatch.count({ where }),
    ]);
    return {
      items: rows.slice(0, first),
      nextCursor: rows.length > first ? rows[first - 1]!.id : null,
      totalCount,
    };
  }

  async usage(runId: string) {
    const prisma = await getPrismaClient();
    return prisma.agentRun.findUnique({
      where: { id: runId },
      select: {
        inputTokens: true,
        outputTokens: true,
        reasoningTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
        toolCallCount: true,
        estimatedCost: true,
        modelUsage: { orderBy: { model: "asc" } },
        toolCalls: { orderBy: { sequence: "asc" } },
      },
    });
  }

  async linkedItems(runId: string) {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { sourcePlanId: true, parentRunId: true },
    });
    if (!run) return [];
    return prisma.agentRun.findMany({
      where: {
        OR: [
          {
            id: {
              in: [run.sourcePlanId, run.parentRunId].filter(
                (id): id is string => Boolean(id),
              ),
            },
          },
          { sourcePlanId: runId },
          { parentRunId: runId },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async drafts(
    input: {
      search?: string | null;
      archive?: string | null;
      first?: number | null;
      after?: string | null;
    } = {},
  ) {
    const prisma = await getPrismaClient();
    const first = Math.max(1, Math.min(input.first ?? 100, MAX_LIST_SIZE));
    const archive = input.archive?.toUpperCase() ?? "ACTIVE";
    const search = input.search?.trim();
    const where: Prisma.RunDraftWhereInput = {
      ...(archive === "ARCHIVED"
        ? { archivedAt: { not: null } }
        : archive === "ALL"
          ? {}
          : { archivedAt: null }),
      ...(search
        ? {
            OR: [
              { prompt: { contains: search } },
              { jiraIssueKey: { contains: search } },
              { provider: { contains: search } },
              { model: { contains: search } },
            ],
          }
        : {}),
    };
    const [rows, totalCount] = await Promise.all([
      prisma.runDraft.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: first + 1,
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
        include: { worktree: true, attachments: true },
      }),
      prisma.runDraft.count({ where }),
    ]);
    return {
      items: rows.slice(0, first),
      nextCursor: rows.length > first ? rows[first - 1]!.id : null,
      totalCount,
    };
  }

  async draft(id: string) {
    const prisma = await getPrismaClient();
    return prisma.runDraft.findUnique({
      where: { id },
      include: { worktree: true, attachments: true },
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
      },
    });
  }

  async saveDraft(input: SaveRunDraftInput) {
    const kind = enumValue(RUN_KINDS, input.kind, "Run kind");
    const provider = enumValue(PROVIDERS, input.provider, "Provider");
    const prompt = requiredText(input.prompt, "Prompt", 200_000);
    const worktree = await this.requireWorktree(input.worktreeId);
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.requireAttachments(attachmentIds, input.id ?? undefined);
    const prisma = await getPrismaClient();
    const id = input.id ?? randomUUID();
    const saved = await prisma.$transaction(async (transaction) => {
      const draft = await transaction.runDraft.upsert({
        where: { id },
        create: {
          id,
          kind,
          worktreeId: worktree.id,
          agentId: worktree.codebase.agentId,
          jiraIssueKey: optionalText(input.jiraIssueKey, 100),
          jiraSummary: optionalText(input.jiraSummary, 500),
          provider,
          model: requiredText(input.model, "Model", 200),
          effort: optionalText(input.effort, 100),
          webSearchEnabled: Boolean(input.webSearchEnabled),
          prompt,
        },
        update: {
          kind,
          worktreeId: worktree.id,
          agentId: worktree.codebase.agentId,
          jiraIssueKey: optionalText(input.jiraIssueKey, 100),
          jiraSummary: optionalText(input.jiraSummary, 500),
          provider,
          model: requiredText(input.model, "Model", 200),
          effort: optionalText(input.effort, 100),
          webSearchEnabled: Boolean(input.webSearchEnabled),
          prompt,
        },
      });
      if (attachmentIds.length) {
        await transaction.runAttachment.updateMany({
          where: { id: { in: attachmentIds }, inputId: null },
          data: { draftId: id },
        });
      }
      await transaction.runAttachment.updateMany({
        where: {
          draftId: id,
          ...(attachmentIds.length ? { id: { notIn: attachmentIds } } : {}),
        },
        data: { draftId: null },
      });
      return draft;
    });
    agentEventBus.publish(RUNS_CHANGED_TOPIC, {
      runChanged: { id: saved.id },
    });
    return this.draft(saved.id);
  }

  async create(input: RunConfigurationInput) {
    return this.createInternal(input);
  }

  private async createInternal(
    input: RunConfigurationInput,
    options: { transferLeaseFromRunId?: string } = {},
  ) {
    const kind = enumValue(RUN_KINDS, input.kind, "Run kind");
    const provider = enumValue(PROVIDERS, input.provider, "Provider");
    const prompt = requiredText(input.prompt, "Prompt", 200_000);
    const model = requiredText(input.model, "Model", 200);
    const worktree = await this.requireWorktree(input.worktreeId, provider);
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    await this.requireAttachments(attachmentIds, input.draftId ?? undefined);

    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const displayNumber = await nextDisplayNumber(transaction, kind);
      const id = randomUUID();
      const firstInputId = randomUUID();
      const sourcePlan = input.sourcePlanId
        ? await transaction.agentRun.findUnique({
            where: { id: input.sourcePlanId },
          })
        : null;
      if (input.sourcePlanId) {
        if (!sourcePlan || sourcePlan.kind !== "PLAN") {
          throw new Error("Source plan was not found");
        }
        if (sourcePlan.status !== "COMPLETED" || !sourcePlan.finalOutput) {
          throw new Error("Only a completed plan with output can be run");
        }
        if (sourcePlan.playedAt)
          throw new Error("This plan has already been run");
      }
      const parent = input.parentRunId
        ? await transaction.agentRun.findUnique({
            where: { id: input.parentRunId },
          })
        : null;

      if (kind === "SESSION") {
        if (options.transferLeaseFromRunId) {
          await transaction.worktreeRunLease.deleteMany({
            where: {
              worktreeId: worktree.id,
              runId: options.transferLeaseFromRunId,
            },
          });
          await transaction.agentRun.update({
            where: { id: options.transferLeaseFromRunId },
            data: {
              status: "CANCELLED",
              phase: "SUPERSEDED_BY_FOLLOW_UP",
              finishedAt: new Date(),
            },
          });
        }
        const lease = await transaction.worktreeRunLease.findUnique({
          where: { worktreeId: worktree.id },
          include: { run: true },
        });
        if (lease) {
          throw new Error(
            `Session #${lease.run.displayNumber} already owns this worktree`,
          );
        }
      }

      const run = await transaction.agentRun.create({
        data: {
          id,
          kind,
          displayNumber,
          provider,
          worktreeId: worktree.id,
          agentId: worktree.codebase.agentId,
          jiraIssueKey: optionalText(input.jiraIssueKey, 100),
          jiraSummary: optionalText(input.jiraSummary, 500),
          repositoryName: worktree.codebase.repository.name,
          branch: worktree.branch,
          model,
          effort: optionalText(input.effort, 100),
          webSearchEnabled: Boolean(input.webSearchEnabled),
          initialPrompt: prompt,
          sourcePlanId: sourcePlan?.id,
          sourcePlanNumber: sourcePlan?.displayNumber,
          parentRunId: parent?.id,
          parentRunNumber: parent?.displayNumber,
          followUpMode: optionalText(input.followUpMode, 50),
          inputs: {
            create: { id: firstInputId, sequence: 0, kind: "INITIAL", prompt },
          },
        },
      });
      if (sourcePlan) {
        await transaction.agentRun.update({
          where: { id: sourcePlan.id },
          data: { playedAt: new Date(), playedSessionNumber: displayNumber },
        });
      }
      if (kind === "SESSION") {
        await transaction.worktreeRunLease.create({
          data: { worktreeId: worktree.id, runId: id },
        });
      }
      if (attachmentIds.length) {
        const changed = await transaction.runAttachment.updateMany({
          where: { id: { in: attachmentIds }, inputId: null },
          data: { inputId: firstInputId, draftId: null },
        });
        if (changed.count !== attachmentIds.length) {
          throw new Error("One or more attachments are no longer available");
        }
      }
      if (input.draftId) {
        await transaction.runDraft.deleteMany({ where: { id: input.draftId } });
      }
      const command = await enqueueCommand(transaction, {
        runId: id,
        agentId: worktree.codebase.agentId,
        type: input.sourcePlanId ? "PLAY_PLAN" : "START",
        payload: {
          contextMode: input.contextMode ?? null,
          sourcePlanId: input.sourcePlanId ?? null,
          parentRunId: input.parentRunId ?? null,
          followUpMode: input.followUpMode ?? null,
        },
      });
      return { run, command };
    });
    publishRun(result.run.id);
    publishCommand(result.command, result.run.agentId!);
    return this.get(result.run.id);
  }

  async playPlan(planId: string) {
    const plan = await this.get(planId);
    if (!plan) throw new Error("Plan not found");
    if (plan.playedAt) throw new Error("This plan has already been run");
    if (!plan.worktreeId) throw new Error("Plan worktree is unavailable");
    return this.createInternal({
      kind: "SESSION",
      worktreeId: plan.worktreeId,
      jiraIssueKey: plan.jiraIssueKey,
      jiraSummary: plan.jiraSummary,
      provider: plan.provider,
      model: plan.model,
      effort: plan.effort,
      webSearchEnabled: plan.webSearchEnabled,
      prompt: `Implement the following plan:\n\n${plan.finalOutput ?? ""}`,
      sourcePlanId: plan.id,
      parentRunId: plan.id,
      followUpMode: "PLAN_PLAY",
      contextMode: "NATIVE",
      attachmentIds: [],
    });
  }

  async followUp(
    sourceId: string,
    input: Omit<RunConfigurationInput, "kind" | "worktreeId" | "parentRunId">,
  ) {
    const source = await this.get(sourceId);
    if (!source || !source.worktreeId) throw new Error("Source run not found");
    const mode = requiredText(
      input.followUpMode ?? "",
      "Follow-up mode",
      50,
    ).toUpperCase();
    if (!["RESUME", "FRESH", "RESEND"].includes(mode)) {
      throw new Error("Follow-up mode is not supported");
    }
    const transfer =
      source.kind === "SESSION" && source.status === "PAUSED"
        ? source.id
        : undefined;
    const attachmentIds =
      mode === "RESEND" && !input.attachmentIds?.length
        ? await cloneRunAttachments(
            source.inputs[0]?.attachments.map(({ id }) => id) ?? [],
          )
        : input.attachmentIds;
    let prompt =
      mode === "RESEND" && !input.prompt.trim()
        ? source.initialPrompt
        : input.prompt;
    if (mode === "RESUME" && input.provider.toUpperCase() !== source.provider) {
      const contextMode =
        input.contextMode?.toUpperCase() === "SUMMARY"
          ? "SUMMARY"
          : "NORMALIZED";
      const context =
        contextMode === "SUMMARY"
          ? source.finalOutput || "No final summary is available."
          : [
              ...source.inputs.map(
                (entry) => `[${entry.kind}]\n${entry.prompt}`,
              ),
              ...(await this.events({ runId: source.id, first: 500 })).map(
                (event) =>
                  `[${event.type}] ${event.summary}${event.detailMarkdown ? `\n${event.detailMarkdown}` : ""}`,
              ),
            ].join("\n\n");
      prompt = [
        "Continue from this normalized visible context. Hidden provider state is not available across providers.",
        context,
        `New request:\n${prompt}`,
      ]
        .join("\n\n")
        .slice(0, 2_000_000);
    }
    return this.createInternal(
      {
        ...input,
        attachmentIds,
        kind: source.kind,
        worktreeId: source.worktreeId,
        jiraIssueKey: input.jiraIssueKey ?? source.jiraIssueKey,
        jiraSummary: input.jiraSummary ?? source.jiraSummary,
        parentRunId: source.id,
        followUpMode: mode,
        prompt,
      },
      { transferLeaseFromRunId: transfer },
    );
  }

  async archive(ids: string[], archived: boolean) {
    const prisma = await getPrismaClient();
    const result = await prisma.agentRun.updateMany({
      where: { id: { in: [...new Set(ids)] } },
      data: { archivedAt: archived ? new Date() : null },
    });
    for (const id of ids) publishRun(id);
    return result.count;
  }

  async archiveDrafts(ids: string[], archived: boolean) {
    const prisma = await getPrismaClient();
    const result = await prisma.runDraft.updateMany({
      where: { id: { in: [...new Set(ids)] } },
      data: { archivedAt: archived ? new Date() : null },
    });
    agentEventBus.publish(RUNS_CHANGED_TOPIC, { runChanged: { id: "drafts" } });
    return result.count;
  }

  async deleteDrafts(ids: string[]) {
    const prisma = await getPrismaClient();
    const attachments = await prisma.runAttachment.findMany({
      where: { draftId: { in: ids } },
      select: { storagePath: true },
    });
    const result = await prisma.runDraft.deleteMany({
      where: { id: { in: [...new Set(ids)] } },
    });
    await removeRunAttachmentFiles(
      attachments.map(({ storagePath }) => storagePath),
    );
    agentEventBus.publish(RUNS_CHANGED_TOPIC, { runChanged: { id: "drafts" } });
    return result.count;
  }

  async deleteRuns(ids: string[]) {
    const prisma = await getPrismaClient();
    const runs = await prisma.agentRun.findMany({
      where: { id: { in: [...new Set(ids)] } },
      include: { attempts: true, inputs: { include: { attachments: true } } },
    });
    let affected = 0;
    for (const run of runs) {
      const native = run.attempts.filter(({ nativeId }) => nativeId);
      if (native.length && run.agentId) {
        const command = await prisma.$transaction(async (transaction) => {
          await transaction.agentRun.update({
            where: { id: run.id },
            data: { phase: "DELETE_REQUESTED" },
          });
          return enqueueCommand(transaction, {
            runId: run.id,
            agentId: run.agentId!,
            type: "DELETE_NATIVE",
            payload: {
              attempts: native.map(({ id, nativeId }) => ({ id, nativeId })),
            },
            idempotencyKey: `${run.id}:delete-native`,
          });
        });
        publishCommand(command, run.agentId);
      } else {
        const paths = run.inputs.flatMap((entry) =>
          entry.attachments.map(({ storagePath }) => storagePath),
        );
        await prisma.agentRun.delete({ where: { id: run.id } });
        await removeRunAttachmentFiles(paths);
      }
      publishRun(run.id);
      affected += 1;
    }
    return affected;
  }

  async lifecycle(runId: string, type: "PAUSE" | "CONTINUE" | "CANCEL") {
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const run = await transaction.agentRun.findUnique({
        where: { id: runId },
      });
      if (!run || !run.agentId) throw new Error("Run not found");
      if (run.origin !== "MANAGED")
        throw new Error("Imported runs are read-only");
      if (TERMINAL_STATUSES.has(run.status))
        throw new Error("Run is already finished");
      if (type === "PAUSE" && run.status !== "IN_PROGRESS") {
        throw new Error("Only an in-progress run can be paused");
      }
      if (type === "CONTINUE" && run.status !== "PAUSED") {
        throw new Error("Only a paused run can continue");
      }
      if (
        (type === "PAUSE" && run.phase === "PAUSE_REQUESTED") ||
        (type === "CANCEL" && run.phase === "CANCEL_REQUESTED")
      ) {
        return { run, command: null };
      }
      await transaction.agentRun.update({
        where: { id: runId },
        data:
          type === "CONTINUE"
            ? { status: "IN_PROGRESS", phase: "QUEUED", finishedAt: null }
            : {
                phase:
                  type === "PAUSE" ? "PAUSE_REQUESTED" : "CANCEL_REQUESTED",
              },
      });
      const command = await enqueueCommand(transaction, {
        runId,
        agentId: run.agentId,
        type,
        payload:
          type === "CONTINUE"
            ? { prompt: "Continue from where you stopped." }
            : {},
      });
      return { run, command };
    });
    publishRun(runId);
    if (result.command) publishCommand(result.command, result.run.agentId!);
    return this.get(runId);
  }

  async steer(
    runId: string,
    promptValue: string,
    attachmentIds: string[] = [],
  ) {
    const prompt = requiredText(promptValue, "Steering prompt", 200_000);
    await this.requireAttachments(attachmentIds);
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const run = await transaction.agentRun.findUnique({
        where: { id: runId },
      });
      if (!run?.agentId || run.origin !== "MANAGED")
        throw new Error("Run not found");
      if (run.status !== "IN_PROGRESS")
        throw new Error("Run is not in progress");
      const last = await transaction.runInput.findFirst({
        where: { runId },
        orderBy: { sequence: "desc" },
      });
      const inputId = randomUUID();
      await transaction.runInput.create({
        data: {
          id: inputId,
          runId,
          sequence: (last?.sequence ?? -1) + 1,
          kind: "STEERING",
          prompt,
        },
      });
      if (attachmentIds.length) {
        await transaction.runAttachment.updateMany({
          where: { id: { in: attachmentIds }, inputId: null, draftId: null },
          data: { inputId },
        });
      }
      const pending = await transaction.runQuestionBatch.count({
        where: { runId, status: "PENDING" },
      });
      const command = await enqueueCommand(transaction, {
        runId,
        agentId: run.agentId,
        type: "STEER",
        payload: { inputId, queuedBehindQuestion: pending > 0 },
      });
      return { run, command };
    });
    publishRun(runId);
    publishCommand(result.command, result.run.agentId!);
    return this.get(runId);
  }

  async answerQuestion(batchId: string, answers: unknown) {
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const batch = await transaction.runQuestionBatch.findUnique({
        where: { id: batchId },
        include: { run: true, answerRevisions: true },
      });
      if (!batch?.run.agentId || batch.run.origin !== "MANAGED") {
        throw new Error("Question batch not found");
      }
      if (batch.status !== "PENDING")
        throw new Error("Question was already answered");
      const revision = batch.answerRevisions.length;
      await transaction.runAnswerRevision.create({
        data: {
          id: randomUUID(),
          batchId,
          revision,
          answersJson: JSON.stringify(answers),
        },
      });
      await transaction.runQuestionBatch.update({
        where: { id: batchId },
        data: { status: "ANSWERED", answeredAt: new Date() },
      });
      await transaction.agentRun.update({
        where: { id: batch.runId },
        data: { phase: "RUNNING" },
      });
      const command = await enqueueCommand(transaction, {
        runId: batch.runId,
        agentId: batch.run.agentId,
        type: "ANSWER",
        payload: { batchId, nativeRequestId: batch.nativeRequestId, answers },
      });
      return { batch, command };
    });
    publishRun(result.batch.runId);
    agentEventBus.publish(runQuestionTopic(result.batch.runId), {
      runQuestionChanged: { id: batchId, runId: result.batch.runId },
    });
    publishCommand(result.command, result.batch.run.agentId!);
    return this.get(result.batch.runId);
  }

  async prepareAnswerRevision(batchId: string) {
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const batch = await transaction.runQuestionBatch.findUnique({
        where: { id: batchId },
        include: { run: true, checkpoint: true },
      });
      if (
        !batch?.run.agentId ||
        !batch.run.worktreeId ||
        batch.run.origin !== "MANAGED" ||
        batch.status !== "ANSWERED" ||
        batch.supersededAt
      ) {
        throw new Error("This answer cannot be edited");
      }
      if (!batch.checkpoint?.refName || !batch.checkpoint.worktreeTree) {
        throw new Error("The checkpoint before this question is unavailable");
      }
      const lease = await transaction.worktreeRunLease.findUnique({
        where: { worktreeId: batch.run.worktreeId },
      });
      if (lease && lease.runId !== batch.runId) {
        throw new Error("Another Session owns this worktree");
      }
      if (batch.run.kind === "SESSION" && !lease) {
        await transaction.worktreeRunLease.create({
          data: { worktreeId: batch.run.worktreeId, runId: batch.runId },
        });
      }
      await transaction.runQuestionBatch.update({
        where: { id: batchId },
        data: {
          revisionPreparedAt: null,
          rollbackPatch: null,
          pushedCommitWarning: null,
        },
      });
      await transaction.agentRun.update({
        where: { id: batch.runId },
        data: { phase: "ANSWER_REVISION_PREPARING" },
      });
      const command = await enqueueCommand(transaction, {
        runId: batch.runId,
        agentId: batch.run.agentId,
        type: "PREPARE_ANSWER_REVISION",
        payload: { batchId, checkpoint: batch.checkpoint },
      });
      return { batch, command };
    });
    publishRun(result.batch.runId);
    publishCommand(result.command, result.batch.run.agentId!);
    return this.get(result.batch.runId);
  }

  async reviseAnswer(batchId: string, answers: unknown, stash: boolean) {
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const batch = await transaction.runQuestionBatch.findUnique({
        where: { id: batchId },
        include: {
          checkpoint: true,
          questions: { orderBy: { position: "asc" } },
          answerRevisions: true,
          run: {
            include: {
              inputs: { orderBy: { sequence: "asc" } },
              events: { orderBy: { sequence: "asc" } },
            },
          },
        },
      });
      if (
        !batch?.run.agentId ||
        !batch.run.worktreeId ||
        batch.run.origin !== "MANAGED" ||
        batch.status !== "ANSWERED" ||
        !batch.revisionPreparedAt ||
        !batch.checkpoint?.refName
      ) {
        throw new Error("The answer revision is not ready");
      }
      const lease = await transaction.worktreeRunLease.findUnique({
        where: { worktreeId: batch.run.worktreeId },
      });
      if (lease && lease.runId !== batch.runId) {
        throw new Error("Another Session owns this worktree");
      }
      const revisionId = randomUUID();
      const revision = batch.answerRevisions.length;
      await transaction.runAnswerRevision.create({
        data: {
          id: revisionId,
          batchId,
          revision,
          answersJson: JSON.stringify(answers),
        },
      });
      const previousInputs = batch.run.inputs
        .map((input) => `${input.kind}:\n${input.prompt}`)
        .join("\n\n");
      const transcript = batch.run.events
        .filter((event) =>
          batch.eventSequence === null
            ? event.createdAt <= batch.createdAt
            : event.sequence <= batch.eventSequence,
        )
        .map(
          (event) =>
            `[${event.type}] ${event.summary}${event.detailMarkdown ? `\n${event.detailMarkdown}` : ""}`,
        )
        .join("\n\n");
      const revisedPrompt = [
        "Continue this run from the question below using the revised answer. Treat the visible transcript as context; hidden provider state from the superseded attempt is unavailable.",
        previousInputs,
        transcript,
        `Questions:\n${batch.questions.map((question) => `- ${question.prompt}`).join("\n")}`,
        `Revised answer:\n${JSON.stringify(answers, null, 2)}`,
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 2_000_000);
      const lastInput = batch.run.inputs.at(-1);
      const inputId = randomUUID();
      await transaction.runInput.create({
        data: {
          id: inputId,
          runId: batch.runId,
          sequence: (lastInput?.sequence ?? -1) + 1,
          kind: "ANSWER_REVISION",
          prompt: revisedPrompt,
        },
      });
      await transaction.agentRun.update({
        where: { id: batch.runId },
        data: {
          status: "IN_PROGRESS",
          phase: "ANSWER_REVISION_QUEUED",
          finalOutput: null,
          error: null,
          finishedAt: null,
        },
      });
      const command = await enqueueCommand(transaction, {
        runId: batch.runId,
        agentId: batch.run.agentId,
        type: "REVISE_ANSWER",
        payload: {
          batchId,
          revisionId,
          inputId,
          stash: Boolean(stash),
          checkpoint: batch.checkpoint,
        },
      });
      return { batch, command };
    });
    publishRun(result.batch.runId);
    publishCommand(result.command, result.batch.run.agentId!);
    return this.get(result.batch.runId);
  }

  async pendingCommands(agentId: string) {
    const prisma = await getPrismaClient();
    return prisma.runCommand.findMany({
      where: { agentId, status: { in: ["QUEUED", "RUNNING"] } },
      orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
      take: 200,
      include: runCommandInclude,
    });
  }

  async claimCommand(agentId: string, commandId: string) {
    const prisma = await getPrismaClient();
    await prisma.runCommand.updateMany({
      where: { id: commandId, agentId, status: "QUEUED" },
      data: { status: "RUNNING", claimedAt: new Date() },
    });
    const command = await prisma.runCommand.findUnique({
      where: { id: commandId },
      include: runCommandInclude,
    });
    if (!command || command.agentId !== agentId)
      throw new Error("Run command not found");
    if (command.status !== "RUNNING")
      throw new Error("Run command cannot be claimed");
    return command;
  }

  async completeCommand(
    agentId: string,
    commandId: string,
    status: string,
    error?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const command = await prisma.runCommand.findUnique({
      where: { id: commandId },
    });
    if (!command || command.agentId !== agentId)
      throw new Error("Run command not found");
    const updated = await prisma.runCommand.update({
      where: { id: commandId },
      data: {
        status: status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
        error: optionalText(error, 20_000),
        finishedAt: new Date(),
      },
    });
    if (updated.type === "DELETE_NATIVE" && updated.status === "SUCCEEDED") {
      const run = await prisma.agentRun.findUnique({
        where: { id: updated.runId },
        include: { inputs: { include: { attachments: true } } },
      });
      if (run) {
        const paths = run.inputs.flatMap((entry) =>
          entry.attachments.map(({ storagePath }) => storagePath),
        );
        await prisma.agentRun.delete({ where: { id: run.id } });
        await removeRunAttachmentFiles(paths);
      }
    } else if (updated.status === "FAILED") {
      await prisma.agentRun.update({
        where: { id: updated.runId },
        data: {
          error: updated.error,
          phase: `${updated.type}_FAILED`,
          ...(["START", "PLAY_PLAN", "CONTINUE"].includes(updated.type)
            ? { status: "FAILED", finishedAt: new Date() }
            : {}),
          ...(["PREPARE_ANSWER_REVISION", "REVISE_ANSWER"].includes(
            updated.type,
          )
            ? { status: "PAUSED", finishedAt: null }
            : {}),
        },
      });
      if (["START", "PLAY_PLAN", "CONTINUE"].includes(updated.type)) {
        await prisma.worktreeRunLease.deleteMany({
          where: { runId: updated.runId },
        });
      }
    } else if (["PAUSE", "CANCEL"].includes(updated.type)) {
      const terminal = updated.type === "CANCEL";
      await prisma.agentRun.updateMany({
        where: {
          id: updated.runId,
          status: { notIn: [...TERMINAL_STATUSES] },
        },
        data: {
          status: terminal ? "CANCELLED" : "PAUSED",
          phase: terminal ? "CANCELLED" : "PAUSED",
          finishedAt: terminal ? new Date() : null,
        },
      });
      if (terminal) {
        await prisma.worktreeRunLease.deleteMany({
          where: { runId: updated.runId },
        });
      }
    }
    publishRun(updated.runId);
    return updated;
  }

  async beginAttempt(agentId: string, runId: string, nativeId?: string | null) {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { attempts: true },
    });
    if (!run || run.agentId !== agentId)
      throw new Error("Run not found for this agent");
    const generation = run.attempts.length;
    const attempt = await prisma.runAttempt.create({
      data: {
        id: randomUUID(),
        runId,
        generation,
        nativeId: nativeId || null,
        nativeKey: nativeId ? `${agentId}:${run.provider}:${nativeId}` : null,
        status: "RUNNING",
      },
    });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { phase: "RUNNING", startedAt: run.startedAt ?? new Date() },
    });
    publishRun(runId);
    return attempt;
  }

  async updateAttemptNativeId(
    agentId: string,
    attemptId: string,
    nativeId: string,
    providerVersion?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const attempt = await prisma.runAttempt.findUnique({
      where: { id: attemptId },
      include: { run: true },
    });
    if (!attempt || attempt.run.agentId !== agentId)
      throw new Error("Attempt not found");
    const updated = await prisma.runAttempt.update({
      where: { id: attemptId },
      data: {
        nativeId,
        nativeKey: `${agentId}:${attempt.run.provider}:${nativeId}`,
      },
    });
    if (providerVersion) {
      await prisma.agentRun.update({
        where: { id: attempt.runId },
        data: { providerVersion },
      });
    }
    publishRun(attempt.runId);
    return updated;
  }

  async appendEvents(
    agentId: string,
    runId: string,
    attemptId: string | null,
    events: RunEventInput[],
  ) {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.agentId !== agentId)
      throw new Error("Run not found for this agent");
    const saved = [];
    for (const event of events.slice(0, 500)) {
      const summary = requiredText(event.summary, "Event summary", 2_000);
      const value = await prisma.runEvent.upsert({
        where: { id: event.id },
        create: {
          id: event.id,
          runId,
          attemptId,
          sequence: event.sequence,
          type: requiredText(event.type, "Event type", 100).toUpperCase(),
          summary,
          searchText: optionalText(event.searchText, 100_000) ?? summary,
          detailMarkdown: optionalText(event.detailMarkdown, 500_000),
          rawJson: event.raw === undefined ? null : JSON.stringify(event.raw),
          createdAt: parseDate(event.createdAt),
        },
        update: {},
      });
      saved.push(value);
      if (value.type.includes("TOOL") && !value.type.includes("QUESTION")) {
        await prisma.runToolCall.upsert({
          where: { id: `event:${value.id}` },
          create: {
            id: `event:${value.id}`,
            runId,
            attemptId,
            sequence: value.sequence,
            name: summary.split(/[\s:(]/, 1)[0] || value.type,
            status:
              value.type.includes("FAIL") || value.type.includes("ERROR")
                ? "FAILED"
                : value.type.includes("COMPLETE") ||
                    value.type.includes("RESULT")
                  ? "COMPLETED"
                  : "OBSERVED",
            inputJson: value.rawJson,
            error:
              value.type.includes("FAIL") || value.type.includes("ERROR")
                ? summary
                : null,
            finishedAt: value.createdAt,
          },
          update: {},
        });
      }
      agentEventBus.publish(runEventTopic(runId), { runEventAdded: value });
    }
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        toolCallCount: await prisma.runToolCall.count({ where: { runId } }),
      },
    });
    publishRun(runId);
    return saved;
  }

  async reportQuestion(
    agentId: string,
    runId: string,
    attemptId: string | null,
    nativeRequestId: string | null,
    eventSequence: number | null,
    questions: RunQuestionInput[],
  ) {
    if (!questions.length || questions.length > 10)
      throw new Error("Question batch is invalid");
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const run = await transaction.agentRun.findUnique({
        where: { id: runId },
        include: { worktree: true },
      });
      if (!run || run.agentId !== agentId)
        throw new Error("Run not found for this agent");
      if (nativeRequestId) {
        const existing = await transaction.runQuestionBatch.findUnique({
          where: { runId_nativeRequestId: { runId, nativeRequestId } },
          include: {
            questions: {
              orderBy: { position: "asc" },
              include: { options: { orderBy: { position: "asc" } } },
            },
          },
        });
        if (existing) return { batch: existing, notification: null };
      }
      const id = randomUUID();
      const batch = await transaction.runQuestionBatch.create({
        data: {
          id,
          runId,
          attemptId,
          nativeRequestId,
          eventSequence:
            Number.isInteger(eventSequence) && (eventSequence ?? -1) >= -1
              ? eventSequence
              : null,
          questions: {
            create: questions.map((question, position) => ({
              id: question.id || randomUUID(),
              position,
              header: optionalText(question.header, 200),
              prompt: requiredText(question.prompt, "Question", 10_000),
              multiSelect: Boolean(question.multiSelect),
              allowCustom: question.allowCustom !== false,
              options: {
                create: (question.options ?? []).map(
                  (option, optionPosition) => ({
                    id: randomUUID(),
                    position: optionPosition,
                    label: requiredText(option.label, "Option label", 500),
                    description: optionalText(option.description, 2_000),
                  }),
                ),
              },
            })),
          },
        },
        include: { questions: { include: { options: true } } },
      });
      await transaction.agentRun.update({
        where: { id: runId },
        data: { phase: "WAITING_FOR_ANSWER" },
      });
      const notification = this.notifications
        ? await this.notifications.recordInTransaction(transaction, {
            dedupeKey: `run:${runId}:question:${id}`,
            typeKey: "RUN_NEEDS_ANSWER",
            title: `${run.kind === "PLAN" ? "Plan" : "Session"} #${run.displayNumber} needs an answer`,
            body: questions[0]!.prompt.slice(0, 1_000),
            href: runHref(run),
            resourceKind: run.kind,
            resourceId: run.id,
            worktreeId: run.worktreeId,
            highlightColor: run.worktree?.highlightColor,
          })
        : null;
      return { batch, notification };
    });
    this.notifications?.created(result.notification);
    publishRun(runId);
    agentEventBus.publish(runQuestionTopic(runId), {
      runQuestionChanged: { id: result.batch.id, runId },
    });
    return result.batch;
  }

  async reportUsage(
    agentId: string,
    runId: string,
    attemptId: string | null,
    input: {
      model: string;
      inputTokens?: number | null;
      outputTokens?: number | null;
      reasoningTokens?: number | null;
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
      estimatedCost?: number | null;
      toolCallCount?: number | null;
      pricingSource?: string | null;
    },
  ) {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.agentId !== agentId)
      throw new Error("Run not found for this agent");
    const numeric = (value?: number | null) =>
      Number.isFinite(value) && (value ?? 0) >= 0 ? Math.floor(value!) : 0;
    await prisma.$transaction(async (transaction) => {
      const usage = await transaction.runModelUsage.findFirst({
        where: { runId, attemptId, model: input.model },
      });
      const usageData = {
        inputTokens: numeric(input.inputTokens),
        outputTokens: numeric(input.outputTokens),
        reasoningTokens: numeric(input.reasoningTokens),
        cacheReadTokens: numeric(input.cacheReadTokens),
        cacheWriteTokens: numeric(input.cacheWriteTokens),
        estimatedCost: input.estimatedCost ?? null,
      };
      if (usage) {
        await transaction.runModelUsage.update({
          where: { id: usage.id },
          data: usageData,
        });
      } else {
        await transaction.runModelUsage.create({
          data: {
            id: randomUUID(),
            runId,
            attemptId,
            model: input.model,
            ...usageData,
          },
        });
      }
      const totals = await transaction.runModelUsage.aggregate({
        where: { runId },
        _sum: {
          inputTokens: true,
          outputTokens: true,
          reasoningTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
        },
      });
      const pricedUsage = await transaction.runModelUsage.findMany({
        where: { runId, estimatedCost: { not: null } },
        select: { model: true, estimatedCost: true },
      });
      const ccusageCost = pricedUsage.find(
        ({ model }) => model === "estimated-total",
      )?.estimatedCost;
      const observedToolCalls = await transaction.runToolCall.count({
        where: { runId },
      });
      await transaction.agentRun.update({
        where: { id: runId },
        data: {
          inputTokens: totals._sum.inputTokens ?? 0,
          outputTokens: totals._sum.outputTokens ?? 0,
          reasoningTokens: totals._sum.reasoningTokens ?? 0,
          cacheReadTokens: totals._sum.cacheReadTokens ?? 0,
          cacheWriteTokens: totals._sum.cacheWriteTokens ?? 0,
          toolCallCount: Math.max(
            observedToolCalls,
            numeric(input.toolCallCount),
          ),
          estimatedCost:
            ccusageCost ??
            (pricedUsage.length
              ? pricedUsage.reduce(
                  (total, usage) => total + (usage.estimatedCost ?? 0),
                  0,
                )
              : null),
          pricingSource: optionalText(input.pricingSource, 200),
          pricingUpdatedAt: new Date(),
        },
      });
    });
    publishRun(runId);
    return this.get(runId);
  }

  async finishAttempt(
    agentId: string,
    attemptId: string,
    input: {
      status: string;
      phase?: string | null;
      finalOutput?: string | null;
      error?: string | null;
    },
  ) {
    const status = input.status.toUpperCase();
    if (!["PAUSED", "COMPLETED", "CANCELLED", "FAILED"].includes(status)) {
      throw new Error("Run completion status is invalid");
    }
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      const attempt = await transaction.runAttempt.findUnique({
        where: { id: attemptId },
        include: { run: { include: { worktree: true } } },
      });
      if (!attempt || attempt.run.agentId !== agentId)
        throw new Error("Attempt not found");
      await transaction.runAttempt.update({
        where: { id: attemptId },
        data: { status, finishedAt: new Date() },
      });
      const run = await transaction.agentRun.update({
        where: { id: attempt.runId },
        data: {
          status,
          phase: input.phase?.trim().toUpperCase() || status,
          finalOutput: optionalText(input.finalOutput, 2_000_000),
          error: optionalText(input.error, 20_000),
          finishedAt: status === "PAUSED" ? null : new Date(),
        },
      });
      if (TERMINAL_STATUSES.has(status)) {
        await transaction.worktreeRunLease.deleteMany({
          where: { runId: run.id },
        });
      }
      const typeKey =
        status === "COMPLETED"
          ? "RUN_COMPLETED"
          : status === "FAILED"
            ? "RUN_FAILED"
            : status === "CANCELLED"
              ? "RUN_CANCELLED"
              : input.phase === "RECOVERY_PAUSED"
                ? "RUN_RECOVERY_PAUSED"
                : null;
      const notification =
        typeKey && this.notifications
          ? await this.notifications.recordInTransaction(transaction, {
              dedupeKey: `run:${run.id}:status:${status}:${attempt.generation}`,
              typeKey,
              title: `${run.kind === "PLAN" ? "Plan" : "Session"} #${run.displayNumber} ${status.toLowerCase()}`,
              body:
                input.error ||
                input.finalOutput?.slice(0, 1_000) ||
                `The ${run.kind.toLowerCase()} is ${status.toLowerCase()}.`,
              href: runHref(run),
              resourceKind: run.kind,
              resourceId: run.id,
              worktreeId: run.worktreeId,
              highlightColor: attempt.run.worktree?.highlightColor,
            })
          : null;
      return { run, notification };
    });
    this.notifications?.created(result.notification);
    publishRun(result.run.id);
    return this.get(result.run.id);
  }

  async reportCheckpoint(
    agentId: string,
    runId: string,
    attemptId: string | null,
    input: {
      kind: string;
      headSha?: string | null;
      branch?: string | null;
      upstreamSha?: string | null;
      indexTree?: string | null;
      worktreeTree?: string | null;
      refName?: string | null;
      manifestJson?: string | null;
      diffSummary?: string | null;
      diffPatch?: string | null;
      stashRef?: string | null;
      questionBatchId?: string | null;
    },
  ) {
    const prisma = await getPrismaClient();
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.agentId !== agentId)
      throw new Error("Run not found for this agent");
    if (input.questionBatchId) {
      const batch = await prisma.runQuestionBatch.findUnique({
        where: { id: input.questionBatchId },
      });
      if (!batch || batch.runId !== runId)
        throw new Error("Question batch not found");
    }
    const checkpoint = await prisma.runCheckpoint.create({
      data: {
        id: randomUUID(),
        runId,
        attemptId,
        questionBatchId: input.questionBatchId ?? null,
        kind: requiredText(input.kind, "Checkpoint kind", 100).toUpperCase(),
        headSha: optionalText(input.headSha, 100),
        branch: optionalText(input.branch, 500),
        upstreamSha: optionalText(input.upstreamSha, 100),
        indexTree: optionalText(input.indexTree, 100),
        worktreeTree: optionalText(input.worktreeTree, 100),
        refName: optionalText(input.refName, 1_000),
        manifestJson: optionalText(input.manifestJson, 2_000_000),
        diffSummary: optionalText(input.diffSummary, 500_000),
        diffPatch: optionalText(input.diffPatch, 2_000_000),
        stashRef: optionalText(input.stashRef, 1_000),
      },
    });
    publishRun(runId);
    return checkpoint;
  }

  async reportAnswerRevisionPreview(
    agentId: string,
    batchId: string,
    rollbackPatch: string,
    pushedCommitWarning?: string | null,
  ) {
    const prisma = await getPrismaClient();
    const batch = await prisma.runQuestionBatch.findUnique({
      where: { id: batchId },
      include: { run: true },
    });
    if (
      !batch ||
      batch.run.agentId !== agentId ||
      batch.run.origin !== "MANAGED"
    ) {
      throw new Error("Question batch not found for this agent");
    }
    const updated = await prisma.runQuestionBatch.update({
      where: { id: batchId },
      data: {
        revisionPreparedAt: new Date(),
        rollbackPatch: rollbackPatch.slice(0, 2_000_000),
        pushedCommitWarning: optionalText(pushedCommitWarning, 20_000),
      },
      include: {
        questions: {
          orderBy: { position: "asc" },
          include: { options: { orderBy: { position: "asc" } } },
        },
        answerRevisions: { orderBy: { revision: "asc" } },
      },
    });
    await prisma.agentRun.update({
      where: { id: batch.runId },
      data: { status: "PAUSED", phase: "ANSWER_REVISION_READY" },
    });
    publishRun(batch.runId);
    agentEventBus.publish(runQuestionTopic(batch.runId), {
      runQuestionChanged: { id: batchId, runId: batch.runId },
    });
    return updated;
  }

  async applyAnswerRevision(
    agentId: string,
    batchId: string,
    revisionId: string,
    replacementAttemptId: string,
  ) {
    const prisma = await getPrismaClient();
    const runId = await prisma.$transaction(async (transaction) => {
      const batch = await transaction.runQuestionBatch.findUnique({
        where: { id: batchId },
        include: { run: true, attempt: true },
      });
      const replacement = await transaction.runAttempt.findUnique({
        where: { id: replacementAttemptId },
      });
      const revision = await transaction.runAnswerRevision.findUnique({
        where: { id: revisionId },
      });
      if (
        !batch ||
        batch.run.agentId !== agentId ||
        !batch.attempt ||
        !replacement ||
        replacement.runId !== batch.runId ||
        !revision ||
        revision.batchId !== batchId
      ) {
        throw new Error("Answer revision cannot be applied");
      }
      const now = new Date();
      const supersededAttempts = await transaction.runAttempt.findMany({
        where: {
          runId: batch.runId,
          generation: { gte: batch.attempt.generation },
          id: { not: replacementAttemptId },
        },
        select: { id: true },
      });
      const attemptIds = supersededAttempts.map(({ id }) => id);
      await transaction.runAttempt.updateMany({
        where: { id: { in: attemptIds } },
        data: { status: "SUPERSEDED", supersededAt: now, finishedAt: now },
      });
      await transaction.runEvent.updateMany({
        where: {
          runId: batch.runId,
          sequence: { gt: batch.eventSequence ?? -1 },
          supersededAt: null,
        },
        data: { supersededAt: now },
      });
      await transaction.runToolCall.updateMany({
        where: { attemptId: { in: attemptIds }, supersededAt: null },
        data: { supersededAt: now },
      });
      await transaction.runModelUsage.updateMany({
        where: { attemptId: { in: attemptIds } },
        data: { superseded: true },
      });
      const laterBatches = await transaction.runQuestionBatch.findMany({
        where: { runId: batch.runId, createdAt: { gt: batch.createdAt } },
        select: { id: true },
      });
      const laterBatchIds = laterBatches.map(({ id }) => id);
      await transaction.runQuestionBatch.updateMany({
        where: { id: { in: laterBatchIds } },
        data: { status: "SUPERSEDED", supersededAt: now },
      });
      await transaction.runAnswerRevision.updateMany({
        where: {
          OR: [
            { batchId: { in: laterBatchIds } },
            { batchId, id: { not: revisionId } },
          ],
          supersededAt: null,
        },
        data: { supersededAt: now },
      });
      await transaction.runAnswerRevision.update({
        where: { id: revisionId },
        data: { replacementAttemptId },
      });
      await transaction.agentRun.update({
        where: { id: batch.runId },
        data: { status: "IN_PROGRESS", phase: "RUNNING" },
      });
      return batch.runId;
    });
    publishRun(runId);
    return this.get(runId);
  }

  async importRuns(
    agentId: string,
    providerValue: string,
    records: ImportedRunInput[],
  ) {
    const provider = enumValue(PROVIDERS, providerValue, "Provider");
    const prisma = await getPrismaClient();
    let imported = 0;
    for (const record of records.slice(0, 500)) {
      const nativeKey = `${agentId}:${provider}:${requiredText(record.nativeId, "Native ID", 500)}`;
      const importedStatus = (() => {
        const value = record.status?.toUpperCase() ?? "COMPLETED";
        if (
          [
            "ACTIVE",
            "RUNNING",
            "STARTING",
            "IN_PROGRESS",
            "WAITING_FOR_ANSWER",
          ].includes(value)
        )
          return "IN_PROGRESS";
        if (value === "PAUSED") return "PAUSED";
        if (value === "CANCELLED" || value === "CANCELED") return "CANCELLED";
        if (value === "FAILED" || value === "ERROR") return "FAILED";
        return "COMPLETED";
      })();
      const existing = await prisma.runAttempt.findUnique({
        where: { nativeKey },
        include: { run: true },
      });
      if (existing) {
        if (existing.run.origin === "IMPORTED") {
          const collision =
            existing.run.kind === "SESSION" && importedStatus === "IN_PROGRESS"
              ? await prisma.worktreeRunLease.findUnique({
                  where: { worktreeId: existing.run.worktreeId ?? "" },
                })
              : null;
          await prisma.$transaction([
            prisma.runAttempt.update({
              where: { id: existing.id },
              data: {
                rawMetadataJson: JSON.stringify(record.rawMetadata ?? {}),
              },
            }),
            prisma.agentRun.update({
              where: { id: existing.runId },
              data: {
                status: importedStatus,
                phase: collision
                  ? "IMPORTED_ACTIVE_COLLISION"
                  : "IMPORTED_SYNCED",
                model: record.model || existing.run.model,
                effort: optionalText(record.effort, 100),
                finalOutput: optionalText(record.finalOutput, 2_000_000),
                branch: record.branch ?? existing.run.branch,
                jiraIssueKey: optionalText(record.jiraIssueKey, 100),
                nativeArchivedAt: record.archived ? new Date() : null,
                startedAt:
                  parseDate(record.createdAt) ?? existing.run.startedAt,
                finishedAt:
                  importedStatus === "IN_PROGRESS"
                    ? null
                    : (parseDate(record.updatedAt) ?? existing.run.finishedAt),
              },
            }),
          ]);
          publishRun(existing.runId);
        }
        continue;
      }
      const worktree = await prisma.worktree.findUnique({
        where: { id: record.worktreeId },
        include: { codebase: { include: { repository: true } } },
      });
      if (!worktree || worktree.codebase.agentId !== agentId) continue;
      const kind = record.kind?.toUpperCase() === "PLAN" ? "PLAN" : "SESSION";
      const collision =
        kind === "SESSION" && importedStatus === "IN_PROGRESS"
          ? await prisma.worktreeRunLease.findUnique({
              where: { worktreeId: worktree.id },
            })
          : null;
      const displayNumber = await prisma.$transaction((transaction) =>
        nextDisplayNumber(transaction, kind),
      );
      const id = randomUUID();
      await prisma.agentRun.create({
        data: {
          id,
          kind,
          displayNumber,
          status: importedStatus,
          phase: collision ? "IMPORTED_ACTIVE_COLLISION" : "IMPORTED_SYNCED",
          origin: "IMPORTED",
          provider,
          worktreeId: worktree.id,
          agentId,
          jiraIssueKey: optionalText(record.jiraIssueKey, 100),
          repositoryName: worktree.codebase.repository.name,
          branch: record.branch ?? worktree.branch,
          model: record.model || "unknown",
          effort: optionalText(record.effort, 100),
          initialPrompt: record.prompt?.trim() || "Imported provider history",
          finalOutput: optionalText(record.finalOutput, 2_000_000),
          archivedAt: record.archived ? new Date() : null,
          nativeArchivedAt: record.archived ? new Date() : null,
          startedAt: parseDate(record.createdAt),
          finishedAt: parseDate(record.updatedAt),
          createdAt: parseDate(record.createdAt),
          attempts: {
            create: {
              id: randomUUID(),
              generation: 0,
              nativeId: record.nativeId,
              nativeKey,
              status: "IMPORTED",
              rawMetadataJson: JSON.stringify(record.rawMetadata ?? {}),
            },
          },
          inputs: {
            create: {
              id: randomUUID(),
              sequence: 0,
              kind: "INITIAL",
              prompt: record.prompt?.trim() || "Imported provider history",
            },
          },
        },
      });
      publishRun(id);
      imported += 1;
    }
    await prisma.runProviderSync.upsert({
      where: { agentId_provider: { agentId, provider } },
      create: {
        id: randomUUID(),
        agentId,
        provider,
        status: "IDLE",
        lastCompletedAt: new Date(),
        importedCount: imported,
      },
      update: {
        status: "IDLE",
        lastCompletedAt: new Date(),
        lastError: null,
        importedCount: { increment: imported },
      },
    });
    return imported;
  }

  async providerCatalog() {
    const prisma = await getPrismaClient();
    const agents = await prisma.agent.findMany({
      select: {
        id: true,
        capabilitiesJson: true,
        lastSeenAt: true,
        disconnectedAt: true,
        heartbeatIntervalSeconds: true,
      },
    });
    const catalogs = await prisma.runProviderSync.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return PROVIDERS.map((key) => {
      const capability = `runs.provider.${key.toLowerCase()}`;
      const available = agents.some((agent) => {
        const sync = catalogs.find(
          (entry) => entry.agentId === agent.id && entry.provider === key,
        );
        return (
          !agent.disconnectedAt &&
          Boolean(agent.lastSeenAt) &&
          Date.now() - agent.lastSeenAt!.getTime() <=
            agentOnlineWindowMs(agent) &&
          (JSON.parse(agent.capabilitiesJson) as unknown[]).includes(
            capability,
          ) &&
          sync?.status !== "FAILED"
        );
      });
      const discovered = catalogs.find(
        ({ provider }) => provider === key,
      )?.catalogJson;
      const catalog = discovered
        ? (JSON.parse(discovered) as {
            models?: Array<{ id: string; label: string; efforts: string[] }>;
            capabilities?: {
              webSearch?: boolean;
              questions?: boolean;
              import?: boolean;
              pause?: boolean;
              steering?: boolean;
              resume?: boolean;
              nativeDelete?: boolean;
            };
          })
        : null;
      return {
        key,
        label:
          key === "OPENCODE"
            ? "OpenCode"
            : key === "CLAUDE"
              ? "Claude"
              : "Codex",
        available,
        models: catalog?.models?.length
          ? catalog.models
          : [
              {
                id: "default",
                label: "Provider default",
                efforts: ["auto", "low", "medium", "high"],
              },
            ],
        supportsWebSearch: catalog?.capabilities?.webSearch ?? true,
        supportsQuestions: catalog?.capabilities?.questions ?? true,
        supportsImport: catalog?.capabilities?.import ?? true,
        supportsPause: catalog?.capabilities?.pause ?? true,
        supportsSteering: catalog?.capabilities?.steering ?? true,
        supportsResume: catalog?.capabilities?.resume ?? true,
        supportsNativeDelete: catalog?.capabilities?.nativeDelete ?? true,
      };
    });
  }

  async providerImportStatus() {
    const prisma = await getPrismaClient();
    return prisma.runProviderSync.findMany({
      orderBy: [{ agentId: "asc" }, { provider: "asc" }],
    });
  }

  async reportProviderImportStatus(
    agentId: string,
    providerValue: string,
    statusValue: string,
    error?: string | null,
    catalog?: unknown,
  ) {
    const provider = enumValue(PROVIDERS, providerValue, "Provider");
    const status = statusValue.trim().toUpperCase();
    if (!["SYNCING", "IDLE", "FAILED"].includes(status)) {
      throw new Error("Import status is invalid");
    }
    const prisma = await getPrismaClient();
    return prisma.runProviderSync.upsert({
      where: { agentId_provider: { agentId, provider } },
      create: {
        id: randomUUID(),
        agentId,
        provider,
        status,
        lastStartedAt: status === "SYNCING" ? new Date() : undefined,
        lastCompletedAt: status === "IDLE" ? new Date() : undefined,
        lastError: optionalText(error, 20_000),
        catalogJson:
          catalog === undefined ? undefined : JSON.stringify(catalog),
      },
      update: {
        status,
        lastStartedAt: status === "SYNCING" ? new Date() : undefined,
        lastCompletedAt: status === "IDLE" ? new Date() : undefined,
        lastError: status === "FAILED" ? optionalText(error, 20_000) : null,
        catalogJson:
          catalog === undefined ? undefined : JSON.stringify(catalog),
      },
    });
  }

  subscribeRuns() {
    return agentEventBus.iterate(RUNS_CHANGED_TOPIC);
  }

  subscribeRun(runId: string) {
    return agentEventBus.iterate(runChangedTopic(runId));
  }

  subscribeEvents(runId: string) {
    return agentEventBus.iterate(runEventTopic(runId));
  }

  subscribeQuestions(runId: string) {
    return agentEventBus.iterate(runQuestionTopic(runId));
  }

  private async requireWorktree(worktreeId: string, provider?: Provider) {
    const prisma = await getPrismaClient();
    const worktree = await prisma.worktree.findUnique({
      where: { id: requiredText(worktreeId, "Worktree", 500) },
      include: { codebase: { include: { repository: true, agent: true } } },
    });
    if (!worktree || worktree.availability !== "AVAILABLE") {
      throw new Error("Worktree is unavailable");
    }
    if (provider) {
      const agent = worktree.codebase.agent;
      const capabilities = JSON.parse(agent.capabilitiesJson) as unknown[];
      if (
        agent.disconnectedAt ||
        !agent.lastSeenAt ||
        Date.now() - agent.lastSeenAt.getTime() > agentOnlineWindowMs(agent) ||
        !capabilities.includes(`runs.provider.${provider.toLowerCase()}`)
      ) {
        throw new Error(`${provider} is unavailable on this worktree's agent`);
      }
      const sync = await prisma.runProviderSync.findUnique({
        where: {
          agentId_provider: {
            agentId: worktree.codebase.agentId,
            provider,
          },
        },
      });
      if (sync?.status === "FAILED") {
        throw new Error(
          `${provider} is unavailable: ${sync.lastError ?? "provider capability check failed"}`,
        );
      }
    }
    return worktree;
  }

  private async requireAttachments(ids: string[], draftId?: string) {
    if (!ids.length) return;
    if (ids.length > 100) throw new Error("Too many attachments");
    const prisma = await getPrismaClient();
    const attachments = await prisma.runAttachment.findMany({
      where: {
        id: { in: ids },
        inputId: null,
        ...(draftId
          ? { OR: [{ draftId }, { draftId: null }] }
          : { draftId: null }),
      },
    });
    if (attachments.length !== ids.length)
      throw new Error("One or more attachments are unavailable");
    if (
      attachments.reduce((total, item) => total + item.size, 0) >
      MAX_RUN_INPUT_ATTACHMENT_BYTES
    ) {
      throw new Error("Attachments exceed the 100 MB input limit");
    }
  }
}
