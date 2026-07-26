import "server-only";

import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  GITHUB_PIPELINE_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";

import {
  aggregatePipelineStatus,
  GITHUB_PIPELINE_OPTIMISTIC_MS,
  GITHUB_PIPELINE_RETENTION_MS,
  isPipelineState,
  isPipelineStatus,
  pipelineIdentity,
  shouldReplacePipelineRecord,
} from "./pipeline-status";
import type {
  GitHubActionsWorkflowRunView,
  GitHubPipelineObservationSource,
  GitHubPipelineRecordKeyInput,
  GitHubPipelineRecordView,
  GitHubPipelineState,
  GitHubPipelineStatus,
  GitHubPipelineStatusChangeView,
  GitHubPipelineStatusKeyInput,
  GitHubPipelineStatusSnapshotView,
  GitHubPipelineView,
  GitHubWorkflowJobView,
} from "./types";

type PipelineRecordRow = {
  id: string;
  snapshotId: string;
  identityKey: string;
  githubPipelineId: string;
  name: string;
  status: string;
  url: string | null;
  checkSuiteId: string | null;
  workflowRunId: string | null;
  workflowId: string | null;
  runNumber: number | null;
  runAttempt: number | null;
  canRetry: boolean;
  retryUnavailableReason: string | null;
  jobsJson: string;
  source: string;
  githubUpdatedAt: Date | null;
  sourceFetchedAt: Date;
  lastObservedAt: Date;
  optimisticUntil: Date | null;
  isCurrent: boolean;
};

type PipelineSnapshotRow = {
  id: string;
  repositoryGithubId: string;
  repositoryNameWithOwner: string;
  repositoryUrl: string;
  headSha: string;
  pipelineStatus: string;
  graphqlRollupStatus: string | null;
  revision: number;
  lastGraphqlSyncAt: Date | null;
  lastObservedAt: Date;
  updatedAt: Date;
  records: PipelineRecordRow[];
};

export type GitHubPipelineObservation = {
  id: string;
  name: string;
  status: GitHubPipelineState;
  url?: string | null;
  checkSuiteId?: string | null;
  workflowRunId?: string | null;
  workflowId?: string | null;
  runNumber?: number | null;
  runAttempt?: number | null;
  canRetry?: boolean;
  retryUnavailableReason?: GitHubPipelineView["retryUnavailableReason"];
  jobs?: GitHubWorkflowJobView[];
  statusContext?: string | null;
  source: GitHubPipelineObservationSource;
  githubUpdatedAt?: Date | null;
  sourceFetchedAt?: Date;
  optimisticUntil?: Date | null;
  isCurrent?: boolean;
};

export type ObserveGitHubPipelineSnapshotInput = {
  repositoryGithubId: string;
  repositoryNameWithOwner: string;
  repositoryUrl: string;
  headSha: string;
  graphqlRollupStatus?: GitHubPipelineStatus | null;
  sourceFetchedAt?: Date;
  completeGraphqlRollup?: boolean;
  pipelines: GitHubPipelineObservation[];
};

function parseJobs(value: string): GitHubWorkflowJobView[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as GitHubWorkflowJobView[]) : [];
  } catch {
    return [];
  }
}

function source(value: string): GitHubPipelineObservationSource {
  return value === "GRAPHQL" ||
    value === "REST" ||
    value === "WEBHOOK" ||
    value === "MUTATION"
    ? value
    : "LEGACY";
}

function pipelineView(record: PipelineRecordRow): GitHubPipelineView {
  return {
    id: record.githubPipelineId,
    name: record.name,
    status: isPipelineState(record.status) ? record.status : "NONE",
    url: record.url,
    checkSuiteId: record.checkSuiteId,
    canRetry: record.canRetry,
    retryUnavailableReason:
      record.retryUnavailableReason as GitHubPipelineView["retryUnavailableReason"],
    jobs: parseJobs(record.jobsJson),
    workflowRunId: record.workflowRunId,
    workflowId: record.workflowId,
    runNumber: record.runNumber,
    runAttempt: record.runAttempt,
  };
}

