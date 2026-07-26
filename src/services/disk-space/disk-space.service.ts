import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  BUILD_DATA_DELETE_JOB_KIND,
  buildDataDeletePayload,
} from "@ai-development-environment/agent-contract/build-data";
import {
  DEFAULT_DISK_SPACE_PRESSURE_THRESHOLD_GIB,
  DEFAULT_DISK_SPACE_THRESHOLD_GIB,
  DISK_SPACE_POLL_INTERVAL_SECONDS,
  DISK_SPACE_STALE_AFTER_SECONDS,
  parseAgentDiskSpaceReport,
  type AgentDiskSpaceEntryReport,
  type AgentDiskSpaceVolumeReport,
} from "@ai-development-environment/agent-contract/disk-space";

import { getPrismaClient } from "@/data/prisma-client";
import type { Agent } from "@/generated/prisma/client";
import {
  AgentControlService,
  agentOnlineWindowMs,
  agentEventBus,
  DISK_SPACE_CHANGED_TOPIC,
  POLLING_CHANGED_TOPIC,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";
import { worktreeDisplayPath } from "@/services/worktrees/worktrees.service";

import { executingResourcesByWorktree } from "./executing-work";

const GIB = 1024 ** 3;
const CLEANUP_LEASE_MS = 10 * 60_000;
const CLEANUP_JOB_TIMEOUT_SECONDS = 10 * 60;

type StoredEntry = AgentDiskSpaceEntryReport & {
  worktreeId: string | null;
  worktreePath: string | null;
};

export type DiskSpaceAgentStatus =
  | "DISABLED"
  | "STALE"
  | "IDLE"
  | "CLEANUP_REQUIRED"
  | "DELETING"
  | "PRESSURE"
  | "CRITICAL"
  | "ERROR";

export type DiskSpaceSettingsView = {
  normalThresholdGiB: number;
  pressureThresholdGiB: number;
  pollIntervalSeconds: number;
  staleAfterSeconds: number;
};

export type DiskSpaceVolumeView = AgentDiskSpaceVolumeReport & {
  status: DiskSpaceAgentStatus;
  effectiveThresholdBytes: number;
};

export type AgentDiskSpaceView = {
  agent: Agent;
  enabled: boolean;
  status: DiskSpaceAgentStatus;
  pressureMode: "NORMAL" | "MANUAL" | "AUTOMATIC";
  manualPressureMode: boolean;
  automaticPressureMode: boolean;
  lastReportedAt: string | null;
  lastError: string | null;
  warnings: string[];
  volumes: DiskSpaceVolumeView[];
};

function parseArray<T>(value: string | null | undefined): T[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function pathContains(folder: string, candidate: string): boolean {
  const normalized = folder === "/" ? folder : folder.replace(/\/+$/, "");
  return candidate === normalized || candidate.startsWith(`${normalized}/`);
}

function finiteThreshold(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) {
    throw new Error(`${label} must be a positive finite GiB value`);
  }
  return value;
}

function entryKey(agentId: string, path: string): string {
  return createHash("sha256")
    .update(agentId)
    .update("\0")
    .update(path)
    .digest("base64url");
}

export class DiskSpaceService {
  constructor(private readonly agentControl: AgentControlService) {
    this.agentControl.registerCompletionObserver((job) =>
      this.observeCompletion(job),
    );
  }

  async settings(): Promise<DiskSpaceSettingsView> {
    const prisma = await getPrismaClient();
    const row = await prisma.diskSpaceSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        normalThresholdGiB: DEFAULT_DISK_SPACE_THRESHOLD_GIB,
        pressureThresholdGiB: DEFAULT_DISK_SPACE_PRESSURE_THRESHOLD_GIB,
      },
      update: {},
    });
    return {
      normalThresholdGiB: row.normalThresholdGiB,
      pressureThresholdGiB: row.pressureThresholdGiB,
      pollIntervalSeconds: DISK_SPACE_POLL_INTERVAL_SECONDS,
      staleAfterSeconds: DISK_SPACE_STALE_AFTER_SECONDS,
    };
  }

  async updateSettings(input: {
    normalThresholdGiB: number;
    pressureThresholdGiB: number;
  }): Promise<DiskSpaceSettingsView> {
    const normalThresholdGiB = finiteThreshold(
      input.normalThresholdGiB,
      "Normal disk threshold",
    );
    const pressureThresholdGiB = finiteThreshold(
      input.pressureThresholdGiB,
      "Pressure disk threshold",
    );
    if (pressureThresholdGiB >= normalThresholdGiB) {
      throw new Error(
        "Pressure disk threshold must be lower than the normal threshold",
      );
    }
    const prisma = await getPrismaClient();
    await prisma.diskSpaceSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        normalThresholdGiB,
        pressureThresholdGiB,
      },
      update: { normalThresholdGiB, pressureThresholdGiB },
    });
    this.publish("settings");
    const agents = await prisma.agentDiskSpaceState.findMany({
      where: { enabled: true },
      select: { agentId: true },
    });
    for (const { agentId } of agents) void this.reconcileAgent(agentId);
    return this.settings();
  }

  async configuration(agentId: string) {
    const prisma = await getPrismaClient();
    const [agent, state, worktrees] = await Promise.all([
      prisma.agent.findUnique({ where: { id: agentId } }),
      prisma.agentDiskSpaceState.findUnique({ where: { agentId } }),
      prisma.worktree.findMany({
        where: { missingAt: null, codebase: { agentId } },
        select: { id: true, folder: true },
      }),
    ]);
    if (!agent) throw new Error("Agent not found");
    return {
      enabled: state?.enabled ?? true,
      pollIntervalSeconds: DISK_SPACE_POLL_INTERVAL_SECONDS,
      baseRepoDirectory: agent.baseRepoDirectory,
      derivedDataLocationMode: agent.derivedDataLocationMode,
      derivedDataPath: agent.derivedDataPath,
      worktrees,
    };
  }

  async report(agentId: string, raw: unknown): Promise<void> {
    const report = parseAgentDiskSpaceReport(raw);
    const prisma = await getPrismaClient();
    const [agent, worktrees] = await Promise.all([
      prisma.agent.findUnique({ where: { id: agentId } }),
      prisma.worktree.findMany({
        where: { missingAt: null, codebase: { agentId } },
        include: { codebase: { select: { agentId: true } } },
      }),
    ]);
    if (!agent) throw new Error("Agent not found");
    const observedAt = new Date(report.observedAt);
    const entries: StoredEntry[] = report.entries.map((entry) => {
      const worktree = entry.workspacePath
        ? worktrees
            .filter((candidate) =>
              pathContains(candidate.folder, entry.workspacePath!),
            )
            .sort(
              (first, second) => second.folder.length - first.folder.length,
            )[0]
        : null;
      return {
        ...entry,
        worktreeId: worktree?.id ?? null,
        worktreePath: worktree
          ? worktreeDisplayPath(worktree.folder, agent.baseRepoDirectory)
          : null,
      };
    });
    await prisma.agentDiskSpaceState.upsert({
      where: { agentId },
      create: {
        agentId,
        volumesJson: JSON.stringify(report.volumes),
        entriesJson: JSON.stringify(entries),
        warningsJson: JSON.stringify(report.warnings),
        lastReportedAt: observedAt,
        lastError: null,
      },
      update: {
        volumesJson: JSON.stringify(report.volumes),
        entriesJson: JSON.stringify(entries),
        warningsJson: JSON.stringify(report.warnings),
        lastReportedAt: observedAt,
        lastError: null,
      },
    });
    this.publish(agentId);
    void this.reconcileAgent(agentId);
  }

  async overview(): Promise<{
    settings: DiskSpaceSettingsView;
    agents: AgentDiskSpaceView[];
  }> {
    const prisma = await getPrismaClient();
    await prisma.derivedDataCleanupLease.deleteMany({
      where: { jobId: null, expiresAt: { lte: new Date() } },
    });
    const [settings, agents, leases] = await Promise.all([
      this.settings(),
      prisma.agent.findMany({
        orderBy: { name: "asc" },
        include: { diskSpaceState: true },
      }),
      prisma.derivedDataCleanupLease.findMany({
        select: { agentId: true },
      }),
    ]);
    const deleting = new Set(leases.map((lease) => lease.agentId));
    return {
      settings,
      agents: agents.map((agent) => {
        const state = agent.diskSpaceState;
        const enabled = state?.enabled ?? true;
        const manualPressureMode = state?.manualPressureMode ?? false;
        const automaticPressureMode = state?.automaticPressureMode ?? false;
        const pressureMode = manualPressureMode
          ? ("MANUAL" as const)
          : automaticPressureMode
            ? ("AUTOMATIC" as const)
            : ("NORMAL" as const);
        const lastReportedAt = state?.lastReportedAt ?? null;
        const stale =
          !lastReportedAt ||
          Date.now() - lastReportedAt.getTime() >
            settings.staleAfterSeconds * 1_000;
        const effectiveThresholdBytes =
          (manualPressureMode || automaticPressureMode
            ? settings.pressureThresholdGiB
            : settings.normalThresholdGiB) * GIB;
        const volumes = parseArray<AgentDiskSpaceVolumeReport>(
          state?.volumesJson,
        );
        const critical = volumes.some(
          (volume) => volume.freeBytes <= settings.pressureThresholdGiB * GIB,
        );
        const cleanupRequired = volumes.some(
          (volume) => volume.freeBytes < effectiveThresholdBytes,
        );
        let status: DiskSpaceAgentStatus = "IDLE";
        if (!enabled) status = "DISABLED";
        else if (stale) status = "STALE";
        else if (
          state?.lastError ||
          (volumes.length === 0 &&
            parseArray<string>(state?.warningsJson).length > 0)
        )
          status = "ERROR";
        else if (critical) status = "CRITICAL";
        else if (deleting.has(agent.id)) status = "DELETING";
        else if (manualPressureMode || automaticPressureMode)
          status = "PRESSURE";
        else if (cleanupRequired) status = "CLEANUP_REQUIRED";
        const volumeViews: DiskSpaceVolumeView[] = volumes.map((volume) => ({
          ...volume,
          effectiveThresholdBytes,
          status: !enabled
            ? "DISABLED"
            : stale
              ? "STALE"
              : volume.freeBytes <= settings.pressureThresholdGiB * GIB
                ? "CRITICAL"
                : deleting.has(agent.id) &&
                    volume.freeBytes < effectiveThresholdBytes
                  ? "DELETING"
                  : manualPressureMode || automaticPressureMode
                    ? "PRESSURE"
                    : volume.freeBytes < effectiveThresholdBytes
                      ? "CLEANUP_REQUIRED"
                      : "IDLE",
        }));
        return {
          agent,
          enabled,
          status,
          pressureMode,
          manualPressureMode,
          automaticPressureMode,
          lastReportedAt: lastReportedAt?.toISOString() ?? null,
          lastError: state?.lastError ?? null,
          warnings: parseArray<string>(state?.warningsJson),
          volumes: volumeViews,
        };
      }),
    };
  }

  async agentView(agentId: string): Promise<AgentDiskSpaceView> {
    const view = (await this.overview()).agents.find(
      (entry) => entry.agent.id === agentId,
    );
    if (!view) throw new Error("Agent not found");
    return view;
  }

  async setMonitoring(agentId: string, enabled: boolean) {
    const prisma = await getPrismaClient();
    await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    await prisma.agentDiskSpaceState.upsert({
      where: { agentId },
      create: { agentId, enabled },
      update: {
        enabled,
        ...(!enabled
          ? { manualPressureMode: false, automaticPressureMode: false }
          : {}),
      },
    });
    if (!enabled) {
      await prisma.derivedDataCleanupLease.deleteMany({
        where: { agentId, jobId: null },
      });
    }
    this.publish(agentId);
    this.agentControl.requestAgentConfigurationRefresh(agentId);
    return this.agentView(agentId);
  }

  async setManualPressureMode(agentId: string, enabled: boolean) {
    const prisma = await getPrismaClient();
    await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    await prisma.agentDiskSpaceState.upsert({
      where: { agentId },
      create: { agentId, manualPressureMode: enabled },
      update: { manualPressureMode: enabled },
    });
    this.publish(agentId);
    void this.reconcileAgent(agentId);
    return this.agentView(agentId);
  }

  async assertWorktreeCanStart(worktreeId: string): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.derivedDataCleanupLease.deleteMany({
      where: { worktreeId, jobId: null, expiresAt: { lte: new Date() } },
    });
    const [lease, worktree] = await Promise.all([
      prisma.derivedDataCleanupLease.findUnique({ where: { worktreeId } }),
      prisma.worktree.findUnique({
        where: { id: worktreeId },
        select: { codebase: { select: { agentId: true } } },
      }),
    ]);
    if (lease) {
      throw new Error(
        "Derived Data cleanup is in progress for this worktree; try again shortly",
      );
    }
    if (worktree) await this.assertAgentCanStart(worktree.codebase.agentId);
  }

  async assertAgentCanStart(agentId: string): Promise<void> {
    const prisma = await getPrismaClient();
    const [settings, state] = await Promise.all([
      this.settings(),
      prisma.agentDiskSpaceState.findUnique({ where: { agentId } }),
    ]);
    if (!state?.enabled || !state.lastReportedAt || state.lastError) return;
    if (
      Date.now() - state.lastReportedAt.getTime() >
      settings.staleAfterSeconds * 1_000
    ) {
      return;
    }
    const volumes = parseArray<AgentDiskSpaceVolumeReport>(state.volumesJson);
    if (
      volumes.some(
        (volume) => volume.freeBytes <= settings.pressureThresholdGiB * GIB,
      )
    ) {
      throw new Error(
        `New builds, plans, and sessions are paused because this agent has ${settings.pressureThresholdGiB} GiB or less free disk space`,
      );
    }
  }

  subscribe() {
    return agentEventBus.iterate(DISK_SPACE_CHANGED_TOPIC);
  }

  private async reconcileAgent(agentId: string): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.derivedDataCleanupLease.deleteMany({
      where: { jobId: null, expiresAt: { lte: new Date() } },
    });
    const [settings, state, locks, activeLease, agent] = await Promise.all([
      this.settings(),
      prisma.agentDiskSpaceState.findUnique({ where: { agentId } }),
      prisma.derivedDataLock.findMany({
        where: { agentId },
        select: { path: true },
      }),
      prisma.derivedDataCleanupLease.findFirst({
        where: { agentId },
      }),
      prisma.agent.findUnique({ where: { id: agentId } }),
    ]);
    if (
      !state?.enabled ||
      !state.lastReportedAt ||
      state.lastError ||
      activeLease ||
      !agent ||
      agent.disconnectedAt !== null ||
      agent.lastSeenAt === null ||
      Date.now() - agent.lastSeenAt.getTime() > agentOnlineWindowMs(agent) ||
      !parseArray<string>(agent.capabilitiesJson).includes(
        BUILD_DATA_DELETE_JOB_KIND,
      ) ||
      Date.now() - state.lastReportedAt.getTime() >
        settings.staleAfterSeconds * 1_000
    ) {
      return;
    }
    let entries = parseArray<StoredEntry>(state.entriesJson);
    const volumes = parseArray<AgentDiskSpaceVolumeReport>(state.volumesJson);
    const worktreeIds = entries
      .map((entry) => entry.worktreeId)
      .filter((id): id is string => Boolean(id));
    const active = await executingResourcesByWorktree(worktreeIds);
    const lockedPaths = new Set(locks.map((lock) => lock.path));
    entries = entries.filter(
      (entry) =>
        entry.kind === "PROJECT" &&
        Boolean(entry.worktreeId) &&
        !lockedPaths.has(entry.path) &&
        (active.get(entry.worktreeId!)?.length ?? 0) === 0,
    );

    const normalBytes = settings.normalThresholdGiB * GIB;
    const pressureBytes = settings.pressureThresholdGiB * GIB;
    const normalLow = volumes.filter(
      (volume) => volume.freeBytes < normalBytes,
    );
    const capacityId = (volume: AgentDiskSpaceVolumeReport) =>
      volume.capacityId ?? volume.id;
    const capacityByVolumeId = new Map(
      volumes.map((volume) => [volume.id, capacityId(volume)]),
    );
    const hasCandidate = (volume: AgentDiskSpaceVolumeReport) =>
      entries.some(
        (entry) =>
          capacityByVolumeId.get(entry.volumeId) === capacityId(volume),
      );
    let automaticPressureMode = state.automaticPressureMode;
    if (!state.manualPressureMode) {
      const shouldEnter =
        normalLow.length > 0 &&
        normalLow.some((volume) => !hasCandidate(volume));
      const shouldExit =
        automaticPressureMode &&
        (normalLow.length === 0 ||
          normalLow.every((volume) => hasCandidate(volume)));
      if (shouldEnter) automaticPressureMode = true;
      else if (shouldExit) automaticPressureMode = false;
      if (automaticPressureMode !== state.automaticPressureMode) {
        await prisma.agentDiskSpaceState.update({
          where: { agentId },
          data: { automaticPressureMode },
        });
        this.publish(agentId);
      }
    }

    const pressure = state.manualPressureMode || automaticPressureMode;
    const targetBytes = pressure ? pressureBytes : normalBytes;
    const lowCapacityIds = new Set(
      volumes
        .filter((volume) => volume.freeBytes < targetBytes)
        .map(capacityId),
    );
    const candidate = entries
      .filter((entry) =>
        lowCapacityIds.has(capacityByVolumeId.get(entry.volumeId) ?? ""),
      )
      .sort(
        (first, second) =>
          new Date(first.modifiedAt).getTime() -
            new Date(second.modifiedAt).getTime() ||
          first.path.localeCompare(second.path),
      )[0];
    if (!candidate?.worktreeId) return;

    try {
      await prisma.derivedDataCleanupLease.create({
        data: {
          worktreeId: candidate.worktreeId,
          agentId,
          path: candidate.path,
          source: "AUTOMATIC",
          expiresAt: new Date(Date.now() + CLEANUP_LEASE_MS),
        },
      });
    } catch {
      return;
    }
    const becameActive = await executingResourcesByWorktree([
      candidate.worktreeId,
    ]);
    if ((becameActive.get(candidate.worktreeId)?.length ?? 0) > 0) {
      await prisma.derivedDataCleanupLease.deleteMany({
        where: { worktreeId: candidate.worktreeId, jobId: null },
      });
      this.publish(agentId);
      return;
    }
    try {
      const job = await this.agentControl.createJob({
        agentId,
        kind: BUILD_DATA_DELETE_JOB_KIND,
        payload: {
          source: "AUTOMATIC",
          targets: [
            {
              path: candidate.path,
              rootPath: candidate.rootPath,
              name: candidate.name,
              kind: candidate.kind,
              worktreeId: candidate.worktreeId,
              worktreePath: candidate.worktreePath,
            },
          ],
        },
        idempotencyKey: `disk-space:auto:${entryKey(agentId, candidate.path)}:${randomUUID()}`,
        timeoutSeconds: CLEANUP_JOB_TIMEOUT_SECONDS,
        visibility: "SYSTEM",
      });
      await prisma.derivedDataCleanupLease.update({
        where: { worktreeId: candidate.worktreeId },
        data: { jobId: job.id },
      });
      this.publish(agentId);
    } catch (error) {
      await prisma.derivedDataCleanupLease.deleteMany({
        where: { worktreeId: candidate.worktreeId },
      });
      await prisma.agentDiskSpaceState.update({
        where: { agentId },
        data: {
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      this.publish(agentId);
    }
  }

  private async observeCompletion(job: {
    id: string;
    agentId: string;
    kind: string;
    payloadJson: string;
    status: string;
    error: string | null;
  }): Promise<void> {
    if (job.kind !== BUILD_DATA_DELETE_JOB_KIND) return;
    let source = "USER";
    try {
      source = buildDataDeletePayload(JSON.parse(job.payloadJson)).source;
    } catch {
      // BuildDataService records malformed results; leases still need release.
    }
    const prisma = await getPrismaClient();
    const released = await prisma.derivedDataCleanupLease.deleteMany({
      where: { jobId: job.id },
    });
    if (source === "AUTOMATIC" && job.status !== "SUCCEEDED") {
      await prisma.agentDiskSpaceState.updateMany({
        where: { agentId: job.agentId },
        data: {
          lastError: job.error || "Automatic Derived Data cleanup failed",
        },
      });
    }
    if (released.count || source === "AUTOMATIC") {
      this.publish(job.agentId);
      this.agentControl.requestDiskSpacePoll(job.agentId);
    }
  }

  private publish(id: string): void {
    agentEventBus.publish(DISK_SPACE_CHANGED_TOPIC, {
      diskSpaceChanged: id,
    });
    agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {
      sidebarStatusChanged: true,
    });
    agentEventBus.publish(POLLING_CHANGED_TOPIC, {
      pollingOperationChanged: `agent-disk-space:${id}`,
    });
  }
}
