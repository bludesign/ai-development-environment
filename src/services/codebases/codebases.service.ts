import { randomUUID } from "node:crypto";

import {
  CODEBASE_BROWSE_JOB_KIND,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_REFRESH_JOB_KIND,
  parseCodebaseDirectoryListing,
  parseCodebaseSnapshot,
  type CodebaseSnapshot,
  type CodebaseStatusReport,
} from "@ai-development-environment/agent-contract/codebases";

import { getPrismaClient } from "@/data/prisma-client";
import {
  AGENT_ONLINE_WINDOW_MS,
  AgentControlService,
  CODEBASE_CHANGED_TOPIC,
  agentEventBus,
  agentJobChangedTopic,
} from "@/services/agent-control";

const INSPECTION_MAX_AGE_MS = 15 * 60_000;
const INTERACTIVE_TIMEOUT_MS = 30_000;

type CompletedJob = {
  id: string;
  agentId: string;
  codebaseId: string | null;
  kind: string;
  status: string;
  resultJson: string | null;
  error: string | null;
};

function resultObject(job: CompletedJob): Record<string, unknown> {
  if (job.status !== "SUCCEEDED" || !job.resultJson) {
    throw new Error(job.error || `${job.kind} failed`);
  }
  const value: unknown = JSON.parse(job.resultJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${job.kind} returned an invalid result`);
  }
  return value as Record<string, unknown>;
}

function capabilities(agent: { capabilitiesJson: string }): string[] {
  try {
    const value: unknown = JSON.parse(agent.capabilitiesJson);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function online(agent: {
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
}): boolean {
  return (
    agent.lastSeenAt !== null &&
    Date.now() - agent.lastSeenAt.getTime() <= AGENT_ONLINE_WINDOW_MS &&
    agent.disconnectedAt === null
  );
}

export class CodebasesService {
  constructor(private readonly agentControl: AgentControlService) {
    for (const kind of [CODEBASE_REFRESH_JOB_KIND, CODEBASE_FETCH_JOB_KIND]) {
      this.agentControl.registerCompletionHandler(kind, (job) =>
        this.projectJob(job),
      );
    }
  }

  async overview() {
    await this.cleanupInternalJobs();
    const prisma = await getPrismaClient();
    return prisma.codebaseRepository.findMany({
      orderBy: [{ name: "asc" }, { canonicalOrigin: "asc" }],
      include: {
        codebases: {
          orderBy: { folder: "asc" },
          include: {
            agent: true,
            repository: true,
            jobs: {
              where: { status: { in: ["QUEUED", "RUNNING"] } },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });
  }

  async agentCodebases(agentId: string) {
    const prisma = await getPrismaClient();
    return prisma.codebase.findMany({
      where: { agentId },
      orderBy: { folder: "asc" },
      select: {
        id: true,
        folder: true,
        repository: { select: { canonicalOrigin: true } },
      },
    });
  }

  async browse(agentId: string, path: string | null, requestId: string) {
    await this.cleanupInternalJobs();
    await this.requireAgentCapability(agentId, CODEBASE_BROWSE_JOB_KIND);
    const job = await this.agentControl.createJob({
      agentId,
      kind: CODEBASE_BROWSE_JOB_KIND,
      payload: { path },
      idempotencyKey: `codebase:browse:${requestId}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    const completed = await this.waitForJob(job.id);
    const listing = parseCodebaseDirectoryListing(
      resultObject(completed).listing,
    );
    const prisma = await getPrismaClient();
    await prisma.agentJob.deleteMany({ where: { id: job.id } });
    return listing;
  }

  async inspect(agentId: string, folder: string, requestId: string) {
    await this.cleanupInternalJobs();
    await this.requireAgentCapability(agentId, CODEBASE_INSPECT_JOB_KIND);
    const job = await this.agentControl.createJob({
      agentId,
      kind: CODEBASE_INSPECT_JOB_KIND,
      payload: { folder },
      idempotencyKey: `codebase:inspect:${requestId}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    const completed = await this.waitForJob(job.id);
    const snapshot = parseCodebaseSnapshot(resultObject(completed).snapshot);
    if (snapshot.availability !== "AVAILABLE") {
      throw new Error(snapshot.error || "The selected folder is unavailable");
    }
    if (snapshot.linkedWorktree) {
      throw new Error("Linked Git worktrees are not supported yet");
    }
    if (!snapshot.canonicalOrigin) throw new Error("Git origin is required");
    const prisma = await getPrismaClient();
    const repository = await prisma.codebaseRepository.findUnique({
      where: { canonicalOrigin: snapshot.canonicalOrigin },
    });
    return { jobId: job.id, snapshot, repository };
  }

  async confirm(input: {
    inspectionJobId: string;
    name?: string | null;
    description?: string | null;
  }) {
    const prisma = await getPrismaClient();
    const job = await prisma.agentJob.findUnique({
      where: { id: input.inspectionJobId },
    });
    if (!job || job.kind !== CODEBASE_INSPECT_JOB_KIND) {
      throw new Error("Codebase inspection was not found");
    }
    if (
      !job.finishedAt ||
      Date.now() - job.finishedAt.getTime() > INSPECTION_MAX_AGE_MS
    ) {
      throw new Error("Codebase inspection expired; inspect the folder again");
    }
    const snapshot = parseCodebaseSnapshot(resultObject(job).snapshot);
    if (
      snapshot.availability !== "AVAILABLE" ||
      snapshot.linkedWorktree ||
      !snapshot.canonicalOrigin ||
      !snapshot.displayOrigin ||
      !snapshot.observedOrigin
    ) {
      throw new Error("Codebase inspection is not eligible for confirmation");
    }
    const name = input.name?.trim() ?? "";
    const description = input.description?.trim() ?? "";
    if (name.length > 120)
      throw new Error("Name must be 120 characters or fewer");
    if (description.length > 2_000) {
      throw new Error("Description must be 2,000 characters or fewer");
    }

    const confirmed = await prisma.$transaction(async (transaction) => {
      let repository = await transaction.codebaseRepository.findUnique({
        where: { canonicalOrigin: snapshot.canonicalOrigin! },
      });
      if (!repository) {
        if (!name) throw new Error("Name is required for a new repository");
        repository = await transaction.codebaseRepository.upsert({
          where: { canonicalOrigin: snapshot.canonicalOrigin! },
          create: {
            id: randomUUID(),
            canonicalOrigin: snapshot.canonicalOrigin!,
            displayOrigin: snapshot.displayOrigin!,
            name,
            description,
          },
          update: {},
        });
      }
      const existing = await transaction.codebase.findUnique({
        where: {
          agentId_folder: { agentId: job.agentId, folder: snapshot.folder },
        },
        select: { lastFetchedAt: true },
      });
      const inspectedFetchedAt = snapshot.fetchedAt
        ? new Date(snapshot.fetchedAt)
        : null;
      const fetchedAt =
        inspectedFetchedAt &&
        (!existing?.lastFetchedAt ||
          inspectedFetchedAt > existing.lastFetchedAt)
          ? inspectedFetchedAt
          : (existing?.lastFetchedAt ?? null);
      return transaction.codebase.upsert({
        where: {
          agentId_folder: { agentId: job.agentId, folder: snapshot.folder },
        },
        create: {
          id: randomUUID(),
          agentId: job.agentId,
          repositoryId: repository.id,
          ...this.snapshotData(snapshot, fetchedAt),
        },
        update: {
          repositoryId: repository.id,
          ...this.snapshotData(snapshot, fetchedAt),
        },
        include: { agent: true, repository: true, jobs: true },
      });
    });
    this.publish(confirmed.id, confirmed.repositoryId);
    await prisma.agentJob.deleteMany({
      where: { id: input.inspectionJobId, visibility: "SYSTEM" },
    });
    return confirmed;
  }

  async updateRepository(
    id: string,
    nameValue: string,
    descriptionValue: string,
  ) {
    const name = nameValue.trim();
    const description = descriptionValue.trim();
    if (!name) throw new Error("Name is required");
    if (name.length > 120)
      throw new Error("Name must be 120 characters or fewer");
    if (description.length > 2_000) {
      throw new Error("Description must be 2,000 characters or fewer");
    }
    const prisma = await getPrismaClient();
    const repository = await prisma.codebaseRepository.update({
      where: { id },
      data: { name, description },
    });
    this.publish(null, id);
    return repository;
  }

  async report(agentId: string, reports: CodebaseStatusReport[]) {
    const updated = [];
    for (const report of reports.slice(0, 500)) {
      const snapshot = parseCodebaseSnapshot(report.snapshot);
      updated.push(
        await this.applySnapshot(agentId, report.codebaseId, snapshot),
      );
    }
    return updated;
  }

  async runOperation(
    kind: typeof CODEBASE_REFRESH_JOB_KIND | typeof CODEBASE_FETCH_JOB_KIND,
    codebaseIds: string[],
    requestId: string,
  ) {
    if (!requestId.trim()) throw new Error("requestId is required");
    const prisma = await getPrismaClient();
    const codebases = await prisma.codebase.findMany({
      where: { id: { in: [...new Set(codebaseIds)].slice(0, 500) } },
      include: { agent: true, repository: true },
    });
    const jobs = [];
    const skipped: Array<{ codebaseId: string; reason: string }> = [];
    for (const codebase of codebases) {
      if (!online(codebase.agent)) {
        skipped.push({ codebaseId: codebase.id, reason: "OFFLINE" });
        continue;
      }
      if (!capabilities(codebase.agent).includes(kind)) {
        skipped.push({ codebaseId: codebase.id, reason: "UNSUPPORTED" });
        continue;
      }
      if (
        kind === CODEBASE_FETCH_JOB_KIND &&
        codebase.availability !== "AVAILABLE"
      ) {
        skipped.push({
          codebaseId: codebase.id,
          reason: codebase.availability,
        });
        continue;
      }
      jobs.push(
        await this.agentControl.createJob({
          agentId: codebase.agentId,
          codebaseId: codebase.id,
          kind,
          payload: {
            codebaseId: codebase.id,
            folder: codebase.folder,
            expectedOrigin: codebase.repository.canonicalOrigin,
          },
          idempotencyKey: `codebase:${kind}:${requestId}:${codebase.id}`,
          timeoutSeconds: kind === CODEBASE_FETCH_JOB_KIND ? 300 : 30,
        }),
      );
    }
    return { jobs, skipped };
  }

  subscribe() {
    return agentEventBus.iterate(CODEBASE_CHANGED_TOPIC);
  }

  private async projectJob(job: CompletedJob) {
    if (!job.codebaseId || !job.resultJson) return;
    const result: unknown = JSON.parse(job.resultJson);
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    const snapshotValue = (result as Record<string, unknown>).snapshot;
    if (!snapshotValue) return;
    await this.applySnapshot(
      job.agentId,
      job.codebaseId,
      parseCodebaseSnapshot(snapshotValue),
    );
  }

  private async applySnapshot(
    agentId: string,
    codebaseId: string,
    snapshot: CodebaseSnapshot,
  ) {
    const prisma = await getPrismaClient();
    const current = await prisma.codebase.findUnique({
      where: { id: codebaseId },
      include: { repository: true },
    });
    if (!current || current.agentId !== agentId) {
      throw new Error("Codebase not found for this agent");
    }
    const mismatch =
      snapshot.canonicalOrigin !== null &&
      snapshot.canonicalOrigin !== current.repository.canonicalOrigin;
    const incomingFetched = snapshot.fetchedAt
      ? new Date(snapshot.fetchedAt)
      : null;
    const fetchedAt =
      incomingFetched &&
      (!current.lastFetchedAt || incomingFetched > current.lastFetchedAt)
        ? incomingFetched
        : current.lastFetchedAt;
    const updated = await prisma.codebase.update({
      where: { id: codebaseId },
      data: {
        ...this.snapshotData(snapshot, fetchedAt),
        observedOrigin: snapshot.observedOrigin ?? current.observedOrigin,
        availability: mismatch ? "ORIGIN_MISMATCH" : snapshot.availability,
        statusError: mismatch
          ? `Origin changed to ${snapshot.displayOrigin ?? "an unknown remote"}`
          : snapshot.error,
      },
      include: { agent: true, repository: true, jobs: true },
    });
    this.publish(updated.id, updated.repositoryId);
    return updated;
  }

  private snapshotData(snapshot: CodebaseSnapshot, fetchedAt: Date | null) {
    return {
      folder: snapshot.folder,
      observedOrigin: snapshot.observedOrigin ?? "",
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      upstream: snapshot.upstream,
      ahead: snapshot.ahead,
      behind: snapshot.behind,
      syncState: snapshot.syncState,
      availability: snapshot.availability,
      statusError: snapshot.error,
      lastCheckedAt: new Date(snapshot.checkedAt),
      lastFetchedAt: fetchedAt,
    };
  }

  private async requireAgentCapability(agentId: string, capability: string) {
    const agent = await this.agentControl.getAgent(agentId);
    if (!agent) throw new Error("Agent not found");
    if (!online(agent)) throw new Error("Agent is offline");
    if (!capabilities(agent).includes(capability)) {
      throw new Error("Agent must be updated to use codebases");
    }
  }

  private async waitForJob(jobId: string): Promise<CompletedJob> {
    const events = agentEventBus.iterate(agentJobChangedTopic(jobId));
    const deadline = Date.now() + INTERACTIVE_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const job = (await this.agentControl.getJob(
          jobId,
        )) as CompletedJob | null;
        if (!job) throw new Error("Agent job disappeared");
        if (
          ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(job.status)
        ) {
          return job;
        }
        await Promise.race([
          events.next(),
          new Promise((resolve) => setTimeout(resolve, deadline - Date.now())),
        ]);
      }
      await this.agentControl.cancelJob(jobId);
      throw new Error("Agent did not respond in time");
    } finally {
      await events.return?.();
    }
  }

  private publish(codebaseId: string | null, repositoryId: string) {
    agentEventBus.publish(CODEBASE_CHANGED_TOPIC, {
      codebaseOverviewChanged: { codebaseId, repositoryId },
    });
  }

  private async cleanupInternalJobs() {
    const prisma = await getPrismaClient();
    await prisma.agentJob.deleteMany({
      where: {
        visibility: "SYSTEM",
        finishedAt: { lt: new Date(Date.now() - INSPECTION_MAX_AGE_MS) },
      },
    });
  }
}
