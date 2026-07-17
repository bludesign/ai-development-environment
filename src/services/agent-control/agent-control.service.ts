import { createHash, randomBytes, randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";

import {
  CCUSAGE_REPORT_JOB_KIND,
  TUNNEL_NAME_REGEX,
} from "@ai-development-environment/agent-contract";
import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_GIT_INSPECT_JOB_KIND,
  CODEBASE_GIT_OPERATION_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_JOB_KINDS,
  CODEBASE_RECONCILE_EVENT_CAPABILITY,
  CODEBASE_REFRESH_JOB_KIND,
  codebaseBrowsePayload,
  codebaseGitInspectPayload,
  codebaseGitOperationPayload,
  codebaseJobPayload,
} from "@ai-development-environment/agent-contract/codebases";
import {
  WORKTREE_INSPECT_JOB_KIND,
  WORKTREE_BRANCH_JOB_KIND,
  WORKTREE_DELETE_JOB_KIND,
  WORKTREE_JOB_KINDS,
  WORKTREE_MOVE_CHECKOUT_JOB_KIND,
  WORKTREE_MOVE_PUSH_JOB_KIND,
  WORKTREE_OPERATION_JOB_KIND,
  WORKTREE_WATCH_JOB_KIND,
  worktreeJobPayload,
  worktreeBranchJobPayload,
  worktreeDeleteJobPayload,
  worktreeMoveCheckoutJobPayload,
  worktreeMovePushJobPayload,
  worktreeWatchJobPayload,
} from "@ai-development-environment/agent-contract/worktrees";

import { getPrismaClient } from "@/data/prisma-client";

import {
  AGENT_CHANGED_TOPIC,
  agentEventBus,
  agentEventsTopic,
  agentJobChangedTopic,
  agentJobLogTopic,
  ccusageCollectionChangedTopic,
} from "./event-bus";

const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING"];
const FINAL_JOB_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const AGENT_ONLINE_WINDOW_MS = 45_000;
export const SUPPORTED_AGENT_JOBS = [
  "cloudflared.runTunnel",
  CCUSAGE_REPORT_JOB_KIND,
  ...CODEBASE_JOB_KINDS,
  ...WORKTREE_JOB_KINDS,
] as const;

type CompletionHandler = (job: {
  id: string;
  agentId: string;
  codebaseId: string | null;
  worktreeId: string | null;
  kind: string;
  payloadJson: string;
  status: string;
  resultJson: string | null;
  error: string | null;
}) => Promise<void>;

export type RequestIdentity = {
  agentId: string | null;
  ipAddress: string | null;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Job payload must be an object");
  }
  return payload as Record<string, unknown>;
}

