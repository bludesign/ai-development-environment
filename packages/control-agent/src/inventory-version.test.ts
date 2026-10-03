import { afterEach, describe, expect, test, vi } from "vitest";

// Use a release version different from the development manifest to catch a
// hardcoded fallback even while package.json still contains 0.1.0 locally.
vi.mock("../package.json", () => ({ default: { version: "1.2.3" } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("agent release version", () => {
  test("reports the package version when no runtime override is set", async () => {
    vi.stubEnv("CONTROL_AGENT_VERSION", undefined);
    const { AGENT_VERSION, collectInventory } = await import("./inventory.js");

    expect(AGENT_VERSION).toBe("1.2.3");
    expect(collectInventory().version).toBe("1.2.3");
  });

  test("preserves the runtime version override used by container releases", async () => {
    vi.stubEnv("CONTROL_AGENT_VERSION", "2.3.4");
    const { AGENT_VERSION, collectInventory } = await import("./inventory.js");

    expect(AGENT_VERSION).toBe("2.3.4");
    expect(collectInventory().version).toBe("2.3.4");
  });
});
