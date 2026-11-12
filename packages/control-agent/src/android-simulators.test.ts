import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  performAndroidSimulatorAction,
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

async function androidSdk() {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "aide-avd-test-")));
  const avdFolder = join(fixture, "avd");
  const sdk = join(fixture, "sdk");
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const image = `system-images/android-36/google_apis/${abi}`;
  vi.stubEnv("ANDROID_AVD_HOME", avdFolder);
  await mkdir(avdFolder);
  await mkdir(join(sdk, image), { recursive: true });
  const tools = {
    sdk,
    adb: join(sdk, "platform-tools", "adb"),
    emulator: join(sdk, "emulator", "emulator"),
    avdmanager: join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
  };
  vi.mocked(androidTools).mockReturnValue(
    tools as ReturnType<typeof androidTools>,
  );
  return { root: fixture, avdFolder, image, tools };
}

function captured(stdout: string) {
  return {
    stdout,
    stderr: "",
    outputTruncated: false,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
  };
}

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
  const { avdFolder, image, tools } = await androidSdk();
  const folder = join(avdFolder, "Pixel_8.avd");
  await mkdir(folder);
  await writeFile(join(avdFolder, "Pixel_8.ini"), `path=${folder}\n`);
  await writeFile(
    join(folder, "config.ini"),
    `image.sysdir.1=${image}/\nhw.device.name=pixel_8\n`,
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
    return captured(stdout);
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

test("uses registered AVD paths for inventory and actions", async () => {
  const { root, avdFolder, image, tools } = await androidSdk();
  const external = join(root, "custom", "Pixel_8.avd");
  const relativeFolder = join(root, "custom", "Pixel_9.avd");
  for (const folder of [external, relativeFolder]) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "config.ini"), `image.sysdir.1=${image}/\n`);
  }
  await writeFile(join(avdFolder, "Pixel_8.ini"), `path=${external}\n`);
  await writeFile(
    join(avdFolder, "Pixel_9.ini"),
    `path=${join(root, "missing")}\npath.rel=custom/Pixel_9.avd\n`,
  );
  await symlink(join(avdFolder, "Pixel_8.ini"), join(avdFolder, "Linked.ini"));
  vi.mocked(captureCommand).mockImplementation(async ({ command }) =>
    captured(
      command === tools.avdmanager
        ? profile
        : command === tools.emulator
          ? "Pixel_8\nPixel_9\nLinked"
          : "",
    ),
  );

  const signal = new AbortController().signal;
  expect(
    (await inventoryAndroidSimulators(signal)).inventory.simulators,
  ).toMatchObject([
    { id: "android:Linked", dataPath: null, isAvailable: false },
    {
      id: "android:Pixel_8",
      dataPath: external,
      isAvailable: true,
      state: "Shutdown",
    },
    {
      id: "android:Pixel_9",
      dataPath: relativeFolder,
      isAvailable: true,
      state: "Shutdown",
    },
  ]);
  await performAndroidSimulatorAction(
    {
      action: "OPEN_DATA_FOLDER",
      simulatorId: "android:Pixel_8",
      platform: "ANDROID",
    },
    signal,
  );
  expect(captureCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      command: "/usr/bin/open",
      args: ["-a", "Finder", external],
    }),
  );
});

