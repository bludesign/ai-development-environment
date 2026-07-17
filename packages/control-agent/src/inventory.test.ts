import { describe, expect, test } from "vitest";

import { AGENT_CAPABILITIES, collectInventory } from "./inventory.js";

describe("agent inventory", () => {
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
