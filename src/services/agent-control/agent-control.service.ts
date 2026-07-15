import { createHash, randomBytes, randomUUID } from "node:crypto";

import { TUNNEL_NAME_REGEX } from "@ai-development-environment/agent-contract";

import { getPrismaClient } from "@/data/prisma-client";

import {
  AGENT_CHANGED_TOPIC,
  agentEventBus,
  agentEventsTopic,
  agentJobChangedTopic,
  agentJobLogTopic,
} from "./event-bus";

const ACTIVE_JOB_STATUSES = ["QUEUED", "RUNNING"];
const FINAL_JOB_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export const AGENT_ONLINE_WINDOW_MS = 45_000;
export const SUPPORTED_AGENT_JOBS = ["cloudflared.runTunnel"] as const;

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

function validateJob(kind: string, payload: unknown): void {
  if (kind !== "cloudflared.runTunnel") {
    throw new Error(`Unsupported agent job kind: ${kind}`);
  }
  const value = parsePayload(payload);
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

function publishJob(job: { id: string }): void {
  agentEventBus.publish(agentJobChangedTopic(job.id), { agentJobChanged: job });
}

export class AgentControlService {
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

  async listJobs(agentId: string, limit = 50) {
    const prisma = await getPrismaClient();
    return prisma.agentJob.findMany({
      where: { agentId },
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
    if (existing) return existing;
    const job = await prisma.agentJob.create({
      data: {
        id: randomUUID(),
        agentId: input.agentId,
        kind: input.kind,
        payloadJson: JSON.stringify(input.payload),
        status: "QUEUED",
        idempotencyKey: input.idempotencyKey,
        timeoutSeconds,
      },
    });
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
    if (FINAL_JOB_STATUSES.has(job.status)) return job;
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
      if (FINAL_JOB_STATUSES.has(updated.status)) return updated;
      throw new Error(`Job cannot be completed from status ${updated.status}`);
    }
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

  async listLogs(jobId: string, afterSequence = -1) {
    const prisma = await getPrismaClient();
    return prisma.agentJobLog.findMany({
      where: { jobId, sequence: { gt: afterSequence } },
      orderBy: { sequence: "asc" },
      take: 5_000,
    });
  }
}
