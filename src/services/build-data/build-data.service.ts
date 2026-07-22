import { createHash, randomUUID } from "node:crypto";

import {
  BUILD_DATA_DELETE_JOB_KIND,
  BUILD_DATA_SCAN_JOB_KIND,
  BUILD_DATA_SIZE_JOB_KIND,
  buildDataTargetsPayload,
  parseBuildDataDeleteResult,
  parseBuildDataScanResult,
  parseBuildDataSizeResult,
} from "@ai-development-environment/agent-contract/build-data";

import { getPrismaClient } from "@/data/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import {
  agentOnlineWindowMs,
  AgentControlService,
  agentEventBus,
  buildDataCollectionChangedTopic,
} from "@/services/agent-control";
import { worktreeDisplayPath } from "@/services/worktrees/worktrees.service";

const COLLECTION_DEADLINE_MS = 60_000;
const SCAN_TIMEOUT_SECONDS = 45;
const OPERATION_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const TERMINAL_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "INVALID",
]);

const collectionInclude = {
  agents: { include: { agent: true } },
  jobs: { orderBy: { createdAt: "asc" as const } },
} as const;

type LoadedCollection = Prisma.BuildDataCollectionGetPayload<{
  include: typeof collectionInclude;
}>;

type PersistedAgent = LoadedCollection["agents"][number]["agent"];

export type BuildDataAgentStatus =
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

export type BuildDataEntryView = {
  id: string;
  name: string;
  kind: "PROJECT" | "PENDING" | "SHARED_CACHE" | "DEVICE_SUPPORT";
  status: "READY" | "UNLINKED" | "PENDING" | "SHARED_CACHE";
  workspacePath: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  sizeBytes: number | null;
  operation: "IDLE" | "SIZING" | "DELETING";
  error: string | null;
  agent: PersistedAgent;
  path: string;
  rootPath: string;
};

export type BuildDataCollectionSnapshot = {
  id: string;
  status: "COLLECTING" | "COMPLETED";
  createdAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  progress: {
    eligibleCount: number;
    finishedCount: number;
    successfulCount: number;
    agents: Array<{
      agent: PersistedAgent;
      status: BuildDataAgentStatus;
      jobId: string | null;
      error: string | null;
      warnings: string[];
    }>;
  };
  entries: BuildDataEntryView[];
};

function online(agent: PersistedAgent): boolean {
  return (
    agent.lastSeenAt !== null &&
    Date.now() - agent.lastSeenAt.getTime() <= agentOnlineWindowMs(agent) &&
    agent.disconnectedAt === null
  );
}

