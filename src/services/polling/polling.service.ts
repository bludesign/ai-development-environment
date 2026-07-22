import "server-only";

import {
  DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS,
} from "@ai-development-environment/agent-contract";
import { getPrismaClient } from "@/data/prisma-client";
import {
  agentOnlineWindowMs,
  agentEventBus,
  POLLING_CHANGED_TOPIC,
} from "@/services/agent-control";

export type PollingOperationStatus =
  "DISABLED" | "HEALTHY" | "RUNNING" | "STALE" | "ERROR";

export type PollingOperationView = {
  id: string;
  kind: string;
  runtime: "SERVER" | "AGENT";
  status: PollingOperationStatus;
  enabled: boolean;
  cadenceSeconds: number | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastSucceededAt: string | null;
  nextScheduledAt: string | null;
  durationMs: number | null;
  lastError: string | null;
  details: Record<string, unknown>;
};

type ServerOperation = Omit<
  PollingOperationView,
  | "status"
  | "lastStartedAt"
  | "lastCompletedAt"
  | "lastSucceededAt"
  | "nextScheduledAt"
  | "durationMs"
  | "lastError"
> & {
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastSucceededAt: Date | null;
  nextScheduledAt: Date | null;
  durationMs: number | null;
  lastError: string | null;
};

const iso = (value: Date | null) => value?.toISOString() ?? null;

function derivedStatus(
  enabled: boolean,
  running: boolean,
  cadenceSeconds: number | null,
  lastCompletedAt: Date | null,
  lastError: string | null,
): PollingOperationStatus {
  if (!enabled) return "DISABLED";
  if (running) return "RUNNING";
  if (lastError) return "ERROR";
  if (cadenceSeconds && !lastCompletedAt) return "STALE";
  if (
    cadenceSeconds &&
    lastCompletedAt &&
    Date.now() - lastCompletedAt.getTime() > cadenceSeconds * 2_000 + 5_000
  ) {
    return "STALE";
  }
  return "HEALTHY";
}

export class PollingService {
  private readonly operations = new Map<string, ServerOperation>();

  register(
    input: Pick<
      PollingOperationView,
      "id" | "kind" | "runtime" | "enabled" | "cadenceSeconds" | "details"
    >,
  ): void {
    const current = this.operations.get(input.id);
    this.operations.set(input.id, {
      ...input,
      lastStartedAt: current?.lastStartedAt ?? null,
      lastCompletedAt: current?.lastCompletedAt ?? null,
      lastSucceededAt: current?.lastSucceededAt ?? null,
      nextScheduledAt: current?.nextScheduledAt ?? null,
      durationMs: current?.durationMs ?? null,
      lastError: current?.lastError ?? null,
    });
    this.changed(input.id);
  }