function recordView(
  snapshot: PipelineSnapshotRow,
  record: PipelineRecordRow,
): GitHubPipelineRecordView {
  return {
    ...pipelineView(record),
    repositoryGithubId: snapshot.repositoryGithubId,
    headSha: snapshot.headSha,
    revision: snapshot.revision,
    isCurrent: record.isCurrent,
  };
}

function snapshotView(
  snapshot: PipelineSnapshotRow,
): GitHubPipelineStatusSnapshotView {
  return {
    repositoryGithubId: snapshot.repositoryGithubId,
    repositoryNameWithOwner: snapshot.repositoryNameWithOwner,
    repositoryUrl: snapshot.repositoryUrl,
    headSha: snapshot.headSha,
    pipelineStatus: isPipelineStatus(snapshot.pipelineStatus)
      ? snapshot.pipelineStatus
      : "NONE",
    pipelines: snapshot.records
      .filter((record) => record.isCurrent)
      .map(pipelineView)
      .sort((left, right) => left.name.localeCompare(right.name)),
    revision: snapshot.revision,
    updatedAt: snapshot.updatedAt.toISOString(),
  };
}

function recordSignature(record: PipelineRecordRow): string {
  return JSON.stringify({
    identityKey: record.identityKey,
    githubPipelineId: record.githubPipelineId,
    name: record.name,
    status: record.status,
    url: record.url,
    checkSuiteId: record.checkSuiteId,
    workflowRunId: record.workflowRunId,
    workflowId: record.workflowId,
    runNumber: record.runNumber,
    runAttempt: record.runAttempt,
    canRetry: record.canRetry,
    retryUnavailableReason: record.retryUnavailableReason,
    jobsJson: record.jobsJson,
    isCurrent: record.isCurrent,
  });
}

function snapshotSignature(snapshot: PipelineSnapshotRow): string {
  return JSON.stringify({
    repositoryNameWithOwner: snapshot.repositoryNameWithOwner,
    repositoryUrl: snapshot.repositoryUrl,
    pipelineStatus: snapshot.pipelineStatus,
    records: snapshot.records
      .map(recordSignature)
      .sort((left, right) => left.localeCompare(right)),
  });
}

function observationIdentity(observation: GitHubPipelineObservation): string {
  return pipelineIdentity({
    id: observation.id,
    checkSuiteId: observation.checkSuiteId,
    workflowRunId: observation.workflowRunId,
    statusContext: observation.statusContext,
  });
}

function observationFromRun(
  run: GitHubActionsWorkflowRunView,
  sourceValue: GitHubPipelineObservationSource,
  isCurrent = true,
): GitHubPipelineObservation {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    url: run.url,
    checkSuiteId: run.checkSuiteId,
    workflowRunId: run.id,
    workflowId: run.workflowId,
    runNumber: run.runNumber,
    runAttempt: run.runAttempt,
    canRetry: run.canRetry,
    retryUnavailableReason: run.retryUnavailableReason,
    source: sourceValue,
    githubUpdatedAt: new Date(run.updatedAt),
    sourceFetchedAt: new Date(),
    isCurrent,
  };
}

export class GitHubPipelineStatusService {
  private lastPrunedAt = 0;

  async snapshot(
    key: GitHubPipelineStatusKeyInput,
  ): Promise<GitHubPipelineStatusSnapshotView | null> {
    const prisma = await getPrismaClient();
    const row = await prisma.gitHubPipelineSnapshot.findUnique({
      where: {
        repositoryGithubId_headSha: {
          repositoryGithubId: key.repositoryGithubId.trim(),
          headSha: key.headSha.trim(),
        },
      },
      include: { records: true },
    });
    return row ? snapshotView(row as PipelineSnapshotRow) : null;
  }

