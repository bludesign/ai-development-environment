import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { androidTools } from "./android-tools.js";
import {
  AGENT_CAPABILITIES,
  capabilitiesForPlatform,
  collectInventory,
  operatingSystemVersion,
} from "./inventory.js";

describe("agent inventory", () => {
  test("reports live hardware, memory, and disk inventory", async () => {
    const inventory = await collectInventory();
    expect(inventory.cpuModel.length).toBeGreaterThan(0);
    expect(inventory.memoryTotalBytes).toBeGreaterThan(0);
    expect(inventory.memoryFreeBytes).toBeGreaterThanOrEqual(0);
    expect(inventory.diskTotalBytes).toBeGreaterThan(0);
    expect(inventory.diskFreeBytes).toBeGreaterThanOrEqual(0);
    expect(inventory.defaultBuildsDirectory).toBeUndefined();
  });

  test("advertises the ccusage report capability", async () => {
    expect(AGENT_CAPABILITIES).toContain("ccusage.report");
    expect((await collectInventory()).capabilities).toContain("ccusage.report");
  });

  test("advertises support for immediate codebase reconcile events", async () => {
    expect(AGENT_CAPABILITIES).toContain("codebase.reconcile.requested");
    expect((await collectInventory()).capabilities).toContain(
      "codebase.reconcile.requested",
    );
  });

  test("advertises source branch verification for branch changes", () => {
    expect(AGENT_CAPABILITIES).toContain("worktree.branch.expected-source");
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

  test.skipIf(process.platform === "win32")(
    "rejects an executable Java launcher without a working runtime",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "ade-android-java-"));
      const bin = join(directory, "bin");
      const java = join(bin, "java");
      try {
        await mkdir(bin);
        vi.stubEnv("JAVA_HOME", undefined);
        vi.stubEnv("PATH", bin);
        await writeFile(java, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
        expect(await androidTools().hasWorkingJava()).toBe(false);

        await writeFile(java, '#!/bin/sh\ntest "$1" = "-version"\n');
        expect(await androidTools().hasWorkingJava()).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

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
