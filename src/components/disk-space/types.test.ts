import { describe, expect, test } from "vitest";

import {
  monitoredVolume,
  type AgentDiskSpace,
  type DiskSpaceVolume,
} from "./types";

const gib = 1024 ** 3;

function volume(overrides: Partial<DiskSpaceVolume>): DiskSpaceVolume {
  return {
    id: "volume",
    totalBytes: 100 * gib,
    freeBytes: 50 * gib,
    roles: ["MAIN"],
    paths: ["/"],
    status: "IDLE",
    effectiveThresholdBytes: 40 * gib,
    monitored: false,
    ...overrides,
  };
}

function agent(volumes: DiskSpaceVolume[]): AgentDiskSpace {
  return { volumes } as AgentDiskSpace;
}

describe("monitoredVolume", () => {
  test("picks the Derived Data volume over one with less free space", () => {
    const selected = monitoredVolume(
      agent([
        volume({ id: "root", freeBytes: 2 * gib, roles: ["MAIN"] }),
        volume({
          id: "data",
          freeBytes: 80 * gib,
          roles: ["DERIVED_DATA"],
          monitored: true,
        }),
      ]),
    );

    expect(selected?.id).toBe("data");
  });

  test("falls back to the tightest volume when Derived Data spans several", () => {
    const selected = monitoredVolume(
      agent([
        volume({ id: "data-a", freeBytes: 80 * gib, monitored: true }),
        volume({ id: "data-b", freeBytes: 12 * gib, monitored: true }),
      ]),
    );

    expect(selected?.id).toBe("data-b");
  });

  test("returns null when no volume holds Derived Data", () => {
    expect(monitoredVolume(agent([volume({ id: "root" })]))).toBeNull();
  });
});
