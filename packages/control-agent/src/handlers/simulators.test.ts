import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { captureCommand } from "../capture-command.js";
import {
  createSimulator,
  inspectSimulator,
  inventorySimulators,
  performSimulatorAction,
  resetSimulators,
} from "./simulators.js";

vi.mock("../capture-command.js", () => ({ captureCommand: vi.fn() }));

const capture = vi.mocked(captureCommand);
const simulatorId = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const replacementId = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const visionRuntimeId = "com.apple.CoreSimulator.SimRuntime.xrOS-27-2";
const tvRuntimeId = "com.apple.CoreSimulator.SimRuntime.tvOS-27-2";
const legacyRuntimeId = "com.apple.CoreSimulator.SimRuntime.tvOS-26-0";
const deviceTypeId = "com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K";
const visionTypeId = "com.apple.CoreSimulator.SimDeviceType.Apple-Vision-Pro";
const bundleId = "com.example.Sample";
const timeout = 30_000;
let scratch: string;

function response(stdout = "", stderr = "", exitCode = 0) {
  return {
    stdout,
    stderr,
    exitCode,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
  };
}

function device(udid = simulatorId, fields = {}) {
  return {
    udid,
    name: "Apple TV",
    state: "Shutdown",
    isAvailable: true,
    deviceTypeIdentifier: deviceTypeId,
    ...fields,
  };
}

function runtime(id: string, type: string, name: string, platform: string) {
  return {
    identifier: id,
    name,
    platform,
    version: "27.2",
    isAvailable: true,
    supportedDeviceTypes: [
      {
        identifier: type,
        name: name.split(" ")[0]!,
        bundlePath: `/profiles/${type}`,
      },
    ],
  };
}

function inventory(
  devices: Record<string, unknown[]> = { [tvRuntimeId]: [device()] },
  runtimes = [runtime(tvRuntimeId, deviceTypeId, "tvOS 27.2", "tvOS")],
) {
  return response(JSON.stringify({ devices, runtimes }));
}

function commands() {
  return capture.mock.calls.map(([input]) => input.args);
}

function signal() {
  return new AbortController().signal;
}

beforeEach(async () => {
  capture.mockReset();
  scratch = await realpath(
    await mkdtemp(join(tmpdir(), "aide-simulators-test-")),
  );
  vi.stubEnv("HOME", scratch);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(scratch, { recursive: true, force: true });
});

