import { describe, expect, test, vi } from "vitest";

import type {
  AgentDiskSpaceView,
  DiskSpaceService,
  DiskSpaceSettingsView,
} from "@/services/disk-space";

import { createDiskSpaceToolGroup } from "./disk-space";

const settings: DiskSpaceSettingsView = {
  normalThresholdGiB: 40,
  pressureThresholdGiB: 10,
  pollIntervalSeconds: 60,
  staleAfterSeconds: 120,
};

const snapshot = {
  agent: {
    id: "agent-1",
    name: "Studio",
    hostname: "studio.local",
    connected: true,
    diskTotalBytes: 100,
    diskFreeBytes: 50,
  },
  codebase: { agentId: "agent-1" },
  disk: {
    enabled: true,
    status: "IDLE" as const,
    pressureMode: "NORMAL" as const,
    manualPressureMode: false,
    automaticPressureMode: false,
    lastReportedAt: "2026-07-25T12:00:00.000Z",
    lastError: null,
    warnings: [],
    monitoredVolumeId: "derived",
    freeBytes: 50,
    totalBytes: 100,
    freeGiB: 50 / 1024 ** 3,
    freePercent: 50,
    usedPercent: 50,
    effectiveThresholdBytes: 40,
    normalThresholdGiB: 40,
    pressureThresholdGiB: 10,
    pollIntervalSeconds: 60,
    staleAfterSeconds: 120,
    changeReason: null,
    volumes: [
      {
        id: "derived",
        capacityId: "derived",
        totalBytes: 100,
        freeBytes: 50,
        roles: ["DERIVED_DATA" as const],
        paths: ["/DerivedData"],
        status: "IDLE" as const,
        effectiveThresholdBytes: 40,
        monitored: true,
      },
    ],
  },
};

function service() {
  const rawView = {
    agent: {
      id: "agent-1",
      name: "Studio",
      hostname: "studio.local",
      lastSeenAt: new Date(),
      disconnectedAt: null,
      heartbeatIntervalSeconds: 30,
      diskTotalBytes: 100,
      diskFreeBytes: 50,
    } as never,
    enabled: true,
    status: "IDLE",
    pressureMode: "NORMAL",
    manualPressureMode: false,
    automaticPressureMode: false,
    lastReportedAt: "2026-07-25T12:00:00.000Z",
    lastError: null,
    warnings: [],
    volumes: snapshot.disk.volumes,
  } as AgentDiskSpaceView;
  return {
    overview: vi.fn().mockResolvedValue({ settings, agents: [rawView] }),
    settings: vi.fn().mockResolvedValue(settings),
    snapshot: vi.fn().mockResolvedValue(snapshot),
    updateSettings: vi.fn().mockResolvedValue(settings),
    setMonitoring: vi.fn().mockResolvedValue(rawView),
    setManualPressureMode: vi.fn().mockResolvedValue(rawView),
    requestRefresh: vi.fn().mockResolvedValue({
      agentId: "agent-1",
      requestedAt: "2026-07-25T12:01:00.000Z",
      previousReportedAt: snapshot.disk.lastReportedAt,
    }),
  } as unknown as DiskSpaceService;
}

describe("disk-space MCP tools", () => {
  test("exposes the complete read/write surface with safe annotations", () => {
    const group = createDiskSpaceToolGroup(service());

    expect(group.id).toBe("builtin:disk-space");
    expect(group.tools.map(({ name }) => name)).toEqual([
      "get_disk_space_overview",
      "get_disk_space_settings",
      "get_agent_disk_space",
      "update_disk_space_settings",
      "set_agent_disk_space_monitoring",
      "set_agent_disk_space_pressure_mode",
      "request_agent_disk_space_refresh",
    ]);
    expect(
      group.tools.slice(0, 3).every((tool) => tool.annotations.readOnlyHint),
    ).toBe(true);
    expect(
      group.tools.slice(3).every((tool) => !tool.annotations.readOnlyHint),
    ).toBe(true);
    expect(group.tools.every((tool) => !tool.annotations.destructiveHint)).toBe(
      true,
    );
  });

  test("delegates every operation and returns canonical snapshots", async () => {
    const diskSpace = service();
    const group = createDiskSpaceToolGroup(diskSpace);
    const call = (name: string, input: unknown) =>
      group.tools.find((tool) => tool.name === name)!.invoke(input);

    await expect(call("get_disk_space_overview", {})).resolves.toMatchObject({
      agents: [{ disk: { monitoredVolumeId: "derived" } }],
    });
    await expect(call("get_disk_space_settings", {})).resolves.toEqual({
      settings,
    });
    await expect(
      call("get_agent_disk_space", { agentId: "agent-1" }),
    ).resolves.toEqual({ snapshot });
    await call("update_disk_space_settings", {
      normalThresholdGiB: 40,
      pressureThresholdGiB: 10,
    });
    await call("set_agent_disk_space_monitoring", {
      agentId: "agent-1",
      enabled: false,
    });
    await call("set_agent_disk_space_pressure_mode", {
      agentId: "agent-1",
      enabled: true,
    });
    await call("request_agent_disk_space_refresh", { agentId: "agent-1" });

    expect(diskSpace.updateSettings).toHaveBeenCalledWith({
      normalThresholdGiB: 40,
      pressureThresholdGiB: 10,
    });
    expect(diskSpace.setMonitoring).toHaveBeenCalledWith("agent-1", false);
    expect(diskSpace.setManualPressureMode).toHaveBeenCalledWith(
      "agent-1",
      true,
    );
    expect(diskSpace.requestRefresh).toHaveBeenCalledWith("agent-1");
  });
});
