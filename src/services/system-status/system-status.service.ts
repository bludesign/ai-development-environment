import "server-only";

import { randomUUID } from "node:crypto";

import {
  CCUSAGE_REPORT_JOB_KIND,
  parseCcusageJobResult,
} from "@ai-development-environment/agent-contract";

import { aggregateUsage } from "@/components/usage/aggregate-usage";
import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";
import type { CcusageService } from "@/services/ccusage";
import type { CcusageCollectionSnapshot } from "@/services/ccusage";
import type { DiskSpaceService } from "@/services/disk-space";
import type { PollingService } from "@/services/polling";

const USAGE_POLL_SECONDS = 5 * 60;

function localDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class SystemStatusService {
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private usageRunning = false;

  constructor(
    private readonly ccusage: CcusageService,
    private readonly diskSpace: DiskSpaceService,
    private readonly polling: PollingService,
  ) {
    this.ccusage.registerCompletionObserver((snapshot) =>
      this.recordCompletedUsage(snapshot),
    );
  }

  private async recordCompletedUsage(
    snapshot: CcusageCollectionSnapshot,
  ): Promise<void> {
    if (snapshot.progress.successfulCount === 0) return;
    const period = localDay();
    const today = snapshot.aggregate.days.find((day) => day.period === period);
    await this.persistUsage(period, today?.totalCost ?? 0, new Date());
  }

  startRuntime(): void {
    this.polling.register({
      id: "sidebar-usage",
      kind: "SIDEBAR_USAGE",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: USAGE_POLL_SECONDS,
      details: {},
    });
    void this.pruneInterruptedCollections()
      .catch((error) => {
        console.error(
          "Sidebar usage cleanup failed:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => void this.runUsagePoll());
  }

  stopRuntime(): void {
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = undefined;
  }

  private scheduleUsagePoll(): void {
    if (this.usageTimer) clearTimeout(this.usageTimer);
    const next = new Date(Date.now() + USAGE_POLL_SECONDS * 1_000);
    this.polling.schedule("sidebar-usage", next);
    this.usageTimer = setTimeout(
      () => void this.runUsagePoll(),
      USAGE_POLL_SECONDS * 1_000,
    );
    this.usageTimer.unref();
  }

  private async runUsagePoll(): Promise<void> {
    if (this.usageRunning) return;
    this.usageRunning = true;
    this.polling.schedule("sidebar-usage", null);
    try {
      await this.polling.run(
        "sidebar-usage",
        () => this.collectUsage(),
        (result) => ({
          period: result.period,
          successfulAgents: result.successfulAgents,
        }),
      );
    } catch (error) {
      console.error(
        "Sidebar usage refresh failed:",
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.usageRunning = false;
      this.scheduleUsagePoll();
    }
  }

  private async collectUsage(): Promise<{
    period: string;
    successfulAgents: number;
  }> {
    const id = `sidebar-usage:${randomUUID()}`;
    try {
      const snapshot = await this.ccusage.collect(id);
      const period = localDay();
      return { period, successfulAgents: snapshot.progress.successfulCount };
    } finally {
      await this.removeCollection(id);
    }
  }

  private async persistUsage(
    period: string,
    totalCost: number,
    collectedAt: Date,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.sidebarUsageSummary.upsert({
      where: { id: "default" },
      create: { id: "default", period, totalCost, collectedAt },
      update: { period, totalCost, collectedAt },
    });
    this.publish();
  }

  private async latestSuccessfulUsage(period: string): Promise<{
    totalCost: number;
    collectedAt: Date;
  } | null> {
    const prisma = await getPrismaClient();
    const jobs = await prisma.agentJob.findMany({
      where: {
        kind: CCUSAGE_REPORT_JOB_KIND,
        status: "SUCCEEDED",
        resultJson: { not: null },
      },
      orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
      distinct: ["agentId"],
      select: {
        resultJson: true,
        finishedAt: true,
        createdAt: true,
        agent: { select: { id: true, name: true, hostname: true } },
      },
    });
    const reports = jobs.flatMap((job) => {
      try {
        const result = parseCcusageJobResult(JSON.parse(job.resultJson!));
        return [{ agent: job.agent, report: result.report }];
      } catch {
        return [];
      }
    });
    if (!reports.length) return null;
    const today = aggregateUsage(reports).days.find(
      (day) => day.period === period,
    );
    if (!today) return null;
    return {
      totalCost: today.totalCost,
      collectedAt: jobs.reduce((latest, job) => {
        const completedAt = job.finishedAt ?? job.createdAt;
        return completedAt > latest ? completedAt : latest;
      }, new Date(0)),
    };
  }

  private async removeCollection(id: string): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.agentJob.deleteMany({ where: { ccusageCollectionId: id } });
    await prisma.ccusageCollection.deleteMany({ where: { id } });
  }

  private async pruneInterruptedCollections(): Promise<void> {
    const prisma = await getPrismaClient();
    const collections = await prisma.ccusageCollection.findMany({
      where: { id: { startsWith: "sidebar-usage:" } },
      select: { id: true },
    });
    if (!collections.length) return;
    const ids = collections.map(({ id }) => id);
    await prisma.agentJob.deleteMany({
      where: { ccusageCollectionId: { in: ids } },
    });
    await prisma.ccusageCollection.deleteMany({ where: { id: { in: ids } } });
  }

  async status() {
    const prisma = await getPrismaClient();
    const period = localDay();
    const [
      storedUsage,
      plans,
      sessions,
      builds,
      workflows,
      commands,
      diskSpace,
    ] = await Promise.all([
      prisma.sidebarUsageSummary.findUnique({ where: { id: "default" } }),
      prisma.agentRun.count({
        where: {
          kind: "PLAN",
          archivedAt: null,
          status: "IN_PROGRESS",
          attempts: {
            some: {
              status: { in: ["STARTING", "RUNNING"] },
              supersededAt: null,
            },
          },
        },
      }),
      prisma.agentRun.count({
        where: {
          kind: "SESSION",
          archivedAt: null,
          status: "IN_PROGRESS",
          attempts: {
            some: {
              status: { in: ["STARTING", "RUNNING"] },
              supersededAt: null,
            },
          },
        },
      }),
      prisma.build.count({
        where: { status: { in: ["PREPARING", "RUNNING"] } },
      }),
      prisma.workflowRun.count({
        where: { archivedAt: null, status: "RUNNING" },
      }),
      prisma.commandRun.count({
        where: { archivedAt: null, status: "RUNNING" },
      }),
      this.diskSpace.overview(),
    ]);
    let usageToday =
      storedUsage?.period === period
        ? {
            totalCost: storedUsage.totalCost,
            collectedAt: storedUsage.collectedAt,
          }
        : null;
    if (!usageToday) {
      const recovered = await this.latestSuccessfulUsage(period);
      if (recovered) {
        usageToday = recovered;
        void this.persistUsage(
          period,
          recovered.totalCost,
          recovered.collectedAt,
        );
      }
      void this.runUsagePoll();
    }
    return {
      usageToday: {
        totalCost: usageToday?.totalCost ?? null,
        collectedAt: usageToday?.collectedAt.toISOString() ?? null,
      },
      activity: { plans, sessions, builds, workflows, commands },
      diskSpace,
    };
  }

  subscribe() {
    return agentEventBus.iterate(SIDEBAR_STATUS_CHANGED_TOPIC);
  }

  private publish(): void {
    agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
      sidebarStatusChanged: true,
    });
  }
}