test("clones AVD configuration, disks, and snapshots and registers the copy without replacing an existing AVD", async () => {
  const { root, avdFolder, image, tools } = await androidSdk();
  const source = join(root, "custom", "Pixel_8.avd");
  const sdCard = join(root, "external-sdcard.img");
  const qemuImg = join(tools.sdk, "emulator", "qemu-img");
  const config = `AvdId=Pixel_8\navd.ini.displayname=Source display name\nimage.sysdir.1=${image}/\nhw.ramSize=8192\nskin.name=Pixel_8\nsdcard.path=${sdCard}\n`;
  await mkdir(join(source, "snapshots"), { recursive: true });
  await writeFile(
    join(avdFolder, "Pixel_8.ini"),
    `path=${source}\npath.rel=custom/Pixel_8.avd\ntarget=android-36\n`,
  );
  await writeFile(join(source, "config.ini"), config);
  await writeFile(
    join(source, "hardware-qemu.ini"),
    `avd.name=Pixel_8\ndisk.dataPartition.path=${source}/userdata-qemu.img\nhw.sdCard.path=${sdCard}\n`,
  );
  await writeFile(join(source, "userdata-qemu.img"), "app data");
  await writeFile(join(source, "userdata-qemu.img.qcow2"), "installed apps");
  await writeFile(join(source, "snapshots", "state"), "snapshot state");
  await writeFile(join(source, "hardware-qemu.ini.lock"), "stale lock");
  await writeFile(sdCard, "external card data");
  vi.mocked(captureCommand).mockImplementation(async ({ command, args }) => {
    if (command === qemuImg && args[0] === "info")
      return captured(
        JSON.stringify(
          args[2]?.endsWith(".qcow2")
            ? { "backing-filename": join(source, "userdata-qemu.img") }
            : { format: "qcow2" },
        ),
      );
    return captured(
      command === tools.avdmanager
        ? profile
        : command === tools.emulator
          ? "Pixel_8"
          : "",
    );
  });
  const signal = new AbortController().signal;
  const input = simulatorActionPayload({
    action: "CLONE",
    simulatorId: "android:Pixel_8",
    name: "Pixel_8_Copy",
  });
  await expect(
    performAndroidSimulatorAction(input, signal),
  ).resolves.toMatchObject({ simulatorId: "android:Pixel_8_Copy" });
  const registration = join(avdFolder, "Pixel_8_Copy.ini");
  const metadata = await readFile(registration, "utf8");
  const clone = metadata.match(/^path=(.*)$/m)![1]!;
  expect(clone).not.toBe(source);
  expect(metadata).toContain("target=android-36");
  expect(metadata).not.toContain("path.rel");
  const clonedConfig = await readFile(join(clone, "config.ini"), "utf8");
  expect(clonedConfig).toContain("AvdId=Pixel_8_Copy");
  expect(clonedConfig).toContain("avd.ini.displayname=Pixel_8_Copy");
  expect(clonedConfig).toContain("hw.ramSize=8192");
  expect(clonedConfig).toContain("skin.name=Pixel_8");
  const clonedSdCard = clonedConfig.match(/^sdcard.path=(.*)$/m)![1]!;
  expect(clonedSdCard).not.toBe(sdCard);
  expect(await readFile(clonedSdCard, "utf8")).toBe("external card data");
  expect(await readFile(join(clone, "hardware-qemu.ini"), "utf8")).toContain(
    `disk.dataPartition.path=${clone}/userdata-qemu.img`,
  );
  expect(await readFile(join(clone, "userdata-qemu.img"), "utf8")).toBe(
    "app data",
  );
  expect(await readFile(join(clone, "userdata-qemu.img.qcow2"), "utf8")).toBe(
    "installed apps",
  );
  expect(await readFile(join(clone, "snapshots", "state"), "utf8")).toBe(
    "snapshot state",
  );
  expect(await readdir(clone)).not.toContain("hardware-qemu.ini.lock");
  expect(await readFile(join(source, "config.ini"), "utf8")).toBe(config);
  expect(captureCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      command: qemuImg,
      args: ["info", "--output=json", join(source, "userdata-qemu.img")],
    }),
  );
  expect(captureCommand).toHaveBeenCalledWith(
    expect.objectContaining({
      command: qemuImg,
      args: [
        "rebase",
        "-u",
        "-f",
        "qcow2",
        "-b",
        "userdata-qemu.img",
        "-F",
        "qcow2",
        join(clone, "userdata-qemu.img.qcow2"),
      ],
    }),
  );

  const originalFiles = await readdir(avdFolder);
  await expect(performAndroidSimulatorAction(input, signal)).rejects.toThrow(
    "already exists",
  );
  expect(await readFile(registration, "utf8")).toBe(metadata);
  expect(await readdir(avdFolder)).toEqual(originalFiles);

  const unsafeEntry = join(source, "linked-data");
  await symlink(sdCard, unsafeEntry);
  const retry = simulatorActionPayload({
    action: "CLONE",
    simulatorId: "android:Pixel_8",
    name: "Retry",
  });
  await expect(performAndroidSimulatorAction(retry, signal)).rejects.toThrow(
    "linked-data",
  );
  expect(await readdir(avdFolder)).toEqual(originalFiles);
  await rm(unsafeEntry);
  await expect(
    performAndroidSimulatorAction(retry, signal),
  ).resolves.toMatchObject({ simulatorId: "android:Retry" });
});
