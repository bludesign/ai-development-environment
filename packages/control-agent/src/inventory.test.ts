import { describe, expect, test } from "vitest";

import {
  AGENT_CAPABILITIES,
  capabilitiesForPlatform,
  collectInventory,
  operatingSystemVersion,
} from "./inventory.js";

describe("agent inventory", () => {
  test("reports live hardware, memory, and disk inventory", () => {
    const inventory = collectInventory();
    expect(inventory.cpuModel.length).toBeGreaterThan(0);
    expect(inventory.memoryTotalBytes).toBeGreaterThan(0);
    expect(inventory.memoryFreeBytes).toBeGreaterThanOrEqual(0);
    expect(inventory.diskTotalBytes).toBeGreaterThan(0);
    expect(inventory.diskFreeBytes).toBeGreaterThanOrEqual(0);
    expect(inventory.defaultBuildsDirectory).toBeUndefined();
  });

  test("advertises the ccusage report capability", () => {
    expect(AGENT_CAPABILITIES).toContain("ccusage.report");
    expect(collectInventory().capabilities).toContain("ccusage.report");
  });

  test("advertises support for immediate codebase reconcile events", () => {
    expect(AGENT_CAPABILITIES).toContain("codebase.reconcile.requested");
    expect(collectInventory().capabilities).toContain(
      "codebase.reconcile.requested",
    );
  });

  test("reports the operating system instead of assuming macOS", () => {
    expect(operatingSystemVersion("darwin", "25.0.0")).toBe("macOS 25.0.0");
    expect(operatingSystemVersion("linux", "6.8.0")).toBe("Linux 6.8.0");
  });

  test("does not advertise macOS-only jobs on Linux", () => {
    const capabilities = capabilitiesForPlatform("linux");
    expect(capabilities).not.toContain("buildData.scan");
    expect(capabilities).not.toContain("ios.build.run");
    expect(capabilities).not.toContain("ios.signing.assets.scan");
    expect(capabilities).not.toContain("ios.crash.symbolicate");
    expect(capabilities).not.toContain("simulators.inventory");
    expect(capabilities).toContain("codebase.refresh");
    expect(capabilities).toContain("runs.protocol.v1");
  });

  test("advertises simulator administration on macOS", () => {
    expect(capabilitiesForPlatform("darwin")).toEqual(
      expect.arrayContaining([
        "simulators.inventory",
        "simulators.inspect",
        "simulators.create",
        "simulators.reset",
        "simulators.action",
      ]),
    );
  });

  test("advertises scoped execution only where process-group recovery is supported", () => {
    expect(capabilitiesForPlatform("darwin")).toContain(
      "operation.resources.v1",
    );
    expect(capabilitiesForPlatform("linux")).toContain(
      "operation.resources.v1",
    );
    expect(capabilitiesForPlatform("win32")).not.toContain(
      "operation.resources.v1",
    );
  });
});