describe("simulator jobs", () => {
  test("returns platform-specific runtime types and keeps unavailable devices visible", async () => {
    capture.mockResolvedValueOnce(
      inventory(
        {
          [tvRuntimeId]: [device()],
          [legacyRuntimeId]: [
            device(replacementId, {
              isAvailable: false,
              availabilityError: "Runtime missing",
            }),
          ],
        },
        [
          runtime(tvRuntimeId, deviceTypeId, "tvOS 27.2", "tvOS"),
          runtime(visionRuntimeId, visionTypeId, "visionOS 27.2", "xrOS"),
        ],
      ),
    );
    const result = await inventorySimulators({}, timeout, signal());
    expect(result.inventory.runtimes).toMatchObject([
      { platform: "tvOS", deviceTypes: [{ id: deviceTypeId }] },
      { platform: "visionOS", deviceTypes: [{ id: visionTypeId }] },
    ]);
    expect(result.inventory.simulators).toContainEqual(
      expect.objectContaining({
        id: replacementId,
        platform: "tvOS",
        isAvailable: false,
        availabilityError: "Runtime missing",
        runtimeName: null,
      }),
    );
  });

  test("validates compatibility and rejects command aliases before execution", async () => {
    capture.mockResolvedValueOnce(inventory());
    await expect(
      createSimulator(
        {
          name: "Apple Vision Pro",
          runtimeId: tvRuntimeId,
          deviceTypeId: visionTypeId,
        },
        timeout,
        signal(),
      ),
    ).rejects.toThrow("not supported");
    await expect(
      performSimulatorAction(
        { action: "DELETE", simulatorId: "all" },
        timeout,
        signal(),
      ),
    ).rejects.toThrow("UUID");
    expect(commands()).toEqual([["simctl", "list", "-j"]]);
  });

  test("deletes only the selected unavailable simulator stuck in Creating", async () => {
    capture
      .mockResolvedValueOnce(
        inventory({
          [legacyRuntimeId]: [
            device(simulatorId, {
              state: "Creating",
              isAvailable: false,
              availabilityError:
                "runtime profile not found using “System” match policy",
            }),
            device(replacementId, { isAvailable: false }),
          ],
        }),
      )
      .mockResolvedValueOnce(response());

    await performSimulatorAction(
      { action: "DELETE", simulatorId },
      timeout,
      signal(),
    );

    expect(commands()).toEqual([
      ["simctl", "list", "-j"],
      ["simctl", "delete", simulatorId],
    ]);
  });

  test.each([
    { state: "Creating", isAvailable: true },
    { state: "Booting", isAvailable: false },
    { state: "Booted", isAvailable: false },
    { state: "Shutting Down", isAvailable: false },
  ])("protects an in-use simulator reported as $state", async (state) => {
    capture.mockResolvedValueOnce(
      inventory({ [tvRuntimeId]: [device(simulatorId, state)] }),
    );
    await expect(
      performSimulatorAction(
        { action: "DELETE", simulatorId },
        timeout,
        signal(),
      ),
    ).rejects.toThrow("shut down");
    expect(commands()).toEqual([["simctl", "list", "-j"]]);
  });

  test("reads apps on a shut-down device and reveals only validated local paths", async () => {
    const dataPath = join(
      scratch,
      "Library",
      "Developer",
      "CoreSimulator",
      "Devices",
      simulatorId,
      "data",
    );
    const appPath = join(
      dataPath,
      "Containers",
      "Bundle",
      "Application",
      "bundle",
      "Sample.app",
    );
    const appDataPath = join(
      dataPath,
      "Containers",
      "Data",
      "Application",
      "app-data",
    );
    const outside = join(scratch, "Other.app");
    await mkdir(appPath, { recursive: true });
    await mkdir(appDataPath, { recursive: true });
    await mkdir(outside);
    await writeFile(join(appPath, "Info.plist"), "");
    await writeFile(
      join(appDataPath, ".com.apple.mobile_container_manager.metadata.plist"),
      "",
    );
    await symlink(outside, join(appPath, "..", "Other.app"));
    capture.mockImplementation(async ({ command, args }) => {
      if (command === "/usr/bin/xcrun")
        return inventory({
          [tvRuntimeId]: [device(simulatorId, { dataPath })],
        });
      if (command === "/usr/bin/plutil") {
        return response(
          JSON.stringify(
            args.at(-1)?.endsWith("Info.plist")
              ? {
                  CFBundleIdentifier: bundleId,
                  CFBundleName: "Sample",
                  CFBundleVersion: 5,
                }
              : { MCMMetadataIdentifier: bundleId },
          ),
        );
      }
      return response();
    });
    const result = await inspectSimulator({ simulatorId }, timeout, signal());
    expect(result.details.apps).toEqual([
      {
        bundleId,
        name: "Sample",
        version: null,
        build: "5",
        bundlePath: appPath,
        dataPath: appDataPath,
      },
    ]);
    await performSimulatorAction(
      { action: "OPEN_APP_BUNDLE_FOLDER", simulatorId, bundleId },
      timeout,
      signal(),
    );
    expect(capture).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: "/usr/bin/open",
        args: ["-R", appPath],
      }),
    );
    await expect(
      performSimulatorAction(
        { action: "LAUNCH_APP", simulatorId, bundleId },
        timeout,
        signal(),
      ),
    ).rejects.toThrow("booted");
    expect(commands()).not.toContainEqual([
      "simctl",
      "launch",
      simulatorId,
      bundleId,
    ]);
  });

  test("uses the booted app registry and includes only user apps", async () => {
    capture.mockImplementation(async ({ args, stdoutFileDescriptor }) => {
      if (args[1] === "list")
        return inventory({
          [tvRuntimeId]: [device(simulatorId, { state: "Booted" })],
        });
      if (args[1] === "listapps") {
        expect(stdoutFileDescriptor).toBeDefined();
        return response();
      }
      if (args[0] === "-convert") {
        return response(
          JSON.stringify({
            "com.apple.System": { ApplicationType: "System" },
            [bundleId]: {
              ApplicationType: "User",
              CFBundleDisplayName: "Sample",
              Path: "/outside/Sample.app",
            },
          }),
        );
      }
      return response();
    });
    const result = await inspectSimulator({ simulatorId }, timeout, signal());
    expect(result.details.apps).toEqual([
      {
        bundleId,
        name: "Sample",
        version: null,
        build: null,
        bundlePath: null,
        dataPath: null,
      },
    ]);
    await performSimulatorAction(
      { action: "LAUNCH_APP", simulatorId, bundleId },
      timeout,
      signal(),
    );
    expect(commands().at(-1)).toEqual([
      "simctl",
      "launch",
      simulatorId,
      bundleId,
    ]);
  });

  test("preflights profiles and stages defaults before deleting original simulators", async () => {
    capture
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            createByDefaultForRuntimeVersions: {
              versionMin: "27.2",
              versionMax: "99.99",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(response(replacementId))
      .mockResolvedValueOnce(
        inventory({ [tvRuntimeId]: [device(), device(replacementId)] }),
      )
      .mockResolvedValueOnce(response());
    await resetSimulators({}, timeout, signal());
    expect(commands().map((args) => args[1])).toEqual([
      "list",
      "json",
      "create",
      "list",
      "delete",
    ]);
    expect(commands().at(-1)).toEqual(["simctl", "delete", simulatorId]);
  });

  test("keeps originals when the Xcode default roster cannot be validated", async () => {
    capture
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(response("{}"));
    await expect(resetSimulators({}, timeout, signal())).rejects.toThrow(
      "No Xcode default",
    );
    expect(commands()).toHaveLength(2);
  });

  test("rejects a booted simulator before staging any defaults", async () => {
    capture.mockResolvedValueOnce(
      inventory({ [tvRuntimeId]: [device(simulatorId, { state: "Booted" })] }),
    );
    await expect(resetSimulators({}, timeout, signal())).rejects.toThrow(
      "Shut down all",
    );
    expect(commands()).toHaveLength(1);
  });

  test("keeps the reset requirement that all simulators be shut down", async () => {
    capture.mockResolvedValueOnce(
      inventory({
        [legacyRuntimeId]: [
          device(simulatorId, { state: "Creating", isAvailable: false }),
        ],
      }),
    );
    await expect(resetSimulators({}, timeout, signal())).rejects.toThrow(
      "Shut down all",
    );
    expect(commands()).toEqual([["simctl", "list", "-j"]]);
  });

  test("keeps every original when a device boots while reset is staging", async () => {
    capture
      .mockResolvedValueOnce(inventory())
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            createByDefaultForRuntimeVersions: {
              versionMin: "27.2",
              versionMax: "99.99",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(response(replacementId))
      .mockResolvedValueOnce(
        inventory({
          [tvRuntimeId]: [
            device(simulatorId, { state: "Booted" }),
            device(replacementId),
          ],
        }),
      )
      .mockResolvedValueOnce(response());
    await expect(resetSimulators({}, timeout, signal())).rejects.toThrow(
      "Original simulators were kept",
    );
    expect(commands().at(-1)).toEqual(["simctl", "delete", replacementId]);
    expect(commands()).not.toContainEqual(["simctl", "delete", simulatorId]);
  });
});
