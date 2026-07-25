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
    volumes { id totalBytes freeBytes roles paths status effectiveThresholdBytes }
  }
`;

export const AGENT_DISK_SPACE_FIELDS = `
  agent { id name hostname connectionStatus }
  enabled status pressureMode manualPressureMode automaticPressureMode
  lastReportedAt lastError warnings
  volumes { id totalBytes freeBytes roles paths status effectiveThresholdBytes }
`;

export function mostConstrainedVolume(
  agent: AgentDiskSpace,
): DiskSpaceVolume | null {
  return (
    [...agent.volumes].sort(
      (first, second) =>
        first.freeBytes / Math.max(first.effectiveThresholdBytes, 1) -
        second.freeBytes / Math.max(second.effectiveThresholdBytes, 1),
    )[0] ?? null
  );
}
