import { describe, expect, test, vi } from "vitest";

import type { DiskSpaceChangedPayload } from "@/services/disk-space";

import { WorkflowEventBridge } from "./workflow-event-bridge";

function worktree(baseBehind: number | null) {
  return {
    id: "worktree-1",
    folder: "/tmp/worktree-1",
    branch: "feature/test",
    headSha: null,
    pushStatus: "READY",
    baseBehind,
    hasStagedChanges: false,
    hasUnstagedChanges: false,
    lastCheckedAt: new Date("2026-07-24T12:00:00.000Z"),
    missingAt: null,
    updatedAt: new Date("2026-07-24T12:00:00.000Z"),
    codebase: {
      id: "codebase-1",
      folder: "/tmp/codebase-1",
      agentId: "agent-1",
      defaultBranch: "main",
      repository: {
        id: "repository-1",
        name: "Widgets",
        canonicalOrigin: "github.com/acme/widgets",
        displayOrigin: "github.com/acme/widgets",
      },
    },
  };
}

const diskSnapshot = {
  agent: {
    id: "agent-1",
    name: "Studio Mac",
    hostname: "studio.local",
    connected: true,
    diskTotalBytes: 500,
    diskFreeBytes: 300,
  },
  codebase: { agentId: "agent-1" },
  disk: {
    enabled: true,
    status: "IDLE",
    pressureMode: "NORMAL",
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
    changeReason: "REPORT_RECEIVED",
    volumes: [],
  },
};

function diskChange(
  id: string,
  reason: DiskSpaceChangedPayload["diskSpaceChange"]["reason"],
  cleanup: DiskSpaceChangedPayload["diskSpaceChange"]["cleanup"] = null,
): DiskSpaceChangedPayload {
  return {
    diskSpaceChanged: "agent-1",
    diskSpaceChange: { id, reason, cleanup },
  };
}

describe("workflow worktree event bridge", () => {
  test("records behind events only when the worktree is behind", async () => {
    const record = vi.fn().mockResolvedValue({});
    const workflowSessionDataForWorktree = vi.fn().mockResolvedValue({
      agent: { id: "agent-1", name: "Studio Mac" },
      ticket: { key: "AIDE-42", title: "Enrich workflow sessions" },
    });
    const bridge = new WorkflowEventBridge(
      { record } as never,
      {} as never,
      { workflowSessionDataForWorktree } as never,
    ) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

    await bridge.observeWorktree(worktree(0));
    expect(record.mock.calls.map(([input]) => input.kind)).not.toContain(
      "WORKTREE_BEHIND",
    );

    record.mockClear();
    await bridge.observeWorktree(worktree(2));
    expect(workflowSessionDataForWorktree).toHaveBeenLastCalledWith(
      "worktree-1",
      { includeMissing: true },
    );
    expect(record.mock.calls.map(([input]) => input.kind)).toContain(
      "WORKTREE_BEHIND",
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "WORKTREE_BEHIND",
        payload: expect.objectContaining({
          sessionData: expect.objectContaining({
            repo: expect.objectContaining({
              name: "Widgets",
              url: "github.com/acme/widgets",
            }),
            agent: expect.objectContaining({
              id: "agent-1",
              name: "Studio Mac",
            }),
            ticket: expect.objectContaining({ key: "AIDE-42" }),
          }),
        }),
      }),
    );
  });
});

