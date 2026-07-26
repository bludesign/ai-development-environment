import * as z from "zod/v4";

import {
  diskSpaceSessionData,
  type DiskSpaceService,
} from "@/services/disk-space";

import {
  READ_ONLY_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  defineTool,
  type BuiltInToolGroup,
} from "../builtin-tools";

const SettingsSchema = z.object({
  normalThresholdGiB: z.number(),
  pressureThresholdGiB: z.number(),
  pollIntervalSeconds: z.number().int(),
  staleAfterSeconds: z.number().int(),
});

const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  hostname: z.string(),
  connected: z.boolean(),
  diskTotalBytes: z.number().nullable(),
  diskFreeBytes: z.number().nullable(),
});

const StatusSchema = z.enum([
  "DISABLED",
  "STALE",
  "IDLE",
  "CLEANUP_REQUIRED",
  "DELETING",
  "PRESSURE",
  "CRITICAL",
  "ERROR",
]);

const VolumeSchema = z.object({
  id: z.string(),
  capacityId: z.string(),
  totalBytes: z.number(),
  freeBytes: z.number(),
  roles: z.array(z.enum(["MAIN", "BASE_REPO", "DERIVED_DATA"])),
  paths: z.array(z.string()),
  status: StatusSchema,
  effectiveThresholdBytes: z.number(),
  monitored: z.boolean(),
});

const DiskSchema = z.object({
  enabled: z.boolean(),
  status: StatusSchema,
  pressureMode: z.enum(["NORMAL", "MANUAL", "AUTOMATIC"]),
  manualPressureMode: z.boolean(),
  automaticPressureMode: z.boolean(),
  lastReportedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  warnings: z.array(z.string()),
  monitoredVolumeId: z.string().nullable(),
  freeBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
  freeGiB: z.number().nullable(),
  freePercent: z.number().nullable(),
  usedPercent: z.number().nullable(),
  effectiveThresholdBytes: z.number().nullable(),
  normalThresholdGiB: z.number(),
  pressureThresholdGiB: z.number(),
  pollIntervalSeconds: z.number().int(),
  staleAfterSeconds: z.number().int(),
  changeReason: z.string().nullable(),
  volumes: z.array(VolumeSchema),
});

const SnapshotSchema = z.object({
  agent: AgentSchema,
  codebase: z.object({ agentId: z.string() }),
  disk: DiskSchema,
});

const AgentIdSchema = z.object({ agentId: z.string().min(1) });

export function createDiskSpaceToolGroup(
  diskSpace: DiskSpaceService,
): BuiltInToolGroup {
  return {
    id: "builtin:disk-space",
    name: "Disk Space",
    children: [],
    tools: [
      defineTool({
        name: "get_disk_space_overview",
        title: "Get disk-space overview",
        description:
          "Get global thresholds and canonical Derived Data disk snapshots for every agent.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          settings: SettingsSchema,
          agents: z.array(SnapshotSchema),
        }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => {
          const overview = await diskSpace.overview();
          return {
            settings: overview.settings,
            agents: overview.agents.map((view) =>
              diskSpaceSessionData(overview.settings, view),
            ),
          };
        },
      }),
      defineTool({
        name: "get_disk_space_settings",
        title: "Get disk-space settings",
        description: "Get global disk thresholds and report timing settings.",
        inputSchema: z.object({}),
        outputSchema: z.object({ settings: SettingsSchema }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async () => ({ settings: await diskSpace.settings() }),
      }),
      defineTool({
        name: "get_agent_disk_space",
        title: "Get agent disk space",
        description:
          "Get one agent's canonical Derived Data disk-space monitor snapshot.",
        inputSchema: AgentIdSchema,
        outputSchema: z.object({ snapshot: SnapshotSchema }),
        annotations: READ_ONLY_ANNOTATIONS,
        handler: async ({ agentId }) => ({
          snapshot: await diskSpace.snapshot(agentId),
        }),
      }),
      defineTool({
        name: "update_disk_space_settings",
        title: "Update disk-space settings",
        description:
          "Update the global normal and pressure free-space thresholds in GiB.",
        inputSchema: z.object({
          normalThresholdGiB: z.number().positive(),
          pressureThresholdGiB: z.number().positive(),
        }),
        outputSchema: z.object({ settings: SettingsSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async (input) => ({
          settings: await diskSpace.updateSettings(input),
        }),
      }),
      defineTool({
        name: "set_agent_disk_space_monitoring",
        title: "Set agent disk-space monitoring",
        description:
          "Enable or disable Derived Data disk-space monitoring for an agent.",
        inputSchema: AgentIdSchema.extend({ enabled: z.boolean() }),
        outputSchema: z.object({ snapshot: SnapshotSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId, enabled }) => {
          await diskSpace.setMonitoring(agentId, enabled);
          return { snapshot: await diskSpace.snapshot(agentId) };
        },
      }),
      defineTool({
        name: "set_agent_disk_space_pressure_mode",
        title: "Set agent disk pressure mode",
        description: "Enable or clear manual disk pressure mode for an agent.",
        inputSchema: AgentIdSchema.extend({ enabled: z.boolean() }),
        outputSchema: z.object({ snapshot: SnapshotSchema }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId, enabled }) => {
          await diskSpace.setManualPressureMode(agentId, enabled);
          return { snapshot: await diskSpace.snapshot(agentId) };
        },
      }),
      defineTool({
        name: "request_agent_disk_space_refresh",
        title: "Request agent disk-space refresh",
        description:
          "Ask an agent to collect and report disk-space telemetry immediately.",
        inputSchema: AgentIdSchema,
        outputSchema: z.object({
          agentId: z.string(),
          requestedAt: z.string(),
          previousReportedAt: z.string().nullable(),
        }),
        annotations: WRITE_ANNOTATIONS,
        handler: async ({ agentId }) => diskSpace.requestRefresh(agentId),
      }),
    ],
  };
}
