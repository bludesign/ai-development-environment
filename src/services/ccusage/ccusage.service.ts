import { randomUUID } from "node:crypto";

import {
  CCUSAGE_REPORT_JOB_KIND,
  parseCcusageJobResult,
  type CcusageReport,
} from "@ai-development-environment/agent-contract";

import {
  aggregateUsage,
  type AggregatedUsage,
  type UsageReportSource,
} from "@/components/usage/aggregate-usage";
import { getPrismaClient } from "@/data/prisma-client";
import {
  AGENT_ONLINE_WINDOW_MS,
  AgentControlService,
  agentEventBus,
  ccusageCollectionChangedTopic,
} from "@/services/agent-control";

export const CCUSAGE_JOB_TIMEOUT_SECONDS = 120;
export const CCUSAGE_COLLECTION_DEADLINE_MS = 150_000;

const JOB_TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
]);

export type CcusageCollectionStatus = "COLLECTING" | "COMPLETED";
export type CcusageAgentStatus =
  | "QUEUING"
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "OFFLINE"
  | "UNSUPPORTED"
  | "INVALID";

type PersistedAgent = {
  id: string;
  name: string;
  hostname: string;
  version: string;
  osVersion: string;
  architecture: string;
  capabilitiesJson: string;
  secretHash: string;
  ipAddress: string | null;
  lastSeenAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PersistedJob = {
  id: string;
  agentId: string;
  status: string;
  resultJson: string | null;
  error: string | null;
};

type PersistedCollectionAgent = {
  agentId: string;
  initialStatus: string;
  error: string | null;
  agent: PersistedAgent;
};

type PersistedCollection = {
  id: string;
  deadlineAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  agents: PersistedCollectionAgent[];
  jobs: PersistedJob[];
};

export type CcusageAgentProgress = {
  agent: PersistedAgent;
  status: CcusageAgentStatus;
  jobId: string | null;
  error: string | null;
};

export type CcusageCollectionSnapshot = {
  id: string;
  status: CcusageCollectionStatus;
  createdAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  progress: {
    eligibleCount: number;
    finishedCount: number;
    successfulCount: number;
    agents: CcusageAgentProgress[];
  };
  aggregate: AggregatedUsage;
};

function isOnline(agent: PersistedAgent, now: number): boolean {
  return (
    agent.lastSeenAt !== null &&
    now - agent.lastSeenAt.getTime() <= AGENT_ONLINE_WINDOW_MS &&
    agent.disconnectedAt === null
  );
}

function capabilities(agent: PersistedAgent): string[] {
  try {
    const parsed: unknown = JSON.parse(agent.capabilitiesJson);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function initialStatus(agent: PersistedAgent, now: number): CcusageAgentStatus {
  if (!isOnline(agent, now)) return "OFFLINE";
  if (!capabilities(agent).includes(CCUSAGE_REPORT_JOB_KIND)) {
    return "UNSUPPORTED";
  }
  return "QUEUING";
}

function progressFor(
  member: PersistedCollectionAgent,
  job: PersistedJob | undefined,
): { progress: CcusageAgentProgress; report?: CcusageReport } {
  const base = {
    agent: member.agent,
    jobId: job?.id ?? null,
  };
  if (member.initialStatus !== "QUEUING") {
    return {
      progress: {
        ...base,
        status: member.initialStatus as CcusageAgentStatus,
        error: member.error,
      },
    };
  }
  if (!job) {
    return {
      progress: {
        ...base,
        status: "QUEUING",
        error: member.error,
      },
    };
  }
  if (job.status !== "SUCCEEDED") {
    return {
      progress: {
        ...base,
        status: job.status as CcusageAgentStatus,
        error: job.error,
      },
    };
  }
  try {
    const result = parseCcusageJobResult(
      job.resultJson === null ? null : JSON.parse(job.resultJson),
    );
    return {
      progress: {
        ...base,
        status: "SUCCEEDED",
        error: null,
      },
      report: result.report,
    };
  } catch (error) {
    return {
      progress: {
        ...base,
        status: "INVALID",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export class CcusageService {
  private readonly deadlineTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    private readonly agentControlService: AgentControlService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializationPromise) {
      this.initializationPromise = this.restoreCollections()
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.initializationPromise = null;
        });
    }
    return this.initializationPromise;
  }

  private async restoreCollections(): Promise<void> {
    const prisma = await getPrismaClient();
    const active = await prisma.ccusageCollection.findMany({
      where: { finishedAt: null },
      select: { id: true },
    });
    await Promise.all(
      active.map(async ({ id }) => {
        await this.ensureJobs(id);
        await this.getCollection(id);
      }),
    );
  }

  async collect(requestId?: string | null): Promise<CcusageCollectionSnapshot> {
    const id = requestId?.trim() || randomUUID();
    await this.ensureCollection(id);
    return this.waitForCompletion(id);
  }

  async getCollection(id: string): Promise<CcusageCollectionSnapshot | null> {
    let collection = await this.loadCollection(id);
    if (!collection) return null;

    if (
      collection.finishedAt === null &&
      collection.deadlineAt.getTime() <= this.now().getTime()
    ) {
      await this.timeoutMembersWithoutJobs(collection);
      await this.agentControlService.timeoutCollectionJobs(id);
      collection = (await this.loadCollection(id)) ?? collection;
    }

    const snapshot = this.snapshot(collection);
    if (snapshot.status === "COMPLETED" && collection.finishedAt === null) {
      const finishedAt = this.now();
      const prisma = await getPrismaClient();
      await prisma.ccusageCollection.updateMany({
        where: { id, finishedAt: null },
        data: { finishedAt },
      });
      snapshot.finishedAt = finishedAt.toISOString();
      this.clearDeadline(id);
    } else if (snapshot.status === "COLLECTING") {
      this.scheduleDeadline(collection);
    }
    return snapshot;
  }

  async *subscribe(
    id: string,
  ): AsyncIterableIterator<CcusageCollectionSnapshot> {
    const events = agentEventBus.iterate(ccusageCollectionChangedTopic(id));
    try {
      const current = await this.getCollection(id);
      if (current) yield current;
      while (true) {
        const event = await events.next();
        if (event.done) return;
        const snapshot = await this.getCollection(id);
        if (snapshot) yield snapshot;
      }
    } finally {
      await events.return?.();
    }
  }

  private async ensureCollection(id: string): Promise<void> {
    const prisma = await getPrismaClient();
    let collection = await prisma.ccusageCollection.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!collection) {
      const agents =
        (await this.agentControlService.listAgents()) as PersistedAgent[];
      try {
        collection = await prisma.ccusageCollection.create({
          data: {
            id,
            deadlineAt: new Date(
              this.now().getTime() + CCUSAGE_COLLECTION_DEADLINE_MS,
            ),
            agents: {
              create: agents.map((agent) => ({
                agentId: agent.id,
                initialStatus: initialStatus(agent, this.now().getTime()),
              })),
            },
          },
          select: { id: true },
        });
        this.publish(id);
      } catch (error) {
        collection = await prisma.ccusageCollection.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!collection) throw error;
      }
    }

    await this.ensureJobs(id);
    const snapshot = await this.getCollection(id);
    if (snapshot?.status === "COLLECTING") {
      const persisted = await prisma.ccusageCollection.findUnique({
        where: { id },
        select: { id: true, deadlineAt: true, finishedAt: true },
      });
      if (persisted) this.scheduleDeadline(persisted);
    }
  }

  private async ensureJobs(collectionId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const collection = await prisma.ccusageCollection.findUnique({
      where: { id: collectionId },
      select: { deadlineAt: true, finishedAt: true },
    });
    if (
      !collection ||
      collection.finishedAt ||
      collection.deadlineAt.getTime() <= this.now().getTime()
    ) {
      return;
    }
    const members = await prisma.ccusageCollectionAgent.findMany({
      where: { collectionId, initialStatus: "QUEUING" },
      select: { agentId: true },
    });
    const jobs = await prisma.agentJob.findMany({
      where: { ccusageCollectionId: collectionId },
      select: { agentId: true },
    });
    const agentsWithJobs = new Set(jobs.map(({ agentId }) => agentId));
    await Promise.all(
      members
        .filter(({ agentId }) => !agentsWithJobs.has(agentId))
        .map(async ({ agentId }) => {
          try {
            await this.agentControlService.createJob({
              agentId,
              kind: CCUSAGE_REPORT_JOB_KIND,
              payload: {},
              idempotencyKey: `ccusage:${collectionId}`,
              timeoutSeconds: CCUSAGE_JOB_TIMEOUT_SECONDS,
              ccusageCollectionId: collectionId,
            });
          } catch (error) {
            await prisma.ccusageCollectionAgent.update({
              where: { collectionId_agentId: { collectionId, agentId } },
              data: {
                initialStatus: "FAILED",
                error: error instanceof Error ? error.message : String(error),
              },
            });
            this.publish(collectionId);
          }
        }),
    );
  }

  private async waitForCompletion(
    id: string,
  ): Promise<CcusageCollectionSnapshot> {
    const events = agentEventBus.iterate(ccusageCollectionChangedTopic(id));
    try {
      while (true) {
        const snapshot = await this.getCollection(id);
        if (!snapshot) throw new Error("ccusage collection disappeared");
        if (snapshot.status === "COMPLETED") return snapshot;
        const remaining = Math.max(
          1,
          new Date(snapshot.deadlineAt).getTime() - this.now().getTime() + 25,
        );
        await Promise.race([
          events.next(),
          new Promise((resolve) => setTimeout(resolve, remaining)),
        ]);
      }
    } finally {
      await events.return?.();
    }
  }

  private async loadCollection(
    id: string,
  ): Promise<PersistedCollection | null> {
    const prisma = await getPrismaClient();
    return prisma.ccusageCollection.findUnique({
      where: { id },
      include: {
        agents: { include: { agent: true } },
        jobs: true,
      },
    }) as Promise<PersistedCollection | null>;
  }

  private async timeoutMembersWithoutJobs(
    collection: PersistedCollection,
  ): Promise<void> {
    const agentsWithJobs = new Set(
      collection.jobs.map(({ agentId }) => agentId),
    );
    const agentIds = collection.agents
      .filter(
        ({ agentId, initialStatus }) =>
          initialStatus === "QUEUING" && !agentsWithJobs.has(agentId),
      )
      .map(({ agentId }) => agentId);
    if (agentIds.length === 0) return;

    const prisma = await getPrismaClient();
    const updated = await prisma.ccusageCollectionAgent.updateMany({
      where: {
        collectionId: collection.id,
        agentId: { in: agentIds },
        initialStatus: "QUEUING",
      },
      data: { initialStatus: "TIMED_OUT" },
    });
    if (updated.count > 0) this.publish(collection.id);
  }

  private snapshot(collection: PersistedCollection): CcusageCollectionSnapshot {
    const jobs = new Map(collection.jobs.map((job) => [job.agentId, job]));
    const progressAndReports = collection.agents.map((member) =>
      progressFor(member, jobs.get(member.agentId)),
    );
    const agents = progressAndReports.map(({ progress }) => progress);
    const eligible = agents.filter(
      ({ status }) => status !== "OFFLINE" && status !== "UNSUPPORTED",
    );
    const finished = eligible.filter(({ status }) =>
      status === "INVALID" ? true : JOB_TERMINAL_STATUSES.has(status),
    );
    const reports: UsageReportSource[] = progressAndReports.flatMap(
      ({ progress, report }) =>
        report
          ? [
              {
                agent: {
                  id: progress.agent.id,
                  name: progress.agent.name,
                  hostname: progress.agent.hostname,
                },
                report,
              },
            ]
          : [],
    );
    return {
      id: collection.id,
      status: finished.length === eligible.length ? "COMPLETED" : "COLLECTING",
      createdAt: collection.createdAt.toISOString(),
      deadlineAt: collection.deadlineAt.toISOString(),
      finishedAt: collection.finishedAt?.toISOString() ?? null,
      progress: {
        eligibleCount: eligible.length,
        finishedCount: finished.length,
        successfulCount: eligible.filter(({ status }) => status === "SUCCEEDED")
          .length,
        agents,
      },
      aggregate: aggregateUsage(reports),
    };
  }

  private scheduleDeadline(collection: {
    id: string;
    deadlineAt: Date;
    finishedAt: Date | null;
  }): void {
    if (collection.finishedAt || this.deadlineTimers.has(collection.id)) return;
    const delay = Math.max(
      0,
      collection.deadlineAt.getTime() - this.now().getTime(),
    );
    const timer = setTimeout(() => {
      this.deadlineTimers.delete(collection.id);
      void this.expire(collection.id);
    }, delay);
    timer.unref?.();
    this.deadlineTimers.set(collection.id, timer);
  }

  private async expire(id: string): Promise<void> {
    try {
      await this.agentControlService.timeoutCollectionJobs(id);
      await this.getCollection(id);
      this.publish(id);
    } catch (error) {
      console.error(
        `Could not expire ccusage collection ${id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private clearDeadline(id: string): void {
    const timer = this.deadlineTimers.get(id);
    if (timer) clearTimeout(timer);
    this.deadlineTimers.delete(id);
  }

  private publish(id: string): void {
    agentEventBus.publish(ccusageCollectionChangedTopic(id), {
      ccusageCollectionChanged: { id },
    });
  }
}
