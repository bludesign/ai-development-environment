import { agentOnlineWindowMs } from "@/services/agent-control";

import type {
  AgentDiskSpaceView,
  DiskSpaceSettingsView,
  DiskSpaceVolumeView,
} from "./disk-space.service";

const GIB = 1024 ** 3;

export type DiskSpaceSessionVolume = DiskSpaceVolumeView;

export type DiskSpaceSessionData = {
  agent: {
    id: string;
    name: string;
    hostname: string;
    connected: boolean;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
  };
  codebase: { agentId: string };
  disk: {
    enabled: boolean;
    status: AgentDiskSpaceView["status"];
    pressureMode: AgentDiskSpaceView["pressureMode"];
    manualPressureMode: boolean;
    automaticPressureMode: boolean;
    lastReportedAt: string | null;
    lastError: string | null;
    warnings: string[];
    monitoredVolumeId: string | null;
    freeBytes: number | null;
    totalBytes: number | null;
    freeGiB: number | null;
    freePercent: number | null;
    usedPercent: number | null;
    effectiveThresholdBytes: number | null;
    normalThresholdGiB: number;
    pressureThresholdGiB: number;
    pollIntervalSeconds: number;
    staleAfterSeconds: number;
    changeReason: string | null;
    volumes: DiskSpaceSessionVolume[];
  };
};

/**
 * Projects the monitor's canonical agent snapshot for workflow session data and
 * built-in MCP tools. The summary metrics always describe the monitored
 * Derived Data volume with the least free space; inventory/root-disk metrics
 * remain available separately under `agent.*` for compatibility.
 */
export function diskSpaceSessionData(
  settings: DiskSpaceSettingsView,
  view: AgentDiskSpaceView,
  changeReason: string | null = null,
): DiskSpaceSessionData {
  const monitored = [...view.volumes]
    .filter((volume) => volume.monitored)
    .sort(
      (first, second) =>
        first.freeBytes - second.freeBytes || first.id.localeCompare(second.id),
    )[0];
  const freePercent =
    monitored && monitored.totalBytes > 0
      ? (monitored.freeBytes / monitored.totalBytes) * 100
      : null;
  const connected =
    view.agent.disconnectedAt === null &&
    view.agent.lastSeenAt !== null &&
    Date.now() - view.agent.lastSeenAt.getTime() <=
      agentOnlineWindowMs(view.agent);

  return {
    agent: {
      id: view.agent.id,
      name: view.agent.name,
      hostname: view.agent.hostname,
      connected,
      diskTotalBytes: view.agent.diskTotalBytes,
      diskFreeBytes: view.agent.diskFreeBytes,
    },
    codebase: { agentId: view.agent.id },
    disk: {
      enabled: view.enabled,
      status: view.status,
      pressureMode: view.pressureMode,
      manualPressureMode: view.manualPressureMode,
      automaticPressureMode: view.automaticPressureMode,
      lastReportedAt: view.lastReportedAt,
      lastError: view.lastError,
      warnings: [...view.warnings],
      monitoredVolumeId: monitored?.id ?? null,
      freeBytes: monitored?.freeBytes ?? null,
      totalBytes: monitored?.totalBytes ?? null,
      freeGiB: monitored ? monitored.freeBytes / GIB : null,
      freePercent,
      usedPercent: freePercent === null ? null : 100 - freePercent,
      effectiveThresholdBytes: monitored?.effectiveThresholdBytes ?? null,
      normalThresholdGiB: settings.normalThresholdGiB,
      pressureThresholdGiB: settings.pressureThresholdGiB,
      pollIntervalSeconds: settings.pollIntervalSeconds,
      staleAfterSeconds: settings.staleAfterSeconds,
      changeReason,
      volumes: view.volumes.map((volume) => ({ ...volume })),
    },
  };
}

export function diskSpaceStateCursor(
  sessionData: DiskSpaceSessionData,
): Record<string, unknown> {
  return {
    enabled: sessionData.disk.enabled,
    status: sessionData.disk.status,
    pressureMode: sessionData.disk.pressureMode,
    lastError: sessionData.disk.lastError,
    warnings: sessionData.disk.warnings,
    monitoredVolumeId: sessionData.disk.monitoredVolumeId,
  };
}
