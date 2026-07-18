import { describe, expect, test } from "vitest";

import { AGENT_CAPABILITIES, collectInventory } from "./inventory.js";

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
});
