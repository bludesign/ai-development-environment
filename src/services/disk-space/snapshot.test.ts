import { describe, expect, test } from "vitest";

import type {
  AgentDiskSpaceView,
  DiskSpaceSettingsView,
} from "./disk-space.service";
import { diskSpaceSessionData } from "./snapshot";

const GIB = 1024 ** 3;

const settings: DiskSpaceSettingsView = {
  normalThresholdGiB: 40,
  pressureThresholdGiB: 10,
  pollIntervalSeconds: 60,
  staleAfterSeconds: 120,
};

function view(monitored = true): AgentDiskSpaceView {
  return {
    agent: {
      id: "agent-1",
      name: "Studio",
      hostname: "studio.local",
      lastSeenAt: new Date(),
      disconnectedAt: null,
      heartbeatIntervalSeconds: 30,
      diskTotalBytes: 500 * GIB,
      diskFreeBytes: 300 * GIB,
    } as never,
    enabled: true,
    status: "CLEANUP_REQUIRED",
    pressureMode: "NORMAL",
    manualPressureMode: false,
    automaticPressureMode: false,
    lastReportedAt: "2026-07-25T12:00:00.000Z",
    lastError: null,
    warnings: [],
    volumes: [
      {
        id: "root",
        capacityId: "root",
        totalBytes: 500 * GIB,
        freeBytes: 300 * GIB,
        roles: ["MAIN"],
        paths: ["/"],
        status: "IDLE",
        effectiveThresholdBytes: 40 * GIB,
        monitored: false,
      },
      {
        id: "derived-roomy",
        capacityId: "derived-roomy",
        totalBytes: 100 * GIB,
        freeBytes: 30 * GIB,
        roles: ["DERIVED_DATA"],
        paths: ["/DerivedData-A"],
        status: "CLEANUP_REQUIRED",
        effectiveThresholdBytes: 40 * GIB,
        monitored,
      },
      {
        id: "derived-low",
        capacityId: "derived-low",
        totalBytes: 100 * GIB,
        freeBytes: 5 * GIB,
        roles: ["DERIVED_DATA"],
        paths: ["/DerivedData-B"],
        status: "CRITICAL",
        effectiveThresholdBytes: 40 * GIB,
        monitored,
      },
    ],
  };
}

describe("disk-space session snapshot", () => {
  test("uses the least-free monitored Derived Data volume", () => {
    const result = diskSpaceSessionData(settings, view(), "REPORT_RECEIVED");

    expect(result.disk).toMatchObject({
      monitoredVolumeId: "derived-low",
      freeBytes: 5 * GIB,
      totalBytes: 100 * GIB,
      freeGiB: 5,
      freePercent: 5,
      usedPercent: 95,
      changeReason: "REPORT_RECEIVED",
    });
    expect(result.agent.diskFreeBytes).toBe(300 * GIB);
  });

  test("returns null summary metrics when no volume is monitored", () => {
    const result = diskSpaceSessionData(settings, view(false));

    expect(result.disk).toMatchObject({
      monitoredVolumeId: null,
      freeBytes: null,
      totalBytes: null,
      freeGiB: null,
      freePercent: null,
      usedPercent: null,
    });
  });
});