  async snapshots(
    keys: GitHubPipelineStatusKeyInput[],
  ): Promise<GitHubPipelineStatusSnapshotView[]> {
    const normalized = keys
      .map((key) => ({
        repositoryGithubId: key.repositoryGithubId.trim(),
        headSha: key.headSha.trim(),
      }))
      .filter((key) => key.repositoryGithubId && key.headSha);
    if (normalized.length === 0) return [];
    const prisma = await getPrismaClient();
    const rows = await prisma.gitHubPipelineSnapshot.findMany({
      where: { OR: normalized },
      include: { records: true },
    });
    return (rows as PipelineSnapshotRow[]).map(snapshotView);
  }

  async records(
    keys: GitHubPipelineRecordKeyInput[],
  ): Promise<GitHubPipelineRecordView[]> {
    const normalized = keys
      .map((key) => ({
        repositoryGithubId: key.repositoryGithubId.trim(),
        workflowRunId: key.workflowRunId.trim(),
      }))
      .filter((key) => key.repositoryGithubId && key.workflowRunId);
    if (normalized.length === 0) return [];
    const prisma = await getPrismaClient();
    const rows = await prisma.gitHubPipelineRecord.findMany({
      where: {
        OR: normalized.map((key) => ({
          workflowRunId: key.workflowRunId,
          snapshot: { repositoryGithubId: key.repositoryGithubId },
        })),
      },
      include: { snapshot: { include: { records: true } } },
    });
    return rows.map((row) =>
      recordView(
        row.snapshot as unknown as PipelineSnapshotRow,
        row as unknown as PipelineRecordRow,
      ),
    );
  }

  async observeWorkflowRuns(
    runs: GitHubActionsWorkflowRunView[],
    sourceValue: GitHubPipelineObservationSource = "REST",
    isCurrent = true,
  ): Promise<Map<string, GitHubPipelineRecordView>> {
    const grouped = new Map<string, GitHubActionsWorkflowRunView[]>();
    for (const run of runs) {
      if (!run.repositoryGithubId || !run.headSha) continue;
      const key = `${run.repositoryGithubId}\u0000${run.headSha}`;
      const values = grouped.get(key) ?? [];
      values.push(run);
      grouped.set(key, values);
    }
    const result = new Map<string, GitHubPipelineRecordView>();
    for (const values of grouped.values()) {
      const first = values[0]!;
      await this.observeSnapshot({
        repositoryGithubId: first.repositoryGithubId,
        repositoryNameWithOwner: first.repositoryNameWithOwner,
        repositoryUrl: first.repositoryUrl,
        headSha: first.headSha,
        pipelines: values.map((run) =>
          observationFromRun(run, sourceValue, isCurrent),
        ),
      });
    }
    for (const record of await this.records(
      runs.map((run) => ({
        repositoryGithubId: run.repositoryGithubId,
        workflowRunId: run.id,
      })),
    )) {
      if (record.workflowRunId) result.set(record.workflowRunId, record);
    }
    return result;
  }