  configure(
    id: string,
    input: Partial<
      Pick<PollingOperationView, "enabled" | "cadenceSeconds" | "details">
    >,
  ): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    Object.assign(operation, input);
    if (!operation.enabled) operation.nextScheduledAt = null;
    this.changed(id);
  }

  schedule(id: string, nextScheduledAt: Date | null): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.nextScheduledAt = nextScheduledAt;
    this.changed(id);
  }

  async run<T>(
    id: string,
    operation: () => Promise<T>,
    details?: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    const entry = this.operations.get(id);
    if (!entry) throw new Error(`Polling operation ${id} is not registered`);
    const startedAt = new Date();
    entry.lastStartedAt = startedAt;
    entry.lastError = null;
    this.changed(id);
    try {
      const result = await operation();
      const completedAt = new Date();
      entry.lastCompletedAt = completedAt;
      entry.lastSucceededAt = completedAt;
      entry.durationMs = completedAt.getTime() - startedAt.getTime();
      entry.lastError = null;
      if (details) entry.details = { ...entry.details, ...details(result) };
      return result;
    } catch (error) {
      const completedAt = new Date();
      entry.lastCompletedAt = completedAt;
      entry.durationMs = completedAt.getTime() - startedAt.getTime();
      entry.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.changed(id);
    }
  }

  private changed(id: string): void {
    agentEventBus.publish(POLLING_CHANGED_TOPIC, {
      pollingOperationChanged: id,
    });
  }

  subscribe() {
    return agentEventBus.iterate<{ pollingOperationChanged: string }>(
      POLLING_CHANGED_TOPIC,
    );
  }

  private serverViews(): PollingOperationView[] {
    return [...this.operations.values()].map((operation) => ({
      ...operation,
      status: derivedStatus(
        operation.enabled,
        Boolean(
          operation.lastStartedAt &&
          (!operation.lastCompletedAt ||
            operation.lastStartedAt > operation.lastCompletedAt),
        ),
        operation.cadenceSeconds,
        operation.lastCompletedAt,
        operation.lastError,
      ),
      lastStartedAt: iso(operation.lastStartedAt),
      lastCompletedAt: iso(operation.lastCompletedAt),
      lastSucceededAt: iso(operation.lastSucceededAt),
      nextScheduledAt: iso(operation.nextScheduledAt),
    }));
  }

  async list(): Promise<PollingOperationView[]> {
    const prisma = await getPrismaClient();
    const [settings, agents, jobs] = await Promise.all([
      prisma.codebaseSettings.findUnique({ where: { id: "default" } }),
      prisma.agent.findMany({
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          lastSeenAt: true,
          disconnectedAt: true,
          codebaseScanIntervalSeconds: true,
          jobReconciliationIntervalSeconds: true,
          gitFetchIntervalSeconds: true,
          heartbeatIntervalSeconds: true,
          codebases: {
            select: {
              lastCheckedAt: true,
              lastFetchedAt: true,
              lastFetchAttemptAt: true,
              lastFetchError: true,
            },
          },
        },
      }),
      prisma.agentJob.groupBy({
        by: ["agentId", "status"],
        where: { status: { in: ["QUEUED", "RUNNING"] } },
        _count: { _all: true },
      }),
    ]);
    const refreshSeconds = settings?.refreshIntervalSeconds ?? 30;
    const fetchSeconds = settings?.fetchIntervalSeconds ?? 300;
    const jobCounts = new Map<string, number>();
    for (const group of jobs) {
      jobCounts.set(
        group.agentId,
        (jobCounts.get(group.agentId) ?? 0) + group._count._all,
      );
    }
    const agentViews: PollingOperationView[] = [];
    for (const agent of agents) {
      const heartbeatSeconds =
        agent.heartbeatIntervalSeconds ??
        DEFAULT_AGENT_HEARTBEAT_INTERVAL_SECONDS;
      const jobReconciliationSeconds =
        agent.jobReconciliationIntervalSeconds ??
        DEFAULT_AGENT_JOB_RECONCILIATION_INTERVAL_SECONDS;
      const scanSeconds = agent.codebaseScanIntervalSeconds ?? refreshSeconds;
      const agentFetchSeconds = agent.gitFetchIntervalSeconds ?? fetchSeconds;
      const online =
        agent.lastSeenAt !== null &&
        agent.disconnectedAt === null &&
        Date.now() - agent.lastSeenAt.getTime() <= agentOnlineWindowMs(agent);
      agentViews.push({
        id: `agent-heartbeat:${agent.id}`,
        kind: "AGENT_HEARTBEAT",
        runtime: "AGENT",
        status: online ? "HEALTHY" : "STALE",
        enabled: true,
        cadenceSeconds: heartbeatSeconds,
        lastStartedAt: null,
        lastCompletedAt: iso(agent.lastSeenAt),
        lastSucceededAt: iso(agent.lastSeenAt),
        nextScheduledAt: agent.lastSeenAt
          ? new Date(
              agent.lastSeenAt.getTime() + heartbeatSeconds * 1_000,
            ).toISOString()
          : null,
        durationMs: null,
        lastError: null,
        details: {
          agentId: agent.id,
          agentName: agent.name,
          connection: online ? "ONLINE" : "OFFLINE",
        },
      });
      agentViews.push({
        id: `agent-job-reconciliation:${agent.id}`,
        kind: "AGENT_JOB_RECONCILIATION",
        runtime: "AGENT",
        status: online ? "HEALTHY" : "STALE",
        enabled: true,
        cadenceSeconds: jobReconciliationSeconds,
        lastStartedAt: null,
        lastCompletedAt: iso(agent.lastSeenAt),
        lastSucceededAt: iso(agent.lastSeenAt),
        nextScheduledAt: agent.lastSeenAt
          ? new Date(
              agent.lastSeenAt.getTime() + jobReconciliationSeconds * 1_000,
            ).toISOString()
          : null,
        durationMs: null,
        lastError: null,
        details: {
          agentId: agent.id,
          agentName: agent.name,
          pendingJobs: jobCounts.get(agent.id) ?? 0,
        },
      });
      const checks = agent.codebases
        .map((codebase) => codebase.lastCheckedAt)
        .filter((value): value is Date => value !== null);
      const lastCheck =
        checks.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const fetches = agent.codebases
        .map(
          (codebase) => codebase.lastFetchAttemptAt ?? codebase.lastFetchedAt,
        )
        .filter((value): value is Date => value !== null);
      const lastFetch =
        fetches.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const fetchErrors = agent.codebases.filter(
        (codebase) => codebase.lastFetchError,
      ).length;
      agentViews.push({
        id: `agent-codebase-scan:${agent.id}`,
        kind: "CODEBASE_SCAN",
        runtime: "AGENT",
        status: derivedStatus(
          agent.codebases.length > 0,
          false,
          scanSeconds,
          lastCheck,
          null,
        ),
        enabled: agent.codebases.length > 0,
        cadenceSeconds: scanSeconds,
        lastStartedAt: null,
        lastCompletedAt: iso(lastCheck),
        lastSucceededAt: iso(lastCheck),
        nextScheduledAt: lastCheck
          ? new Date(lastCheck.getTime() + scanSeconds * 1_000).toISOString()
          : null,
        durationMs: null,
        lastError: null,
        details: {
          agentId: agent.id,
          agentName: agent.name,
          repositories: agent.codebases.length,
        },
      });
      agentViews.push({
        id: `agent-git-fetch:${agent.id}`,
        kind: "GIT_FETCH",
        runtime: "AGENT",
        status:
          fetchErrors > 0
            ? "ERROR"
            : derivedStatus(
                agent.codebases.length > 0,
                false,
                agentFetchSeconds,
                lastFetch,
                null,
              ),
        enabled: agent.codebases.length > 0,
        cadenceSeconds: agentFetchSeconds,
        lastStartedAt: null,
        lastCompletedAt: iso(lastFetch),
        lastSucceededAt: fetchErrors > 0 ? null : iso(lastFetch),
        nextScheduledAt: lastFetch
          ? new Date(
              lastFetch.getTime() + agentFetchSeconds * 1_000,
            ).toISOString()
          : null,
        durationMs: null,
        lastError:
          fetchErrors > 0
            ? `${fetchErrors} repositories have fetch errors`
            : null,
        details: {
          agentId: agent.id,
          agentName: agent.name,
          repositories: agent.codebases.length,
          fetchErrors,
        },
      });
    }
    return [...this.serverViews(), ...agentViews];
  }
}
