import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import {
  simulatorActionPayload,
  simulatorCreatePayload,
  simulatorInspectPayload,
} from "@ai-development-environment/agent-contract/simulators";

import {
  inventoryAndroidSimulators,
  parseAndroidDeviceProfiles,
  runningAndroidAvds,
} from "./android-simulators.js";
import { androidTools } from "./android-tools.js";
import { captureCommand } from "./capture-command.js";

vi.mock("./android-tools.js");
vi.mock("./capture-command.js");

let fixture: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  if (fixture) await rm(fixture, { recursive: true, force: true });
  fixture = undefined;
});

const profile = 'id: 0 or "pixel_8"\n    Name: Pixel 8\n    OEM : Google\n';
const androidImage = "system-images;android-36;google_apis;arm64-v8a";

test("uses a separate identifier and system image format for Android", () => {
  expect(simulatorInspectPayload({ simulatorId: "android:Pixel_8" })).toEqual({
    simulatorId: "android:Pixel_8",
    platform: "ANDROID",
  });
  expect(
    simulatorCreatePayload({
      platform: "ANDROID",
      name: "Pixel_8",
      runtimeId: androidImage,
      deviceTypeId: "pixel_8",
    }),
  ).toMatchObject({
    runtimeId: androidImage,
    platform: "ANDROID",
  });
  expect(() =>
    simulatorActionPayload({
      simulatorId: "android:../outside",
      action: "DELETE",
    }),
  ).toThrow();
  expect(() =>
    simulatorActionPayload({
      simulatorId: "android:Pixel_8",
      action: "OPEN_APP_DATA_FOLDER",
      bundleId: "example.app",
    }),
  ).toThrow();
  expect(parseAndroidDeviceProfiles(profile)).toEqual([
    { id: "pixel_8", name: "Pixel 8" },
  ]);
});

test("relates a configured AVD to its live ADB serial without including physical devices", async () => {
  fixture = await mkdtemp(join(tmpdir(), "aide-avd-test-"));
  const avdFolder = join(fixture, "avd");
  const sdk = join(fixture, "sdk");
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const image = `system-images/android-36/google_apis/${abi}`;
  vi.stubEnv("ANDROID_AVD_HOME", avdFolder);
  await mkdir(join(avdFolder, "Pixel_8.avd"), { recursive: true });
  await mkdir(join(sdk, image), { recursive: true });
  await writeFile(
    join(avdFolder, "Pixel_8.avd", "config.ini"),
    `image.sysdir.1=${image}/\nhw.device.name=pixel_8\n`,
  );
  const tools = {
    sdk,
    adb: join(sdk, "platform-tools", "adb"),
    emulator: join(sdk, "emulator", "emulator"),
    avdmanager: join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
  };
  vi.mocked(androidTools).mockReturnValue(
    tools as ReturnType<typeof androidTools>,
  );
  vi.mocked(captureCommand).mockImplementation(async ({ command, args }) => {
    const stdout =
      command === tools.avdmanager
        ? profile
        : args[0] === "-list-avds"
          ? "Pixel_8\n"
          : args[0] === "devices"
            ? "List of devices attached\nusb-phone\tdevice\nemulator-5554\tdevice\n"
            : args[2] === "emu"
              ? "Pixel_8\nOK\n"
              : "1\n";
    return {
      stdout,
      stderr: "",
      outputTruncated: false,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  });
  const signal = new AbortController().signal;
  expect(await runningAndroidAvds(signal)).toEqual(
    new Map([["Pixel_8", "emulator-5554"]]),
  );
  expect(
    (await inventoryAndroidSimulators(signal)).inventory.simulators,
  ).toMatchObject([
    {
      id: "android:Pixel_8",
      state: "Booted",
      isAvailable: true,
      deviceTypeId: "pixel_8",
    },
  ]);
});
