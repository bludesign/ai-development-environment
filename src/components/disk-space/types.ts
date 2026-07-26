import type { Agent } from "@/components/agents/types";

export type DiskSpaceStatus =
  | "DISABLED"
  | "STALE"
  | "IDLE"
  | "CLEANUP_REQUIRED"
  | "DELETING"
  | "PRESSURE"
  | "CRITICAL"
  | "ERROR";

export type DiskSpaceVolume = {
  id: string;
  totalBytes: number;
  freeBytes: number;
  roles: Array<"MAIN" | "BASE_REPO" | "DERIVED_DATA">;
  paths: string[];
  status: DiskSpaceStatus;
  effectiveThresholdBytes: number;
  monitored: boolean;
};

export type AgentDiskSpace = {
  agent: Agent;
  enabled: boolean;
  status: DiskSpaceStatus;
  pressureMode: "NORMAL" | "MANUAL" | "AUTOMATIC";
  manualPressureMode: boolean;
  automaticPressureMode: boolean;
  lastReportedAt: string | null;
  lastError: string | null;
  warnings: string[];
  volumes: DiskSpaceVolume[];
};

export type DiskSpaceOverview = {
  settings: {
    normalThresholdGiB: number;
    pressureThresholdGiB: number;
    pollIntervalSeconds: number;
    staleAfterSeconds: number;
  };
  agents: AgentDiskSpace[];
};

export const DISK_SPACE_FIELDS = `
  settings { normalThresholdGiB pressureThresholdGiB pollIntervalSeconds staleAfterSeconds }
  agents {
    agent { id name hostname connectionStatus }
    enabled status pressureMode manualPressureMode automaticPressureMode
    lastReportedAt lastError warnings
    volumes { id totalBytes freeBytes roles paths status effectiveThresholdBytes monitored }
  }
`;

export const AGENT_DISK_SPACE_FIELDS = `
  agent { id name hostname connectionStatus }
  enabled status pressureMode manualPressureMode automaticPressureMode
  lastReportedAt lastError warnings
  volumes { id totalBytes freeBytes roles paths status effectiveThresholdBytes monitored }
`;

/**
 * The volume the free-space indicators represent: the Derived Data volume,
 * which is the only one monitoring acts on. Agents reporting Derived Data
 * across several volumes fall back to the one with the least free space.
 */
export function monitoredVolume(agent: AgentDiskSpace): DiskSpaceVolume | null {
  return (
    agent.volumes
      .filter((volume) => volume.monitored)
      .sort((first, second) => first.freeBytes - second.freeBytes)[0] ?? null
  );
}
