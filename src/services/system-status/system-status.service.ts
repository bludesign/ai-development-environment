import "server-only";

import { randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";
import type { CcusageService } from "@/services/ccusage";
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
  ) {}

  startRuntime(): void {
    this.polling.register({
      id: "sidebar-usage",
      kind: "SIDEBAR_USAGE",
      runtime: "SERVER",
      enabled: true,
      cadenceSeconds: USAGE_POLL_SECONDS,
      details: {},
    });
    void this.pruneInterruptedCollections().finally(() => this.runUsagePoll());
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
    const snapshot = await this.ccusage.collect(id);
    const period = localDay();
    if (snapshot.progress.successfulCount > 0) {
      const today = snapshot.aggregate.days.find(
        (day) => day.period === period,
      );
      const prisma = await getPrismaClient();
      await prisma.sidebarUsageSummary.upsert({
        where: { id: "default" },
        create: {
          id: "default",
          period,
          totalCost: today?.totalCost ?? 0,
          collectedAt: new Date(),
        },
        update: {
          period,
          totalCost: today?.totalCost ?? 0,
          collectedAt: new Date(),
        },
      });
      this.publish();
    }
    await this.removeCollection(id);
    return { period, successfulAgents: snapshot.progress.successfulCount };
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
    const [usage, plans, sessions, builds, workflows, diskSpace] =
      await Promise.all([
        prisma.sidebarUsageSummary.findUnique({ where: { id: "default" } }),
        prisma.agentRun.count({
          where: {
            kind: "PLAN",
            archivedAt: null,
            status: { in: ["IN_PROGRESS", "PAUSED"] },
          },
        }),
        prisma.agentRun.count({
          where: {
            kind: "SESSION",
            archivedAt: null,
            status: { in: ["IN_PROGRESS", "PAUSED"] },
          },
        }),
        prisma.build.count({
          where: { status: { in: ["QUEUED", "PREPARING", "RUNNING"] } },
        }),
        prisma.workflowRun.count({
          where: {
            archivedAt: null,
            status: {
              in: [
                "QUEUED",
                "RUNNING",
                "PAUSING",
                "PAUSED",
                "WAITING",
                "BLOCKED",
              ],
            },
          },
        }),
        this.diskSpace.overview(),
      ]);
    const currentUsage = usage?.period === localDay() ? usage : null;
    return {
      usageToday: {
        totalCost: currentUsage?.totalCost ?? null,
        collectedAt: currentUsage?.collectedAt.toISOString() ?? null,
      },
      activity: { plans, sessions, builds, workflows },
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