  async observeJobs(
    repositoryGithubId: string | null,
    workflowRunId: string,
    jobs: GitHubWorkflowJobView[],
    sourceValue: GitHubPipelineObservationSource = "REST",
    githubUpdatedAt: Date | null = null,
  ): Promise<GitHubPipelineRecordView | null> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubPipelineRecord.findFirst({
      where: {
        workflowRunId,
        ...(repositoryGithubId ? { snapshot: { repositoryGithubId } } : {}),
      },
      include: { snapshot: true },
      orderBy: [{ runAttempt: "desc" }, { sourceFetchedAt: "desc" }],
    });
    if (!existing) return null;
    const matchingJobs = jobs.filter(
      (job) =>
        job.runAttempt == null ||
        existing.runAttempt == null ||
        job.runAttempt === existing.runAttempt,
    );
    if (jobs.length > 0 && matchingJobs.length === 0) {
      return recordView(
        {
          ...existing.snapshot,
          records: [existing],
        } as unknown as PipelineSnapshotRow,
        existing as unknown as PipelineRecordRow,
      );
    }
    const observedJobs =
      sourceValue === "WEBHOOK"
        ? [
            ...new Map(
              [...parseJobs(existing.jobsJson), ...matchingJobs].map((job) => [
                job.id,
                job,
              ]),
            ).values(),
          ]
        : matchingJobs;
    const change = await this.observeSnapshot({
      repositoryGithubId: existing.snapshot.repositoryGithubId,
      repositoryNameWithOwner: existing.snapshot.repositoryNameWithOwner,
      repositoryUrl: existing.snapshot.repositoryUrl,
      headSha: existing.snapshot.headSha,
      pipelines: [
        {
          ...pipelineView(existing as unknown as PipelineRecordRow),
          source: sourceValue,
          jobs: observedJobs,
          githubUpdatedAt: githubUpdatedAt ?? existing.githubUpdatedAt,
          isCurrent: existing.isCurrent,
        },
      ],
    });
    return change.changedPipeline;
  }

  async optimisticByCheckSuite(
    repositoryGithubId: string,
    checkSuiteId: string,
    patch: { status: GitHubPipelineState; jobs?: GitHubWorkflowJobView[] },
  ): Promise<GitHubPipelineRecordView | null> {
    return this.optimisticRecord(
      { repositoryGithubId, checkSuiteId, workflowRunId: null },
      patch,
    );
  }

  async optimisticByWorkflowRun(
    repositoryGithubId: string | null,
    workflowRunId: string,
    patch: { status: GitHubPipelineState; jobs?: GitHubWorkflowJobView[] },
  ): Promise<GitHubPipelineRecordView | null> {
    return this.optimisticRecord(
      { repositoryGithubId, checkSuiteId: null, workflowRunId },
      patch,
    );
  }

  async optimisticJobByCheckSuite(
    repositoryGithubId: string,
    checkSuiteId: string,
    jobId: string,
  ): Promise<GitHubPipelineRecordView | null> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubPipelineRecord.findFirst({
      where: {
        checkSuiteId,
        snapshot: { repositoryGithubId },
      },
      orderBy: [{ runAttempt: "desc" }, { sourceFetchedAt: "desc" }],
    });
    if (!existing) return null;
    const jobs = parseJobs(existing.jobsJson).map((job) =>
      job.id === jobId
        ? {
            ...job,
            status: "QUEUED" as const,
            canRetry: false,
            retryUnavailableReason: "NOT_COMPLETED" as const,
          }
        : job,
    );
    return this.optimisticByCheckSuite(repositoryGithubId, checkSuiteId, {
      status: "QUEUED",
      jobs,
    });
  }

  async optimisticJobByWorkflowRun(
    repositoryGithubId: string | null,
    workflowRunId: string,
    jobId: string,
  ): Promise<GitHubPipelineRecordView | null> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubPipelineRecord.findFirst({
      where: {
        workflowRunId,
        ...(repositoryGithubId ? { snapshot: { repositoryGithubId } } : {}),
      },
      orderBy: [{ runAttempt: "desc" }, { sourceFetchedAt: "desc" }],
    });
    if (!existing) return null;
    const jobs = parseJobs(existing.jobsJson).map((job) =>
      job.id === jobId
        ? {
            ...job,
            status: "QUEUED" as const,
            canRetry: false,
            retryUnavailableReason: "NOT_COMPLETED" as const,
          }
        : job,
    );
    return this.optimisticByWorkflowRun(repositoryGithubId, workflowRunId, {
      status: "QUEUED",
      jobs,
    });
  }

  private async optimisticRecord(
    key: {
      repositoryGithubId: string | null;
      checkSuiteId: string | null;
      workflowRunId: string | null;
    },
    patch: { status: GitHubPipelineState; jobs?: GitHubWorkflowJobView[] },
  ): Promise<GitHubPipelineRecordView | null> {
    const prisma = await getPrismaClient();
    const existing = await prisma.gitHubPipelineRecord.findFirst({
      where: {
        ...(key.repositoryGithubId
          ? { snapshot: { repositoryGithubId: key.repositoryGithubId } }
          : {}),
        ...(key.checkSuiteId
          ? { checkSuiteId: key.checkSuiteId }
          : { workflowRunId: key.workflowRunId }),
      },
      include: { snapshot: true },
      orderBy: [{ runAttempt: "desc" }, { sourceFetchedAt: "desc" }],
    });
    if (!existing) return null;
    const now = new Date();
    const change = await this.observeSnapshot({
      repositoryGithubId: existing.snapshot.repositoryGithubId,
      repositoryNameWithOwner: existing.snapshot.repositoryNameWithOwner,
      repositoryUrl: existing.snapshot.repositoryUrl,
      headSha: existing.snapshot.headSha,
      pipelines: [
        {
          ...pipelineView(existing as unknown as PipelineRecordRow),
          status: patch.status,
          jobs: patch.jobs,
          source: "MUTATION",
          githubUpdatedAt: existing.githubUpdatedAt,
          sourceFetchedAt: now,
          optimisticUntil: new Date(
            now.getTime() + GITHUB_PIPELINE_OPTIMISTIC_MS,
          ),
          isCurrent: existing.isCurrent,
        },
      ],
    });
    return change.changedPipeline;
  }

  async observeSnapshot(
    input: ObserveGitHubPipelineSnapshotInput,
  ): Promise<GitHubPipelineStatusChangeView> {
    const repositoryGithubId = input.repositoryGithubId.trim();
    const headSha = input.headSha.trim();
    if (!repositoryGithubId || !headSha) {
      throw new Error("GitHub repository ID and head SHA are required");
    }
    const now = new Date();
    const sourceFetchedAt = input.sourceFetchedAt ?? now;
    const prisma = await getPrismaClient();
    const result = await prisma.$transaction(async (transaction) => {
      let snapshot = await transaction.gitHubPipelineSnapshot.upsert({
        where: {
          repositoryGithubId_headSha: { repositoryGithubId, headSha },
        },
        create: {
          id: randomUUID(),
          repositoryGithubId,
          repositoryNameWithOwner: input.repositoryNameWithOwner,
          repositoryUrl: input.repositoryUrl,
          headSha,
          pipelineStatus: "NONE",
          graphqlRollupStatus: null,
          revision: 0,
          lastGraphqlSyncAt: null,
          lastObservedAt: now,
        },
        update: { lastObservedAt: now },
        include: { records: true },
      });
      const before = snapshotSignature(snapshot as PipelineSnapshotRow);
      const membershipAccepted = Boolean(
        input.completeGraphqlRollup &&
        (!snapshot.lastGraphqlSyncAt ||
          sourceFetchedAt.getTime() >= snapshot.lastGraphqlSyncAt.getTime()),
      );
      const seen = new Set<string>();
      let changedRecordId: string | null = null;

      for (const observation of input.pipelines) {
        const identityKey = observationIdentity(observation);
        const records = await transaction.gitHubPipelineRecord.findMany({
          where: { snapshotId: snapshot.id },
        });
        const aliases = records.filter(
          (record) =>
            record.identityKey === identityKey ||
            (observation.checkSuiteId &&
              record.checkSuiteId === observation.checkSuiteId) ||
            (observation.workflowRunId &&
              record.workflowRunId === observation.workflowRunId),
        );
        let existing = aliases[0] ?? null;
        for (const candidate of aliases.slice(1)) {
          if (
            existing &&
            shouldReplacePipelineRecord(
              {
                runAttempt: existing.runAttempt,
                githubUpdatedAt: existing.githubUpdatedAt,
                source: source(existing.source),
                optimisticUntil: existing.optimisticUntil,
              },
              {
                runAttempt: candidate.runAttempt,
                githubUpdatedAt: candidate.githubUpdatedAt,
                source: source(candidate.source),
              },
              now,
            )
          ) {
            existing = candidate;
          }
        }
        for (const duplicate of aliases) {
          if (existing && duplicate.id !== existing.id) {
            if (
              parseJobs(existing.jobsJson).length === 0 &&
              parseJobs(duplicate.jobsJson).length > 0
            ) {
              existing = await transaction.gitHubPipelineRecord.update({
                where: { id: existing.id },
                data: { jobsJson: duplicate.jobsJson },
              });
            }
            await transaction.gitHubPipelineRecord.delete({
              where: { id: duplicate.id },
            });
            changedRecordId = existing.id;
          }
        }

        const incomingFetchedAt =
          observation.sourceFetchedAt ?? sourceFetchedAt;
        const incomingUpdatedAt = observation.githubUpdatedAt ?? null;
        const incomingAttempt = observation.runAttempt ?? null;
        const nextJobs =
          observation.jobs !== undefined
            ? JSON.stringify(observation.jobs)
            : existing && (incomingAttempt ?? 0) <= (existing.runAttempt ?? 0)
              ? existing.jobsJson
              : "[]";
        const nextCurrent = membershipAccepted
          ? true
          : observation.isCurrent === false
            ? (existing?.isCurrent ?? false)
            : (observation.isCurrent ?? existing?.isCurrent ?? true);

        if (!existing) {
          existing = await transaction.gitHubPipelineRecord.create({
            data: {
              id: randomUUID(),
              snapshotId: snapshot.id,
              identityKey,
              githubPipelineId: observation.id,
              name: observation.name,
              status: observation.status,
              url: observation.url ?? null,
              checkSuiteId: observation.checkSuiteId ?? null,
              workflowRunId: observation.workflowRunId ?? null,
              workflowId: observation.workflowId ?? null,
              runNumber: observation.runNumber ?? null,
              runAttempt: incomingAttempt,
              canRetry: observation.canRetry ?? false,
              retryUnavailableReason:
                observation.retryUnavailableReason ?? null,
              jobsJson: nextJobs,
              source: observation.source,
              githubUpdatedAt: incomingUpdatedAt,
              sourceFetchedAt: incomingFetchedAt,
              lastObservedAt: now,
              optimisticUntil: observation.optimisticUntil ?? null,
              isCurrent: nextCurrent,
            },
          });
          changedRecordId = existing.id;
        } else {
          seen.add(existing.id);
          const beforeRecord = recordSignature(
            existing as unknown as PipelineRecordRow,
          );
          const replace = shouldReplacePipelineRecord(
            {
              runAttempt: existing.runAttempt,
              githubUpdatedAt: existing.githubUpdatedAt,
              source: source(existing.source),
              optimisticUntil: existing.optimisticUntil,
            },
            {
              runAttempt: incomingAttempt,
              githubUpdatedAt: incomingUpdatedAt,
              source: observation.source,
            },
            now,
          );
          existing = await transaction.gitHubPipelineRecord.update({
            where: { id: existing.id },
            data: replace
              ? {
                  identityKey,
                  githubPipelineId: observation.id,
                  name: observation.name,
                  status: observation.status,
                  url: observation.url ?? null,
                  checkSuiteId: observation.checkSuiteId ?? null,
                  workflowRunId: observation.workflowRunId ?? null,
                  workflowId: observation.workflowId ?? null,
                  runNumber: observation.runNumber ?? null,
                  runAttempt: incomingAttempt,
                  canRetry: observation.canRetry ?? false,
                  retryUnavailableReason:
                    observation.retryUnavailableReason ?? null,
                  jobsJson: nextJobs,
                  source: observation.source,
                  githubUpdatedAt: incomingUpdatedAt,
                  sourceFetchedAt: incomingFetchedAt,
                  lastObservedAt: now,
                  optimisticUntil: observation.optimisticUntil ?? null,
                  isCurrent: nextCurrent,
                }
              : {
                  lastObservedAt: now,
                  ...(membershipAccepted ? { isCurrent: true } : {}),
                },
          });
          if (
            beforeRecord !==
            recordSignature(existing as unknown as PipelineRecordRow)
          ) {
            changedRecordId = existing.id;
          }
        }
        seen.add(existing.id);
      }

      if (membershipAccepted) {
        const candidates = await transaction.gitHubPipelineRecord.findMany({
          where: { snapshotId: snapshot.id, isCurrent: true },
        });
        for (const record of candidates) {
          if (
            !seen.has(record.id) &&
            record.sourceFetchedAt.getTime() <= sourceFetchedAt.getTime() &&
            (!record.optimisticUntil ||
              record.optimisticUntil.getTime() <= now.getTime())
          ) {
            await transaction.gitHubPipelineRecord.update({
              where: { id: record.id },
              data: { isCurrent: false },
            });
            changedRecordId ??= record.id;
          }
        }
      }

      const records = await transaction.gitHubPipelineRecord.findMany({
        where: { snapshotId: snapshot.id },
      });
      const graphqlRollupStatus = membershipAccepted
        ? (input.graphqlRollupStatus ?? null)
        : snapshot.graphqlRollupStatus;
      const pipelineStatus = aggregatePipelineStatus(
        records
          .filter((record) => record.isCurrent)
          .map((record) =>
            isPipelineState(record.status) ? record.status : "NONE",
          ),
        graphqlRollupStatus && isPipelineStatus(graphqlRollupStatus)
          ? graphqlRollupStatus
          : null,
      );
      snapshot = await transaction.gitHubPipelineSnapshot.update({
        where: { id: snapshot.id },
        data: {
          repositoryNameWithOwner: input.repositoryNameWithOwner,
          repositoryUrl: input.repositoryUrl,
          pipelineStatus,
          graphqlRollupStatus,
          lastGraphqlSyncAt: membershipAccepted
            ? sourceFetchedAt
            : snapshot.lastGraphqlSyncAt,
          lastObservedAt: now,
        },
        include: { records: true },
      });
      const after = snapshotSignature(snapshot as PipelineSnapshotRow);
      const changed = before !== after || changedRecordId !== null;
      if (changed) {
        snapshot = await transaction.gitHubPipelineSnapshot.update({
          where: { id: snapshot.id },
          data: { revision: { increment: 1 } },
          include: { records: true },
        });
      }
      const typedSnapshot = snapshot as PipelineSnapshotRow;
      const changedRecord = changedRecordId
        ? (typedSnapshot.records.find(
            (record) => record.id === changedRecordId,
          ) ?? null)
        : null;
      return {
        changed,
        change: {
          snapshot: snapshotView(typedSnapshot),
          changedPipeline: changedRecord
            ? recordView(typedSnapshot, changedRecord)
            : null,
        } satisfies GitHubPipelineStatusChangeView,
      };
    });

    if (result.changed) {
      agentEventBus.publish(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC, {
        githubPipelineStatusChanged: result.change,
      });
    }
    void this.pruneIfNeeded().catch(() => undefined);
    return result.change;
  }

  subscribe() {
    return agentEventBus.iterate<{
      githubPipelineStatusChanged: GitHubPipelineStatusChangeView;
    }>(GITHUB_PIPELINE_STATUS_CHANGED_TOPIC);
  }

  private async pruneIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrunedAt < 24 * 60 * 60 * 1_000) return;
    this.lastPrunedAt = now;
    const prisma = await getPrismaClient();
    await prisma.gitHubPipelineSnapshot.deleteMany({
      where: {
        lastObservedAt: {
          lt: new Date(now - GITHUB_PIPELINE_RETENTION_MS),
        },
      },
    });
  }
}
