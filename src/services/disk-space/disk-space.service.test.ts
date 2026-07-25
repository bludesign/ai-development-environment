import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import type { AgentControlService } from "@/services/agent-control";

import { DiskSpaceService } from "./disk-space.service";

function prismaForState(state: {
  enabled: boolean;
  lastReportedAt: Date | null;
  lastError: string | null;
  volumesJson: string;
}) {
  return {
    diskSpaceSettings: {
      upsert: vi.fn().mockResolvedValue({
        normalThresholdGiB: 40,
        pressureThresholdGiB: 10,
      }),
    },
    agentDiskSpaceState: {
      findUnique: vi.fn().mockResolvedValue(state),
    },
  };
}

function service() {
  return new DiskSpaceService({
    registerCompletionObserver: vi.fn(),
  } as unknown as AgentControlService);
}

describe("DiskSpaceService admission control", () => {
  beforeEach(() => vi.clearAllMocks());

  test("blocks new work at or below the critical threshold", async () => {
    getPrismaClient.mockResolvedValue(
      prismaForState({
        enabled: true,
        lastReportedAt: new Date(),
        lastError: null,
        volumesJson: JSON.stringify([
          {
            id: "device-1",
            totalBytes: 100 * 1024 ** 3,
            freeBytes: 10 * 1024 ** 3,
            roles: ["MAIN"],
            paths: ["/"],
          },
        ]),
      }),
    );

    await expect(service().assertAgentCanStart("agent-1")).rejects.toThrow(
      "paused",
    );
  });

  test.each([
    {
      label: "stale",
      state: {
        enabled: true,
        lastReportedAt: new Date(Date.now() - 121_000),
        lastError: null,
      },
    },
    {
      label: "disabled",
      state: { enabled: false, lastReportedAt: new Date(), lastError: null },
    },
    {
      label: "errored",
      state: {
        enabled: true,
        lastReportedAt: new Date(),
        lastError: "unavailable",
      },
    },
  ])("fails open for $label telemetry", async ({ state }) => {
    getPrismaClient.mockResolvedValue(
      prismaForState({
        ...state,
        volumesJson: JSON.stringify([
          {
            id: "device-1",
            totalBytes: 100,
            freeBytes: 0,
            roles: ["MAIN"],
            paths: ["/"],
          },
        ]),
      }),
    );

    await expect(
      service().assertAgentCanStart("agent-1"),
    ).resolves.toBeUndefined();
  });

  test("requires positive ordered global thresholds", async () => {
    await expect(
      service().updateSettings({
        normalThresholdGiB: 10,
        pressureThresholdGiB: 10,
      }),
    ).rejects.toThrow("lower than");
    await expect(
      service().updateSettings({
        normalThresholdGiB: Number.NaN,
        pressureThresholdGiB: 1,
      }),
    ).rejects.toThrow("positive finite");
  });
});