function capabilities(agent: PersistedAgent): string[] {
  try {
    const value: unknown = JSON.parse(agent.capabilitiesJson);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function initialStatus(agent: PersistedAgent): BuildDataAgentStatus {
  if (!online(agent)) return "OFFLINE";
  if (!capabilities(agent).includes(BUILD_DATA_SCAN_JOB_KIND)) {
    return "UNSUPPORTED";
  }
  return "QUEUING";
}

function parseResult(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function operationTargetPaths(job: { payloadJson: string }): string[] {
  return buildDataTargetsPayload(parseResult(job.payloadJson)).targets.map(
    (target) => target.path,
  );
}

function invalidOperationResultError(
  kind: typeof BUILD_DATA_SIZE_JOB_KIND | typeof BUILD_DATA_DELETE_JOB_KIND,
  error: unknown,
): string {
  const operation = kind === BUILD_DATA_DELETE_JOB_KIND ? "delete" : "size";
  return `Invalid Build Data ${operation} result: ${errorMessage(error)}`;
}

function applyOperationError(
  views: Map<string, BuildDataEntryView>,
  job: { agentId: string; payloadJson: string },
  error: string,
): void {
  try {
    for (const path of operationTargetPaths(job)) {
      const view = views.get(entryId(job.agentId, path));
      if (view) view.error = error;
    }
  } catch {
    // Operation payloads are validated before the jobs are created.
  }
}

function entryId(agentId: string, path: string): string {
  return createHash("sha256")
    .update(agentId)
    .update("\0")
    .update(path)
    .digest("base64url");
}

function pathContains(folder: string, candidate: string): boolean {
  const normalized = folder === "/" ? folder : folder.replace(/\/+$/, "");
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

export class BuildDataService {
  private initialized = false;

  constructor(private readonly agentControlService: AgentControlService) {
    this.agentControlService.registerCompletionHandler(
      BUILD_DATA_DELETE_JOB_KIND,
      (job) => this.projectDeletion(job),
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.pruneHistory();
    this.initialized = true;
  }

  async refresh(
    requestId?: string | null,
  ): Promise<BuildDataCollectionSnapshot> {
    await this.initialize();
    const id = requestId?.trim() || randomUUID();
    await this.ensureCollection(id);
    return (await this.getCollection(id))!;
  }

  async getCollection(id: string): Promise<BuildDataCollectionSnapshot | null> {
    await this.initialize();
    let collection = await this.loadCollection(id);
    if (!collection) return null;
    if (
      !collection.finishedAt &&
      collection.deadlineAt.getTime() <= Date.now()
    ) {
      await this.expireCollection(collection);
      collection = (await this.loadCollection(id)) ?? collection;
    }
    const snapshot = await this.snapshot(collection);
    if (snapshot.status === "COMPLETED" && !collection.finishedAt) {
      const finishedAt = new Date();
      const prisma = await getPrismaClient();
      await prisma.buildDataCollection.updateMany({
        where: { id, finishedAt: null },
        data: { finishedAt },
      });
      snapshot.finishedAt = finishedAt.toISOString();
    }
    return snapshot;
  }

  async *subscribe(
    id: string,
  ): AsyncIterableIterator<BuildDataCollectionSnapshot> {
    await this.initialize();
    const events = agentEventBus.iterate(buildDataCollectionChangedTopic(id));
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

  async calculateSizes(
    collectionId: string,
    entryIds: string[],
    requestId: string,
  ): Promise<BuildDataCollectionSnapshot> {
    const snapshot = await this.requireCollection(collectionId);
    await this.createTargetJobs(
      snapshot,
      entryIds,
      requestId,
      BUILD_DATA_SIZE_JOB_KIND,
    );
    return (await this.getCollection(collectionId))!;
  }

  async deleteEntries(
    collectionId: string,
    entryIds: string[],
    requestId: string,
  ): Promise<BuildDataCollectionSnapshot> {
    const snapshot = await this.requireCollection(collectionId);
    await this.createTargetJobs(
      snapshot,
      entryIds,
      requestId,
      BUILD_DATA_DELETE_JOB_KIND,
    );
    return (await this.getCollection(collectionId))!;
  }

  async history(first = 100, after?: string | null) {
    await this.initialize();
    await this.pruneHistory();
    const take = Math.max(1, Math.min(first, 200));
    const prisma = await getPrismaClient();
    const cursor = after
      ? await prisma.buildDataDeletionHistory.findUnique({
          where: { id: after },
          select: { id: true, deletedAt: true },
        })
      : null;
    const items = await prisma.buildDataDeletionHistory.findMany({
      where: cursor
        ? {
            OR: [
              { deletedAt: { lt: cursor.deletedAt } },
              { deletedAt: cursor.deletedAt, id: { lt: cursor.id } },
            ],
          }
        : undefined,
      orderBy: [{ deletedAt: "desc" }, { id: "desc" }],
      take: take + 1,
    });
    const hasMore = items.length > take;
    const page = items.slice(0, take);
    return {
      items: page,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async clearHistory(): Promise<number> {
    await this.initialize();
    const prisma = await getPrismaClient();
    return (await prisma.buildDataDeletionHistory.deleteMany()).count;
  }

  private async ensureCollection(id: string): Promise<void> {
    const prisma = await getPrismaClient();
    let collection = await prisma.buildDataCollection.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!collection) {
      const agents =
        (await this.agentControlService.listAgents()) as PersistedAgent[];
      try {
        collection = await prisma.buildDataCollection.create({
          data: {
            id,
            deadlineAt: new Date(Date.now() + COLLECTION_DEADLINE_MS),
            agents: {
              create: agents.map((agent) => ({
                agentId: agent.id,
                initialStatus: initialStatus(agent),
              })),
            },
          },
          select: { id: true },
        });
        this.publish(id);
      } catch (error) {
        collection = await prisma.buildDataCollection.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!collection) throw error;
      }
    }
    await this.ensureScanJobs(id);
  }

  private async ensureScanJobs(collectionId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const collection = await prisma.buildDataCollection.findUnique({
      where: { id: collectionId },
      select: { deadlineAt: true, finishedAt: true },
    });
    if (
      !collection ||
      collection.finishedAt ||
      collection.deadlineAt <= new Date()
    ) {
      return;
    }
    const members = await prisma.buildDataCollectionAgent.findMany({
      where: { collectionId, initialStatus: "QUEUING" },
      include: { agent: true },
    });
    const jobs = await prisma.agentJob.findMany({
      where: {
        buildDataCollectionId: collectionId,
        kind: BUILD_DATA_SCAN_JOB_KIND,
      },
      select: { agentId: true },
    });
    const agentsWithJobs = new Set(jobs.map((job) => job.agentId));
    for (const member of members) {
      if (agentsWithJobs.has(member.agentId)) continue;
      try {
        const worktrees = await prisma.worktree.findMany({
          where: {
            missingAt: null,
            codebase: { agentId: member.agentId },
          },
          select: { id: true, folder: true },
        });
        await this.agentControlService.createJob({
          agentId: member.agentId,
          kind: BUILD_DATA_SCAN_JOB_KIND,
          payload: {
            mode: member.agent.derivedDataLocationMode,
            path: member.agent.derivedDataPath,
            worktrees,
          },
          idempotencyKey: `build-data:scan:${collectionId}`,
          timeoutSeconds: SCAN_TIMEOUT_SECONDS,
          buildDataCollectionId: collectionId,
          visibility: "SYSTEM",
        });
      } catch (error) {
        await prisma.buildDataCollectionAgent.update({
          where: {
            collectionId_agentId: { collectionId, agentId: member.agentId },
          },
          data: {
            initialStatus: "FAILED",
            error: error instanceof Error ? error.message : String(error),
          },
        });
        this.publish(collectionId);
      }
    }
  }

  private async createTargetJobs(
    snapshot: BuildDataCollectionSnapshot,
    requestedIds: string[],
    requestId: string,
    kind: typeof BUILD_DATA_SIZE_JOB_KIND | typeof BUILD_DATA_DELETE_JOB_KIND,
  ): Promise<void> {
    const uniqueIds = [...new Set(requestedIds)];
    if (!uniqueIds.length)
      throw new Error("Select at least one Derived Data entry");
    const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const selected = uniqueIds.map((id) => {
      const entry = entries.get(id);
      if (!entry)
        throw new Error("A selected Derived Data entry is no longer available");
      return entry;
    });
    const groups = new Map<string, BuildDataEntryView[]>();
    for (const entry of selected) {
      const group = groups.get(entry.agent.id) ?? [];
      group.push(entry);
      groups.set(entry.agent.id, group);
    }
    const prisma = await getPrismaClient();
    const readyGroups: Array<{
      agentId: string;
      entries: BuildDataEntryView[];
    }> = [];
    for (const [agentId, group] of groups) {
      const selectedAgent = group[0]!.agent;
      const currentAgent = await prisma.agent.findUnique({
        where: { id: agentId },
      });
      if (!currentAgent || !online(currentAgent)) {
        throw new Error(
          `${selectedAgent.name} is offline; reconnect it before running this operation`,
        );
      }
      if (!capabilities(currentAgent).includes(kind)) {
        throw new Error(
          `${selectedAgent.name} must be updated before this operation can run`,
        );
      }
      readyGroups.push({ agentId, entries: group });
    }
    for (const { agentId, entries: group } of readyGroups) {
      await this.agentControlService.createJob({
        agentId,
        kind,
        payload: {
          targets: group.map(({ path, rootPath }) => ({ path, rootPath })),
        },
        idempotencyKey: `${kind}:${snapshot.id}:${requestId}:${agentId}`,
        timeoutSeconds: OPERATION_TIMEOUT_SECONDS,
        buildDataCollectionId: snapshot.id,
        visibility: "SYSTEM",
      });
    }
  }

  private async requireCollection(
    id: string,
  ): Promise<BuildDataCollectionSnapshot> {
    const collection = await this.getCollection(id);
    if (!collection) throw new Error("Derived Data collection not found");
    if (collection.status !== "COMPLETED") {
      throw new Error("Wait for the Derived Data scan to finish");
    }
    return collection;
  }

  private async loadCollection(id: string): Promise<LoadedCollection | null> {
    const prisma = await getPrismaClient();
    return prisma.buildDataCollection.findUnique({
      where: { id },
      include: collectionInclude,
    });
  }

  private progress(collection: LoadedCollection) {
    const scanJobs = new Map(
      collection.jobs
        .filter((job) => job.kind === BUILD_DATA_SCAN_JOB_KIND)
        .map((job) => [job.agentId, job]),
    );
    const agents = collection.agents.map((member) => {
      const job = scanJobs.get(member.agentId);
      let status = member.initialStatus as BuildDataAgentStatus;
      let error = member.error;
      let warnings: string[] = [];
      if (member.initialStatus === "QUEUING" && job) {
        status = job.status as BuildDataAgentStatus;
        error = job.error;
        if (job.status === "SUCCEEDED") {
          try {
            warnings = parseBuildDataScanResult(
              parseResult(job.resultJson),
            ).warnings;
          } catch (parseError) {
            status = "INVALID";
            error =
              parseError instanceof Error
                ? parseError.message
                : String(parseError);
          }
        }
      }
      return {
        agent: member.agent,
        status,
        jobId: job?.id ?? null,
        error,
        warnings,
      };
    });
    const eligible = agents.filter(
      ({ status }) => status !== "OFFLINE" && status !== "UNSUPPORTED",
    );
    const finished = eligible.filter(({ status }) =>
      TERMINAL_STATUSES.has(status),
    );
    return {
      agents,
      eligibleCount: eligible.length,
      finishedCount: finished.length,
      successfulCount: eligible.filter(({ status }) => status === "SUCCEEDED")
        .length,
    };
  }

  private async snapshot(
    collection: LoadedCollection,
  ): Promise<BuildDataCollectionSnapshot> {
    const progress = this.progress(collection);
    const entries = await this.entries(collection, false);
    return {
      id: collection.id,
      status:
        progress.finishedCount === progress.eligibleCount
          ? "COMPLETED"
          : "COLLECTING",
      createdAt: collection.createdAt.toISOString(),
      deadlineAt: collection.deadlineAt.toISOString(),
      finishedAt: collection.finishedAt?.toISOString() ?? null,
      progress,
      entries,
    };
  }

  private async entries(
    collection: LoadedCollection,
    includeDeleted: boolean,
  ): Promise<BuildDataEntryView[]> {
    const prisma = await getPrismaClient();
    const agentById = new Map(
      collection.agents.map((member) => [member.agentId, member.agent]),
    );
    const worktrees = await prisma.worktree.findMany({
      where: {
        missingAt: null,
        codebase: { agentId: { in: [...agentById.keys()] } },
      },
      include: { codebase: { select: { agentId: true } } },
    });
    const worktreesByAgent = new Map<string, typeof worktrees>();
    for (const worktree of worktrees) {
      const group = worktreesByAgent.get(worktree.codebase.agentId) ?? [];
      group.push(worktree);
      worktreesByAgent.set(worktree.codebase.agentId, group);
    }

    const views = new Map<string, BuildDataEntryView>();
    for (const job of collection.jobs) {
      if (job.kind !== BUILD_DATA_SCAN_JOB_KIND || job.status !== "SUCCEEDED")
        continue;
      const agent = agentById.get(job.agentId);
      if (!agent) continue;
      let report;
      try {
        report = parseBuildDataScanResult(parseResult(job.resultJson));
      } catch {
        continue;
      }
      for (const entry of report.entries) {
        const candidates = entry.workspacePath
          ? (worktreesByAgent.get(job.agentId) ?? [])
              .filter((worktree) =>
                pathContains(worktree.folder, entry.workspacePath!),
              )
              .sort(
                (first, second) => second.folder.length - first.folder.length,
              )
          : [];
        const worktree = candidates[0] ?? null;
        const id = entryId(job.agentId, entry.path);
        views.set(id, {
          id,
          name: entry.name,
          kind: entry.kind,
          status:
            entry.kind === "DEVICE_SUPPORT"
              ? "READY"
              : entry.kind === "PENDING"
                ? "PENDING"
                : entry.kind === "SHARED_CACHE"
                  ? "SHARED_CACHE"
                  : worktree
                    ? "READY"
                    : "UNLINKED",
          workspacePath: entry.workspacePath,
          worktreeId: worktree?.id ?? null,
          worktreePath: worktree
            ? worktreeDisplayPath(worktree.folder, agent.baseRepoDirectory)
            : null,
          sizeBytes: null,
          operation: "IDLE",
          error: null,
          agent,
          path: entry.path,
          rootPath: entry.rootPath,
        });
      }
    }

    for (const job of collection.jobs) {
      if (job.kind === BUILD_DATA_SIZE_JOB_KIND && job.status === "SUCCEEDED") {
        try {
          for (const size of parseBuildDataSizeResult(
            parseResult(job.resultJson),
          ).sizes) {
            const view = views.get(entryId(job.agentId, size.path));
            if (!view) continue;
            view.sizeBytes = size.sizeBytes;
            view.error = size.error;
          }
        } catch (error) {
          applyOperationError(
            views,
            job,
            invalidOperationResultError(BUILD_DATA_SIZE_JOB_KIND, error),
          );
        }
      }
      if (
        job.kind === BUILD_DATA_DELETE_JOB_KIND &&
        job.status === "SUCCEEDED"
      ) {
        try {
          for (const deletion of parseBuildDataDeleteResult(
            parseResult(job.resultJson),
          ).deleted) {
            const id = entryId(job.agentId, deletion.path);
            const view = views.get(id);
            if (!view) continue;
            if (deletion.deleted && !includeDeleted) views.delete(id);
            else view.error = deletion.error;
          }
        } catch (error) {
          applyOperationError(
            views,
            job,
            invalidOperationResultError(BUILD_DATA_DELETE_JOB_KIND, error),
          );
        }
      }
      if (job.status === "QUEUED" || job.status === "RUNNING") {
        if (
          job.kind !== BUILD_DATA_SIZE_JOB_KIND &&
          job.kind !== BUILD_DATA_DELETE_JOB_KIND
        ) {
          continue;
        }
        try {
          for (const path of operationTargetPaths(job)) {
            const view = views.get(entryId(job.agentId, path));
            if (view) {
              view.operation =
                job.kind === BUILD_DATA_DELETE_JOB_KIND ? "DELETING" : "SIZING";
            }
          }
        } catch {
          // Job payloads were validated at creation time.
        }
      }
      if (
        job.status !== "SUCCEEDED" &&
        TERMINAL_STATUSES.has(job.status) &&
        (job.kind === BUILD_DATA_SIZE_JOB_KIND ||
          job.kind === BUILD_DATA_DELETE_JOB_KIND)
      ) {
        try {
          for (const path of operationTargetPaths(job)) {
            const view = views.get(entryId(job.agentId, path));
            if (view) view.error = job.error || "Build Data operation failed";
          }
        } catch {
          // Job payloads were validated at creation time.
        }
      }
    }
    return [...views.values()].sort(
      (first, second) =>
        first.agent.name.localeCompare(second.agent.name) ||
        first.name.localeCompare(second.name),
    );
  }

  private async expireCollection(collection: LoadedCollection): Promise<void> {
    const prisma = await getPrismaClient();
    const agentsWithJobs = new Set(
      collection.jobs
        .filter((job) => job.kind === BUILD_DATA_SCAN_JOB_KIND)
        .map((job) => job.agentId),
    );
    await prisma.buildDataCollectionAgent.updateMany({
      where: {
        collectionId: collection.id,
        initialStatus: "QUEUING",
        agentId: { notIn: [...agentsWithJobs] },
      },
      data: { initialStatus: "TIMED_OUT" },
    });
    await this.agentControlService.timeoutBuildDataCollectionJobs(
      collection.id,
    );
    this.publish(collection.id);
  }

  private async projectDeletion(job: {
    id: string;
    agentId: string;
    buildDataCollectionId: string | null;
    status: string;
    resultJson: string | null;
    error: string | null;
  }): Promise<void> {
    if (
      job.status !== "SUCCEEDED" ||
      !job.buildDataCollectionId ||
      !job.resultJson
    ) {
      return;
    }
    await this.pruneHistory();
    const prisma = await getPrismaClient();
    if (
      await prisma.buildDataDeleteProjection.findUnique({
        where: { jobId: job.id },
      })
    ) {
      return;
    }
    let deleted: ReturnType<typeof parseBuildDataDeleteResult>["deleted"];
    try {
      deleted = parseBuildDataDeleteResult(
        parseResult(job.resultJson),
      ).deleted.filter((item) => item.deleted);
    } catch (error) {
      const projectionError = invalidOperationResultError(
        BUILD_DATA_DELETE_JOB_KIND,
        error,
      );
      try {
        await prisma.buildDataDeleteProjection.create({
          data: { jobId: job.id, error: projectionError },
        });
      } catch (createError) {
        const projected = await prisma.buildDataDeleteProjection.findUnique({
          where: { jobId: job.id },
        });
        if (!projected) throw createError;
      }
      return;
    }
    if (!deleted.length) {
      await prisma.buildDataDeleteProjection.create({
        data: { jobId: job.id },
      });
      return;
    }
    const collection = await this.loadCollection(job.buildDataCollectionId);
    if (!collection) return;
    const views = await this.entries(collection, true);
    const byPath = new Map(
      views
        .filter((entry) => entry.agent.id === job.agentId)
        .map((entry) => [entry.path, entry]),
    );
    try {
      await prisma.$transaction(async (transaction) => {
        const existing = await transaction.buildDataDeleteProjection.findUnique(
          {
            where: { jobId: job.id },
          },
        );
        if (existing) return;
        await transaction.buildDataDeleteProjection.create({
          data: { jobId: job.id },
        });
        for (const deletion of deleted) {
          const entry = byPath.get(deletion.path);
          if (!entry) continue;
          const worktreeId = entry.worktreeId
            ? ((
                await transaction.worktree.findUnique({
                  where: { id: entry.worktreeId },
                  select: { id: true },
                })
              )?.id ?? null)
            : null;
          await transaction.buildDataDeletionHistory.create({
            data: {
              id: randomUUID(),
              agentId: entry.agent.id,
              agentName: entry.agent.name,
              folderName: entry.name,
              worktreeId,
              worktreePath: entry.worktreePath,
              source: "USER",
              entryKind: entry.kind,
              jobId: job.id,
              targetKey: entry.id,
            },
          });
        }
      });
    } catch (error) {
      const projected = await prisma.buildDataDeleteProjection.findUnique({
        where: { jobId: job.id },
      });
      if (!projected) throw error;
    }
  }

  private async pruneHistory(): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.buildDataDeletionHistory.deleteMany({
      where: { deletedAt: { lt: new Date(Date.now() - HISTORY_RETENTION_MS) } },
    });
  }

  private publish(id: string): void {
    agentEventBus.publish(buildDataCollectionChangedTopic(id), {
      buildDataCollectionChanged: { id },
    });
  }
}