describe("workflow disk-space event bridge", () => {
  function diskBridge() {
    const record = vi.fn().mockResolvedValue({});
    const snapshot = vi.fn().mockResolvedValue(diskSnapshot);
    const overview = vi.fn();
    const bridge = new WorkflowEventBridge(
      { record } as never,
      {} as never,
      undefined,
      { snapshot, overview } as never,
    ) as unknown as {
      running: boolean;
      observeDiskChange(payload: DiskSpaceChangedPayload): Promise<void>;
      auditDiskSpace(reconcile: boolean): Promise<void>;
      stop(): void;
    };
    return { bridge, record, snapshot, overview };
  }

  test("emits report, threshold, and state events from an accepted report", async () => {
    const { bridge, record } = diskBridge();

    await bridge.observeDiskChange(diskChange("change-1", "REPORT_RECEIVED"));

    expect(record.mock.calls.map(([input]) => input.kind)).toEqual([
      "AGENT_DISK_REPORT",
      "AGENT_DISK_THRESHOLD",
      "AGENT_DISK_STATE_CHANGED",
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "AGENT_DISK_REPORT",
        dedupeKey: "agent-disk-report:agent-1:2026-07-25T12:00:00.000Z",
        payload: expect.objectContaining({
          cursorValue: "2026-07-25T12:00:00.000Z",
          sessionData: expect.objectContaining({
            agent: expect.objectContaining({ diskFreeBytes: 300 }),
            disk: expect.objectContaining({ freePercent: 50 }),
          }),
        }),
      }),
    );
  });

  test("uses a filtered cursor so free-space changes alone are not state changes", async () => {
    const { bridge, record, snapshot } = diskBridge();
    await bridge.observeDiskChange(diskChange("change-1", "REPORT_RECEIVED"));
    const first = record.mock.calls.find(
      ([input]) => input.kind === "AGENT_DISK_STATE_CHANGED",
    )?.[0].payload.cursorValue;
    record.mockClear();
    snapshot.mockResolvedValue({
      ...diskSnapshot,
      disk: { ...diskSnapshot.disk, freeBytes: 30, freePercent: 30 },
    });

    await bridge.observeDiskChange(diskChange("change-2", "REPORT_RECEIVED"));
    const second = record.mock.calls.find(
      ([input]) => input.kind === "AGENT_DISK_STATE_CHANGED",
    )?.[0].payload.cursorValue;

    expect(second).toEqual(first);
  });

  test("deduplicates repeated notifications for the same accepted report", async () => {
    const { bridge, record } = diskBridge();

    await bridge.observeDiskChange(diskChange("change-1", "REPORT_RECEIVED"));
    await bridge.observeDiskChange(diskChange("change-2", "REPORT_RECEIVED"));

    const reportKeys = record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.kind === "AGENT_DISK_REPORT")
      .map((input) => input.dedupeKey);
    expect(reportKeys).toEqual([
      "agent-disk-report:agent-1:2026-07-25T12:00:00.000Z",
      "agent-disk-report:agent-1:2026-07-25T12:00:00.000Z",
    ]);
  });

  test("emits successive automatic cleanup results without a cursor", async () => {
    const { bridge, record } = diskBridge();
    const cleanup = (jobId: string) => ({
      jobId,
      status: "SUCCEEDED",
      source: "AUTOMATIC" as const,
      error: null,
      targets: [{ path: `/DerivedData/${jobId}`, rootPath: "/DerivedData" }],
      deleted: [{ path: `/DerivedData/${jobId}`, deletedBytes: 10 }],
    });

    await bridge.observeDiskChange(
      diskChange("change-1", "CLEANUP_COMPLETED", cleanup("job-1")),
    );
    await bridge.observeDiskChange(
      diskChange("change-2", "CLEANUP_COMPLETED", cleanup("job-2")),
    );

    const events = record.mock.calls
      .map(([input]) => input)
      .filter((input) => input.kind === "AGENT_DISK_CLEANUP_RESULT");
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.dedupeKey)).toEqual([
      "agent-disk-cleanup:job-1:SUCCEEDED",
      "agent-disk-cleanup:job-2:SUCCEEDED",
    ]);
    expect(
      events.every((event) => event.payload.cursorValue === undefined),
    ).toBe(true);
    expect(events[0].payload.sessionData.cleanup).toMatchObject({
      jobId: "job-1",
      source: "AUTOMATIC",
    });
  });

  test("reconciles startup state and detects a later stale transition", async () => {
    const { bridge, record, overview } = diskBridge();
    const settings = {
      normalThresholdGiB: 40,
      pressureThresholdGiB: 10,
      pollIntervalSeconds: 60,
      staleAfterSeconds: 120,
    };
    const view = (status: "IDLE" | "STALE") => ({
      agent: {
        id: "agent-1",
        name: "Studio Mac",
        hostname: "studio.local",
        lastSeenAt: new Date(),
        disconnectedAt: null,
        heartbeatIntervalSeconds: 30,
        diskTotalBytes: 500,
        diskFreeBytes: 300,
      },
      enabled: true,
      status,
      pressureMode: "NORMAL",
      manualPressureMode: false,
      automaticPressureMode: false,
      lastReportedAt: "2026-07-25T12:00:00.000Z",
      lastError: null,
      warnings: [],
      volumes: [],
    });
    overview
      .mockResolvedValueOnce({ settings, agents: [view("IDLE")] })
      .mockResolvedValueOnce({ settings, agents: [view("STALE")] });

    bridge.running = true;
    await bridge.auditDiskSpace(true);
    bridge.stop();
    expect(record.mock.calls.map(([input]) => input.kind)).toContain(
      "AGENT_DISK_THRESHOLD",
    );
    record.mockClear();

    bridge.running = true;
    await bridge.auditDiskSpace(false);
    bridge.stop();

    expect(record.mock.calls.map(([input]) => input.kind)).toEqual([
      "AGENT_DISK_STATE_CHANGED",
    ]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          sessionData: expect.objectContaining({
            disk: expect.objectContaining({ status: "STALE" }),
          }),
        }),
      }),
    );
  });
});