function agentCapabilities(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function validateJob(kind: string, payload: unknown): void {
  const value = parsePayload(payload);
  if (kind === CODEBASE_BROWSE_JOB_KIND) {
    codebaseBrowsePayload(value);
    return;
  }
  if (
    kind === CODEBASE_INSPECT_JOB_KIND ||
    kind === CODEBASE_REFRESH_JOB_KIND ||
    kind === CODEBASE_FETCH_JOB_KIND
  ) {
    codebaseJobPayload(value);
    return;
  }
  if (kind === CODEBASE_GIT_INSPECT_JOB_KIND) {
    codebaseGitInspectPayload(value);
    return;
  }
  if (kind === CODEBASE_GIT_OPERATION_JOB_KIND) {
    codebaseGitOperationPayload(value);
    return;
  }
  if (kind === WORKTREE_BRANCH_JOB_KIND) {
    worktreeBranchJobPayload(value);
    return;
  }
  if (kind === WORKTREE_MOVE_PUSH_JOB_KIND) {
    worktreeMovePushJobPayload(value);
    return;
  }
  if (kind === WORKTREE_MOVE_CHECKOUT_JOB_KIND) {
    worktreeMoveCheckoutJobPayload(value);
    return;
  }
  if (kind === WORKTREE_DELETE_JOB_KIND) {
    worktreeDeleteJobPayload(value);
    return;
  }
  if (
    kind === WORKTREE_INSPECT_JOB_KIND ||
    kind === WORKTREE_OPERATION_JOB_KIND
  ) {
    worktreeJobPayload(value);
    return;
  }
  if (kind === WORKTREE_WATCH_JOB_KIND) {
    worktreeWatchJobPayload(value);
    return;
  }
  if (kind === CCUSAGE_REPORT_JOB_KIND) {
    const unexpected = Object.keys(value);
    if (unexpected.length > 0) {
      throw new Error(
        `Unexpected ccusage.report payload field: ${unexpected[0]}`,
      );
    }
    return;
  }
  if (kind !== "cloudflared.runTunnel") {
    throw new Error(`Unsupported agent job kind: ${kind}`);
  }
  if (
    typeof value.tunnelName !== "string" ||
    !TUNNEL_NAME_REGEX.test(value.tunnelName)
  ) {
    throw new Error(
      "cloudflared.runTunnel requires a tunnelName containing only letters, numbers, underscores, or hyphens",
    );
  }
  const unexpected = Object.keys(value).filter((key) => key !== "tunnelName");
  if (unexpected.length > 0) {
    throw new Error(`Unexpected cloudflared payload field: ${unexpected[0]}`);
  }
}

function publishAgent(agent: unknown): void {
  agentEventBus.publish(AGENT_CHANGED_TOPIC, { agentChanged: agent });
}

function publishJob(job: {
  id: string;
  ccusageCollectionId?: string | null;
}): void {
  agentEventBus.publish(agentJobChangedTopic(job.id), { agentJobChanged: job });
  if (job.ccusageCollectionId) {
    agentEventBus.publish(
      ccusageCollectionChangedTopic(job.ccusageCollectionId),
      { ccusageCollectionChanged: { id: job.ccusageCollectionId } },
    );
  }
}

export class AgentControlService {
  private readonly completionHandlers = new Map<string, CompletionHandler>();

  registerCompletionHandler(kind: string, handler: CompletionHandler): void {
    this.completionHandlers.set(kind, handler);
  }

  async requestCodebaseReconcile(agentIds: string[]): Promise<number> {
    const uniqueAgentIds = [...new Set(agentIds.filter(Boolean))];
    if (!uniqueAgentIds.length) return 0;
    const prisma = await getPrismaClient();
    const agents = await prisma.agent.findMany({
      where: { id: { in: uniqueAgentIds } },
      select: { id: true, capabilitiesJson: true },
    });
    const supportedAgents = agents.filter((agent) =>
      agentCapabilities(agent.capabilitiesJson).includes(
        CODEBASE_RECONCILE_EVENT_CAPABILITY,
      ),
    );
    for (const agent of supportedAgents) {
      agentEventBus.publish(agentEventsTopic(agent.id), {
        agentEvents: { type: "CODEBASE_RECONCILE_REQUESTED", job: null },
      });
    }
    return supportedAgents.length;
  }

  private async projectCompletion(job: Parameters<CompletionHandler>[0]) {
    await this.completionHandlers.get(job.kind)?.(job);
  }

  async authenticate(credential: string | null): Promise<string | null> {
    if (!credential) return null;
    const prisma = await getPrismaClient();
    const agent = await prisma.agent.findUnique({
      where: { secretHash: digest(credential) },
      select: { id: true },
    });
    return agent?.id ?? null;
  }

  async createEnrollmentToken(expiresInMinutes = 15) {
    const minutes = Math.max(1, Math.min(expiresInMinutes, 24 * 60));
    const token = `enroll_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    const prisma = await getPrismaClient();
    await prisma.agentEnrollmentToken.create({
      data: { id: randomUUID(), tokenHash: digest(token), expiresAt },
    });
    return { token, expiresAt };
  }

  async enroll(input: {
    enrollmentToken: string;
    name: string;
    hostname: string;
    version: string;
    osVersion: string;
    architecture: string;
    cpuModel?: string | null;
    memoryTotalBytes?: number | null;
    memoryFreeBytes?: number | null;
    diskTotalBytes?: number | null;
    diskFreeBytes?: number | null;
    capabilities: string[];
    ipAddress: string | null;
  }) {
    const prisma = await getPrismaClient();
    const credential = `agent_${randomBytes(32).toString("base64url")}`;
    const now = new Date();
    const agent = await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.agentEnrollmentToken.updateMany({
        where: {
          tokenHash: digest(input.enrollmentToken),
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new Error(
          "Enrollment token is invalid, expired, or already used",
        );
      }
      const created = await transaction.agent.create({
        data: {
          id: randomUUID(),
          name: input.name.trim() || input.hostname,
          hostname: input.hostname,
          version: input.version,
          osVersion: input.osVersion,
          architecture: input.architecture,
          cpuModel: input.cpuModel,
          memoryTotalBytes: input.memoryTotalBytes,
          memoryFreeBytes: input.memoryFreeBytes,
          diskTotalBytes: input.diskTotalBytes,
          diskFreeBytes: input.diskFreeBytes,
          capabilitiesJson: JSON.stringify(input.capabilities),
          secretHash: digest(credential),
          ipAddress: input.ipAddress,
          lastSeenAt: now,
        },
      });
      await transaction.agentAuditEvent.create({
        data: {
          id: randomUUID(),
          agentId: created.id,
          action: "agent.enrolled",
          ipAddress: input.ipAddress,
        },
      });
      return created;
    });
    publishAgent(agent);
    return { agent, credential };
  }

  async heartbeat(
    agentId: string,
    input: {
      version: string;
      osVersion: string;
      architecture: string;
      cpuModel?: string | null;
      memoryTotalBytes?: number | null;
      memoryFreeBytes?: number | null;
      diskTotalBytes?: number | null;
      diskFreeBytes?: number | null;
      capabilities: string[];
      ipAddress: string | null;
    },
  ) {
    const prisma = await getPrismaClient();
    const agent = await prisma.agent.update({
      where: { id: agentId },
      data: {
        version: input.version,
        osVersion: input.osVersion,
        architecture: input.architecture,
        cpuModel: input.cpuModel ?? undefined,
        memoryTotalBytes: input.memoryTotalBytes ?? undefined,
        memoryFreeBytes: input.memoryFreeBytes ?? undefined,
        diskTotalBytes: input.diskTotalBytes ?? undefined,
        diskFreeBytes: input.diskFreeBytes ?? undefined,
        capabilitiesJson: JSON.stringify(input.capabilities),
        ipAddress: input.ipAddress ?? undefined,
        lastSeenAt: new Date(),
        disconnectedAt: null,
      },
    });
    publishAgent(agent);
    return agent;
  }

  async listAgents() {
    const prisma = await getPrismaClient();
    return prisma.agent.findMany({ orderBy: { createdAt: "desc" } });
  }

  async getAgent(id: string) {
    const prisma = await getPrismaClient();
    return prisma.agent.findUnique({ where: { id } });
  }

  async updateBaseRepoDirectory(
    agentId: string,
    baseRepoDirectory: string | null,
  ) {
    if (
      baseRepoDirectory !== null &&
      (!baseRepoDirectory ||
        baseRepoDirectory.length > 4_096 ||
        baseRepoDirectory.includes("\0") ||
        (!posix.isAbsolute(baseRepoDirectory) &&
          !win32.isAbsolute(baseRepoDirectory)))
    ) {
      throw new Error("Base repository directory must be an absolute path");
    }
    const prisma = await getPrismaClient();
    const agent = await prisma.agent.update({
      where: { id: agentId },
      data: { baseRepoDirectory },
    });
    publishAgent(agent);
    return agent;
  }

  async listJobs(agentId: string, limit = 50, includeSystem = false) {
    const prisma = await getPrismaClient();
    return prisma.agentJob.findMany({
      where: { agentId, ...(includeSystem ? {} : { visibility: "USER" }) },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(limit, 200)),
    });
  }

  async getJob(id: string) {
    const prisma = await getPrismaClient();
    return prisma.agentJob.findUnique({ where: { id } });
  }

  async createJob(input: {
    agentId: string;
    kind: string;
    payload: unknown;
    idempotencyKey: string;
    timeoutSeconds?: number | null;
    ccusageCollectionId?: string | null;
    codebaseId?: string | null;
    worktreeId?: string | null;
    visibility?: "USER" | "SYSTEM";
  }) {
    validateJob(input.kind, input.payload);
    if (!input.idempotencyKey.trim())
      throw new Error("idempotencyKey is required");
    const timeoutSeconds = Math.max(
      10,
      Math.min(input.timeoutSeconds ?? 86_400, 7 * 86_400),
    );
    const prisma = await getPrismaClient();
    const existing = await prisma.agentJob.findUnique({
      where: {
        agentId_idempotencyKey: {
          agentId: input.agentId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        input.ccusageCollectionId &&
        existing.ccusageCollectionId !== input.ccusageCollectionId
      ) {
        const attached = await prisma.agentJob.update({
          where: { id: existing.id },
          data: { ccusageCollectionId: input.ccusageCollectionId },
        });
        publishJob(attached);
        return attached;
      }
      return existing;
    }
    let job;
    try {
      job = await prisma.agentJob.create({
        data: {
          id: randomUUID(),
          agentId: input.agentId,
          kind: input.kind,
          payloadJson: JSON.stringify(input.payload),
          status: "QUEUED",
          idempotencyKey: input.idempotencyKey,
          timeoutSeconds,
          ccusageCollectionId: input.ccusageCollectionId ?? null,
          codebaseId: input.codebaseId ?? null,
          worktreeId: input.worktreeId ?? null,
          visibility: input.visibility ?? "USER",
        },
      });
    } catch (error) {
      const concurrent = await prisma.agentJob.findUnique({
        where: {
          agentId_idempotencyKey: {
            agentId: input.agentId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (!concurrent) throw error;
      if (
        input.ccusageCollectionId &&
        concurrent.ccusageCollectionId !== input.ccusageCollectionId
      ) {
        return prisma.agentJob.update({
          where: { id: concurrent.id },
          data: { ccusageCollectionId: input.ccusageCollectionId },
        });
      }
      return concurrent;
    }
    await prisma.agentAuditEvent.create({
      data: {
        id: randomUUID(),
        agentId: input.agentId,
        action: "job.created",
        details: JSON.stringify({ jobId: job.id, kind: job.kind }),
      },
    });
    publishJob(job);
    agentEventBus.publish(agentEventsTopic(input.agentId), {
      agentEvents: { type: "JOB_AVAILABLE", job },
    });
    return job;
  }

  async claimJob(agentId: string, jobId: string) {
    const prisma = await getPrismaClient();
    const claimed = await prisma.agentJob.updateMany({
      where: { id: jobId, agentId, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!job || job.agentId !== agentId)
      throw new Error("Job not found for this agent");
    if (claimed.count !== 1 && job.status !== "RUNNING") {
      throw new Error(`Job cannot be claimed from status ${job.status}`);
    }
    publishJob(job);
    return job;
  }

  async appendLogs(
    agentId: string,
    jobId: string,
    logs: Array<{
      sequence: number;
      stream: string;
      message: string;
      createdAt: string;
    }>,
  ) {
    const prisma = await getPrismaClient();
    const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!job || job.agentId !== agentId)
      throw new Error("Job not found for this agent");
    const normalized = logs.slice(0, 200).map((log) => ({
      id: randomUUID(),
      jobId,
      sequence: log.sequence,
      stream: log.stream,
      message: log.message.slice(0, 64_000),
      createdAt: new Date(log.createdAt),
    }));
    if (normalized.some((log) => Number.isNaN(log.createdAt.valueOf()))) {
      throw new Error("Log createdAt must be an ISO date");
    }
    await Promise.all(
      normalized.map((log) =>
        prisma.agentJobLog.upsert({
          where: { jobId_sequence: { jobId, sequence: log.sequence } },
          create: log,
          update: {},
        }),
      ),
    );
    const persisted = await prisma.agentJobLog.findMany({
      where: { jobId, sequence: { in: normalized.map((log) => log.sequence) } },
      orderBy: { sequence: "asc" },
    });
    for (const log of persisted) {
      agentEventBus.publish(agentJobLogTopic(jobId), { agentJobLogAdded: log });
    }
    return persisted;
  }

  async completeJob(
    agentId: string,
    jobId: string,
    status: string,
    result: unknown,
    error: string | null,
  ) {
    if (!FINAL_JOB_STATUSES.has(status))
      throw new Error("A final job status is required");
    const prisma = await getPrismaClient();
    const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!job || job.agentId !== agentId)
      throw new Error("Job not found for this agent");
    if (FINAL_JOB_STATUSES.has(job.status)) {
      await this.projectCompletion(job);
      return job;
    }
    const completed = await prisma.agentJob.updateMany({
      where: { id: jobId, agentId, status: { in: ACTIVE_JOB_STATUSES } },
      data: {
        status,
        resultJson:
          result === undefined || result === null
            ? null
            : JSON.stringify(result),
        error,
        finishedAt: new Date(),
      },
    });
    const updated = await prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!updated || updated.agentId !== agentId) {
      throw new Error("Job not found for this agent");
    }
    if (completed.count !== 1) {
      if (FINAL_JOB_STATUSES.has(updated.status)) {
        await this.projectCompletion(updated);
        return updated;
      }
      throw new Error(`Job cannot be completed from status ${updated.status}`);
    }
    await this.projectCompletion(updated);
    publishJob(updated);
    return updated;
  }

  async cancelJob(jobId: string) {
    const prisma = await getPrismaClient();
    const job = await prisma.agentJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error("Job not found");
    if (!ACTIVE_JOB_STATUSES.includes(job.status)) return job;
    const updated = await prisma.agentJob.update({
      where: { id: jobId },
      data: { status: "CANCELLED", finishedAt: new Date() },
    });
    publishJob(updated);
    agentEventBus.publish(agentEventsTopic(job.agentId), {
      agentEvents: { type: "JOB_CANCEL_REQUESTED", job: updated },
    });
    return updated;
  }

  async timeoutCollectionJobs(collectionId: string) {
    const prisma = await getPrismaClient();
    const jobs = await prisma.agentJob.findMany({
      where: {
        ccusageCollectionId: collectionId,
        status: { in: ACTIVE_JOB_STATUSES },
      },
    });
    const timedOut = [];
    for (const job of jobs) {
      const changed = await prisma.agentJob.updateMany({
        where: { id: job.id, status: { in: ACTIVE_JOB_STATUSES } },
        data: { status: "TIMED_OUT", finishedAt: new Date() },
      });
      if (changed.count !== 1) continue;
      const updated = await prisma.agentJob.findUnique({
        where: { id: job.id },
      });
      if (!updated) continue;
      timedOut.push(updated);
      publishJob(updated);
      agentEventBus.publish(agentEventsTopic(updated.agentId), {
        agentEvents: { type: "JOB_CANCEL_REQUESTED", job: updated },
      });
    }
    return timedOut;
  }

  async listLogs(jobId: string, afterSequence = -1) {
    const prisma = await getPrismaClient();
    return prisma.agentJobLog.findMany({
      where: { jobId, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take: 5_000,
    });
  }
}
