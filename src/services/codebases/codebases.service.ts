import { randomUUID } from "node:crypto";

import {
  CODEBASE_BROWSE_JOB_KIND,
  DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  CODEBASE_FETCH_JOB_KIND,
  CODEBASE_GIT_INSPECT_JOB_KIND,
  CODEBASE_GIT_OPERATION_JOB_KIND,
  CODEBASE_INSPECT_JOB_KIND,
  CODEBASE_JOB_KINDS,
  MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS,
  CODEBASE_REFRESH_JOB_KIND,
  parseCodebaseDirectoryListing,
  parseCodebaseGitState,
  parseCodebaseSnapshot,
  parseCodebaseStashDiff,
  type CodebaseGitOperation,
  type CodebaseSnapshot,
  type CodebaseStatusReport,
} from "@ai-development-environment/agent-contract/codebases";
import {
  DEFAULT_JIRA_BRANCH_REGEX,
  DEFAULT_WORKTREE_FETCH_INTERVAL_SECONDS,
  MAX_WORKTREE_FETCH_INTERVAL_SECONDS,
  MIN_WORKTREE_FETCH_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract/worktrees";

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
const SETTINGS_ID = "default";
const ACTIVE_CODEBASE_JOB_STATUSES = ["QUEUED", "RUNNING"];

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
    this.agentControl.registerCompletionHandler(
      CODEBASE_GIT_OPERATION_JOB_KIND,
      (job) => this.projectGitOperation(job),
    );
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

  async detail(id: string) {
    await this.cleanupInternalJobs();
    const prisma = await getPrismaClient();
    return prisma.codebase.findUnique({
      where: { id },
      include: {
        agent: true,
        repository: true,
        jobs: {
          where: { status: { in: ACTIVE_CODEBASE_JOB_STATUSES } },
          orderBy: { createdAt: "desc" },
          take: 1,
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
        defaultBranch: true,
        lastFetchedAt: true,
        lastFetchAttemptAt: true,
        repository: {
          select: {
            canonicalOrigin: true,
            keepBaseBranchUpToDate: true,
          },
        },
        worktrees: {
          where: { missingAt: null },
          select: { gitDirectory: true, baseBranchOverride: true },
        },
      },
    });
  }

  async settings() {
    const prisma = await getPrismaClient();
    const existing = await prisma.codebaseSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (existing) return existing;
    return prisma.codebaseSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        refreshIntervalSeconds: DEFAULT_CODEBASE_RECONCILE_INTERVAL_SECONDS,
        fetchIntervalSeconds: DEFAULT_WORKTREE_FETCH_INTERVAL_SECONDS,
        defaultJiraBranchRegex: DEFAULT_JIRA_BRANCH_REGEX,
      },
      update: {},
    });
  }

  async agentConfiguration(agentId: string) {
    const [settings, codebases] = await Promise.all([
      this.settings(),
      this.agentCodebases(agentId),
    ]);
    return {
      refreshIntervalSeconds: settings.refreshIntervalSeconds,
      fetchIntervalSeconds: settings.fetchIntervalSeconds,
      codebases,
    };
  }

  async updateSettings(
    input:
      | number
      | {
          refreshIntervalSeconds: number;
          fetchIntervalSeconds: number;
          defaultJiraBranchRegex: string;
        },
  ) {
    const refreshIntervalSeconds =
      typeof input === "number" ? input : input.refreshIntervalSeconds;
    const fetchIntervalSeconds =
      typeof input === "number"
        ? DEFAULT_WORKTREE_FETCH_INTERVAL_SECONDS
        : input.fetchIntervalSeconds;
    if (
      !Number.isInteger(refreshIntervalSeconds) ||
      refreshIntervalSeconds < MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS ||
      refreshIntervalSeconds > MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS
    ) {
      throw new Error(
        `Refresh interval must be an integer from ${MIN_CODEBASE_RECONCILE_INTERVAL_SECONDS} to ${MAX_CODEBASE_RECONCILE_INTERVAL_SECONDS} seconds`,
      );
    }
    if (
      !Number.isInteger(fetchIntervalSeconds) ||
      fetchIntervalSeconds < MIN_WORKTREE_FETCH_INTERVAL_SECONDS ||
      fetchIntervalSeconds > MAX_WORKTREE_FETCH_INTERVAL_SECONDS
    ) {
      throw new Error(
        `Fetch interval must be an integer from ${MIN_WORKTREE_FETCH_INTERVAL_SECONDS} to ${MAX_WORKTREE_FETCH_INTERVAL_SECONDS} seconds`,
      );
    }
    const defaultJiraBranchRegex =
      typeof input === "number"
        ? DEFAULT_JIRA_BRANCH_REGEX
        : input.defaultJiraBranchRegex.trim();
    if (defaultJiraBranchRegex) {
      try {
        void new RegExp(defaultJiraBranchRegex, "i");
      } catch {
        throw new Error("Default Jira branch regex is invalid");
      }
    }
    const prisma = await getPrismaClient();
    const data =
      typeof input === "number"
        ? { refreshIntervalSeconds }
        : {
            refreshIntervalSeconds,
            fetchIntervalSeconds,
            defaultJiraBranchRegex,
          };
    const settings = await prisma.codebaseSettings.upsert({
      where: { id: SETTINGS_ID },
      create: {
        id: SETTINGS_ID,
        ...data,
      },
      update: data,
    });
    this.publish(null, null);
    return settings;
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
    await this.agentControl.requestCodebaseReconcile([confirmed.agentId]);
    return confirmed;
  }

  async updateRepository(
    id: string,
    nameValue: string,
    descriptionValue: string,
    jiraBranchRegexValue?: string | null,
    keepBaseBranchUpToDate = true,
  ) {
    const name = nameValue.trim();
    const description = descriptionValue.trim();
    if (!name) throw new Error("Name is required");
    if (name.length > 120)
      throw new Error("Name must be 120 characters or fewer");
    if (description.length > 2_000) {
      throw new Error("Description must be 2,000 characters or fewer");
    }
    const jiraBranchRegex = jiraBranchRegexValue?.trim() || null;
    if (jiraBranchRegex) {
      try {
        void new RegExp(jiraBranchRegex, "i");
      } catch {
        throw new Error("Jira branch regex is invalid");
      }
    }
    const prisma = await getPrismaClient();
    const repository = await prisma.codebaseRepository.update({
      where: { id },
      data: {
        name,
        description,
        jiraBranchRegex,
        keepBaseBranchUpToDate,
      },
    });
    this.publish(null, id);
    return repository;
  }

  async removeCodebase(id: string) {
    const prisma = await getPrismaClient();
    const removal = await prisma.$transaction(async (transaction) => {
      const codebase = await transaction.codebase.findUnique({
        where: { id },
        select: { id: true, repositoryId: true },
      });
      if (!codebase) throw new Error("Codebase not found");

      await transaction.codebase.delete({ where: { id } });
      const remaining = await transaction.codebase.count({
        where: { repositoryId: codebase.repositoryId },
      });
      const repositoryRemoved = remaining === 0;
      if (repositoryRemoved) {
        await transaction.codebaseRepository.delete({
          where: { id: codebase.repositoryId },
        });
      }

      return {
        id: codebase.id,
        repositoryId: codebase.repositoryId,
        repositoryRemoved,
      };
    });
    this.publish(removal.id, removal.repositoryId);
    return removal;
  }

  async report(agentId: string, reports: CodebaseStatusReport[]) {
    const updated = [];
    let changed = false;
    try {
      for (const report of reports.slice(0, 500)) {
        const snapshot = parseCodebaseSnapshot(report.snapshot);
        const applied = await this.applySnapshot(
          agentId,
          report.codebaseId,
          snapshot,
        );
        updated.push(applied.codebase);
        changed ||= applied.changed;
      }
    } finally {
      if (changed) this.publish(null, null);
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
      include: {
        agent: true,
        repository: true,
        jobs: {
          where: { status: { in: ACTIVE_CODEBASE_JOB_STATUSES } },
          select: { id: true },
          take: 1,
        },
      },
    });
    const jobs = [];
    const skipped: Array<{ codebaseId: string; reason: string }> = [];
    for (const codebase of codebases) {
      if (codebase.jobs.length > 0) {
        skipped.push({ codebaseId: codebase.id, reason: "ACTIVE_OPERATION" });
        continue;
      }
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
      try {
        jobs.push(
          await this.agentControl.createJob({
            agentId: codebase.agentId,
            codebaseId: codebase.id,
            kind,
            payload: {
              codebaseId: codebase.id,
              folder: codebase.folder,
              expectedOrigin: codebase.repository.canonicalOrigin,
              ...(kind === CODEBASE_FETCH_JOB_KIND && codebase.defaultBranch
                ? { baseBranch: codebase.defaultBranch }
                : {}),
              ...(kind === CODEBASE_FETCH_JOB_KIND
                ? {
                    keepBaseBranchUpToDate:
                      codebase.repository.keepBaseBranchUpToDate,
                  }
                : {}),
            },
            idempotencyKey: `codebase:${kind}:${requestId}:${codebase.id}`,
            timeoutSeconds: kind === CODEBASE_FETCH_JOB_KIND ? 300 : 30,
          }),
        );
      } catch (error) {
        const active = await prisma.agentJob.findFirst({
          where: {
            codebaseId: codebase.id,
            status: { in: ACTIVE_CODEBASE_JOB_STATUSES },
          },
          select: { id: true },
        });
        if (!active) throw error;
        skipped.push({ codebaseId: codebase.id, reason: "ACTIVE_OPERATION" });
      }
    }
    return { jobs, skipped };
  }

  async inspectGitState(codebaseId: string, requestId: string) {
    if (!requestId.trim()) throw new Error("requestId is required");
    const codebase = await this.requireRunnableCodebase(
      codebaseId,
      CODEBASE_GIT_INSPECT_JOB_KIND,
    );
    const job = await this.agentControl.createJob({
      agentId: codebase.agentId,
      codebaseId: codebase.id,
      kind: CODEBASE_GIT_INSPECT_JOB_KIND,
      payload: {
        action: "STATE",
        codebaseId: codebase.id,
        folder: codebase.folder,
        expectedOrigin: codebase.repository.canonicalOrigin,
      },
      idempotencyKey: `codebase:git:state:${requestId}:${codebase.id}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    const prisma = await getPrismaClient();
    try {
      const completed = await this.waitForJob(job.id);
      return parseCodebaseGitState(resultObject(completed).state);
    } finally {
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async inspectStash(codebaseId: string, stashOid: string, requestId: string) {
    if (!requestId.trim()) throw new Error("requestId is required");
    const codebase = await this.requireRunnableCodebase(
      codebaseId,
      CODEBASE_GIT_INSPECT_JOB_KIND,
    );
    const job = await this.agentControl.createJob({
      agentId: codebase.agentId,
      codebaseId: codebase.id,
      kind: CODEBASE_GIT_INSPECT_JOB_KIND,
      payload: {
        action: "STASH_DIFF",
        codebaseId: codebase.id,
        folder: codebase.folder,
        expectedOrigin: codebase.repository.canonicalOrigin,
        stashOid,
      },
      idempotencyKey: `codebase:git:stash:${requestId}:${codebase.id}`,
      timeoutSeconds: 30,
      visibility: "SYSTEM",
    });
    const prisma = await getPrismaClient();
    try {
      const completed = await this.waitForJob(job.id);
      return parseCodebaseStashDiff(resultObject(completed).diff);
    } finally {
      await prisma.agentJob.deleteMany({
        where: { id: job.id, visibility: "SYSTEM" },
      });
    }
  }

  async runGitOperation(input: {
    codebaseId: string;
    operation: CodebaseGitOperation;
    branch?: string | null;
    stashOid?: string | null;
    stashChanges?: boolean | null;
    requestId: string;
  }) {
    if (!input.requestId.trim()) throw new Error("requestId is required");
    const codebase = await this.requireRunnableCodebase(
      input.codebaseId,
      CODEBASE_GIT_OPERATION_JOB_KIND,
    );
    return this.agentControl.createJob({
      agentId: codebase.agentId,
      codebaseId: codebase.id,
      kind: CODEBASE_GIT_OPERATION_JOB_KIND,
      payload: {
        codebaseId: codebase.id,
        folder: codebase.folder,
        expectedOrigin: codebase.repository.canonicalOrigin,
        defaultBranch: codebase.defaultBranch,
        operation: input.operation,
        ...(input.branch ? { branch: input.branch } : {}),
        ...(input.stashOid ? { stashOid: input.stashOid } : {}),
        ...(input.operation === "SWITCH_BRANCH"
          ? { stashChanges: Boolean(input.stashChanges) }
          : {}),
      },
      idempotencyKey: `codebase:git:${input.operation}:${input.requestId}:${codebase.id}`,
      timeoutSeconds: input.operation === "PULL_BRANCH" ? 300 : 60,
    });
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
    const applied = await this.applySnapshot(
      job.agentId,
      job.codebaseId,
      parseCodebaseSnapshot(snapshotValue),
    );
    if (applied.changed) {
      this.publish(applied.codebase.id, applied.codebase.repositoryId);
    }
  }

  private async projectGitOperation(job: CompletedJob) {
    if (job.status === "SUCCEEDED") {
      try {
        await this.projectJob(job);
      } catch (error) {
        console.error(
          "Could not project codebase Git operation:",
          error instanceof Error ? error.message : error,
        );
      }
    }
    try {
      await this.agentControl.requestCodebaseReconcile([job.agentId]);
    } catch (error) {
      console.error(
        "Could not request codebase reconciliation:",
        error instanceof Error ? error.message : error,
      );
    }
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
    const checkedAt = new Date(snapshot.checkedAt);
    const mismatch =
      snapshot.canonicalOrigin !== null &&
      snapshot.canonicalOrigin !== current.repository.canonicalOrigin;
    const incomingFetched = snapshot.fetchedAt
      ? new Date(snapshot.fetchedAt)
      : null;
    const changed = await prisma.codebase.updateMany({
      where: {
        id: codebaseId,
        agentId,
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: checkedAt } }],
      },
      data: {
        folder: snapshot.folder,
        ...(snapshot.observedOrigin === null
          ? {}
          : { observedOrigin: snapshot.observedOrigin }),
        branch: snapshot.branch,
        headSha: snapshot.headSha,
        upstream: snapshot.upstream,
        ahead: snapshot.ahead,
        behind: snapshot.behind,
        syncState: snapshot.syncState,
        availability: mismatch ? "ORIGIN_MISMATCH" : snapshot.availability,
        statusError: mismatch
          ? `Origin changed to ${snapshot.displayOrigin ?? "an unknown remote"}`
          : snapshot.error,
        lastCheckedAt: checkedAt,
      },
    });
    if (changed.count > 0 && incomingFetched) {
      await prisma.codebase.updateMany({
        where: {
          id: codebaseId,
          agentId,
          OR: [
            { lastFetchedAt: null },
            { lastFetchedAt: { lt: incomingFetched } },
          ],
        },
        data: { lastFetchedAt: incomingFetched },
      });
    }
    const codebase = await prisma.codebase.findUnique({
      where: { id: codebaseId },
      include: { agent: true, repository: true, jobs: true },
    });
    if (!codebase || codebase.agentId !== agentId) {
      throw new Error("Codebase not found for this agent");
    }
    return { codebase, changed: changed.count > 0 };
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

  private async requireRunnableCodebase(id: string, capability: string) {
    await this.cleanupInternalJobs();
    const prisma = await getPrismaClient();
    const codebase = await prisma.codebase.findUnique({
      where: { id },
      include: {
        agent: true,
        repository: true,
        jobs: {
          where: { status: { in: ACTIVE_CODEBASE_JOB_STATUSES } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!codebase) throw new Error("Codebase not found");
    if (!online(codebase.agent)) throw new Error("Agent is offline");
    if (!capabilities(codebase.agent).includes(capability)) {
      throw new Error(
        "Agent must be updated to manage Git branches and stashes",
      );
    }
    if (codebase.availability !== "AVAILABLE") {
      throw new Error(codebase.statusError || "Codebase is unavailable");
    }
    if (codebase.jobs.length) {
      throw new Error("Another codebase operation is already running");
    }
    return codebase;
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

  private publish(codebaseId: string | null, repositoryId: string | null) {
    agentEventBus.publish(CODEBASE_CHANGED_TOPIC, {
      codebaseOverviewChanged: { codebaseId, repositoryId },
    });
  }

  private async cleanupInternalJobs() {
    const prisma = await getPrismaClient();
    await prisma.agentJob.deleteMany({
      where: {
        visibility: "SYSTEM",
        kind: { in: [...CODEBASE_JOB_KINDS] },
        finishedAt: { lt: new Date(Date.now() - INSPECTION_MAX_AGE_MS) },
      },
    });
  }
}
