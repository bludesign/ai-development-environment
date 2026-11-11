import { spawn } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  androidAvdName,
  androidSystemImage,
  type Simulator,
  type SimulatorActionPayload,
  type SimulatorApp,
  type SimulatorDeviceType,
  type SimulatorRuntime,
  simulatorCreatePayload,
} from "@ai-development-environment/agent-contract/simulators";

import { androidTools } from "./android-tools.js";
import { captureCommand } from "./capture-command.js";

type CreateInput = ReturnType<typeof simulatorCreatePayload>;
type Avd = Simulator & { serial: string | null };

const completed = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

function requireTool(tool: "adb" | "emulator" | "avdmanager"): string {
  const path = androidTools()[tool];
  if (!path) throw new Error(`Install Android SDK ${tool} on this Mac agent`);
  return path;
}

async function command(
  tool: string,
  args: string[],
  signal: AbortSignal,
  stdin?: string,
): Promise<string> {
  signal.throwIfAborted();
  const result = await captureCommand({
    command: tool,
    args,
    signal,
    timeoutMs: 30_000,
    stdin,
    env: { ...process.env, LC_ALL: "C" },
  });
  signal.throwIfAborted();
  if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(
      result.stderr.trim() ||
        result.stdout.trim() ||
        `${tool.split("/").at(-1)} did not complete successfully`,
    );
  }
  return result.stdout.trim();
}

async function adb(args: string[], signal: AbortSignal) {
  return command(requireTool("adb"), args, signal);
}

export async function runningAndroidAvds(
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const devices = await adb(["devices"], signal);
  const serials = Array.from(
    devices.matchAll(/^\s*(emulator-\d+)\s+(?:device|offline)\b/gm),
    ([, serial]) => serial!,
  );
  const results = await Promise.all(
    serials.map(async (serial) => {
      try {
        const result = await adb(["-s", serial, "emu", "avd", "name"], signal);
        return [androidAvdName(result.split(/\r?\n/, 1)[0]), serial] as const;
      } catch {
        signal.throwIfAborted();
        return null;
      }
    }),
  );
  return new Map(results.filter((result) => result !== null));
}

function avdHome(): string {
  return resolve(
    process.env.ANDROID_AVD_HOME ||
      (process.env.ANDROID_USER_HOME
        ? join(process.env.ANDROID_USER_HOME, "avd")
        : join(homedir(), ".android", "avd")),
  );
}

function ini(value: string): Map<string, string> {
  const entries = value.split(/\r?\n/).flatMap((line) => {
    const delimiter = line.indexOf("=");
    return delimiter > 0
      ? [
          [
            line.slice(0, delimiter).trim(),
            line.slice(delimiter + 1).trim(),
          ] as const,
        ]
      : [];
  });
  return new Map(entries);
}

async function avdConfig(name: string) {
  const root = await realpath(avdHome());
  const expected = join(root, `${name}.avd`);
  try {
    const folder = await realpath(expected);
    if (folder !== expected) return null;
    const config = await readFile(join(folder, "config.ini"), "utf8");
    return { folder, config: ini(config) };
  } catch {
    return null;
  }
}

function imageFromConfig(config: Map<string, string> | undefined) {
  const imagePath = config?.get("image.sysdir.1");
  const match = imagePath?.match(
    /(?:^|[/\\])(system-images[/\\]android-[^/\\]+[/\\][^/\\]+[/\\][^/\\]+)/,
  );
  if (!match) return null;
  try {
    return androidSystemImage(match[1]!.replaceAll(/[/\\]/g, ";"));
  } catch {
    return null;
  }
}

export function parseAndroidDeviceProfiles(
  output: string,
): SimulatorDeviceType[] {
  return Array.from(
    output.matchAll(
      /^id:\s*\d+\s+or\s+"([A-Za-z0-9][A-Za-z0-9._-]*)"\s*\r?\n\s*Name:\s*([^\r\n]+)/gm,
    ),
    ([, id, name]) => ({ id: id!, name: name!.trim() }),
  );
}

async function subdirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function runtimes(signal: AbortSignal): Promise<SimulatorRuntime[]> {
  const deviceTypes = parseAndroidDeviceProfiles(
    await command(requireTool("avdmanager"), ["list", "device"], signal),
  );
  const sdk = dirname(dirname(requireTool("emulator")));
  const images = join(sdk, "system-images");
  const supportedAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const result: SimulatorRuntime[] = [];
  for (const target of await subdirectories(images)) {
    for (const tag of await subdirectories(join(images, target))) {
      for (const abi of await subdirectories(join(images, target, tag))) {
        if (abi !== supportedAbi || !target.startsWith("android-")) continue;
        const id = androidSystemImage(`system-images;${target};${tag};${abi}`);
        const version = target.slice("android-".length);
        result.push({
          id,
          name: `Android API ${version} · ${tag.replaceAll("_", " ")} · ${abi}`,
          platform: "ANDROID",
          version,
          deviceTypes,
        });
      }
    }
  }
  return result.sort(
    (a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }) ||
      a.name.localeCompare(b.name),
  );
}

async function isBooted(serial: string, signal: AbortSignal): Promise<boolean> {
  try {
    return (
      (await adb(
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        signal,
      )) === "1"
    );
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function devices(
  runtimeList: SimulatorRuntime[],
  signal: AbortSignal,
): Promise<Avd[]> {
  const [configured, active] = await Promise.all([
    command(requireTool("emulator"), ["-list-avds"], signal),
    runningAndroidAvds(signal),
  ]);
  const names = new Set(
    configured
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)),
  );
  return Promise.all(
    Array.from(names)
      .sort()
      .map(async (name) => {
        const configuration = await avdConfig(name).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          },
        );
        const runtimeId = imageFromConfig(configuration?.config);
        const runtime = runtimeList.find((item) => item.id === runtimeId);
        const serial = active.get(name) ?? null;
        return {
          id: `android:${name}`,
          name,
          runtimeId: runtimeId ?? "unknown",
          runtimeName: runtime?.name ?? null,
          platform: "ANDROID",
          deviceTypeId: configuration?.config.get("hw.device.name") ?? null,
          state: serial
            ? (await isBooted(serial, signal))
              ? "Booted"
              : "Booting"
            : "Shutdown",
          isAvailable: Boolean(runtime) || Boolean(serial),
          availabilityError:
            runtime || serial
              ? null
              : "Install the AVD system image for this Mac",
          dataPath: configuration?.folder ?? null,
          serial,
        };
      }),
  );
}

function findDevice(avds: Avd[], id: string): Avd {
  const avd = avds.find((entry) => entry.id === id);
  if (!avd) throw new Error("Android emulator is no longer on this agent");
  return avd;
}

export async function inventoryAndroidSimulators(signal: AbortSignal) {
  const runtimeList = await runtimes(signal);
  const avds = await devices(runtimeList, signal);
  return {
    ...completed,
    inventory: {
      simulators: avds.map(({ serial: _serial, ...avd }) => avd),
      runtimes: runtimeList,
    },
  };
}

async function installedApps(
  serial: string,
  signal: AbortSignal,
): Promise<SimulatorApp[]> {
  const output = await adb(
    ["-s", serial, "shell", "pm", "list", "packages", "-3"],
    signal,
  );
  return Array.from(
    output.matchAll(/^package:([A-Za-z][A-Za-z0-9_.]*)\s*$/gm),
    ([, packageId]) => ({
      bundleId: packageId!,
      name: packageId!,
      version: null,
      build: null,
      bundlePath: null,
      dataPath: null,
    }),
  );
}

export async function inspectAndroidSimulator(id: string, signal: AbortSignal) {
  const { serial, ...simulator } = findDevice(
    await devices(await runtimes(signal), signal),
    id,
  );
  return {
    ...completed,
    details: {
      simulator,
      apps:
        serial && simulator.state === "Booted"
          ? await installedApps(serial, signal)
          : [],
    },
  };
}

export async function createAndroidSimulator(
  input: CreateInput,
  signal: AbortSignal,
) {
  const runtimeList = await runtimes(signal);
  const runtime = runtimeList.find((entry) => entry.id === input.runtimeId);
  if (!runtime?.deviceTypes.some((type) => type.id === input.deviceTypeId))
    throw new Error(
      "Select an installed Android system image and device profile",
    );
  const name = androidAvdName(input.name);
  await command(
    requireTool("avdmanager"),
    [
      "create",
      "avd",
      "--name",
      name,
      "--package",
      runtime.id,
      "--device",
      input.deviceTypeId,
    ],
    signal,
    "no\n",
  );
  return { ...completed, simulatorId: `android:${name}` };
}

export async function bootAndroidAvd(
  name: string,
  signal: AbortSignal,
  wipe = false,
): Promise<string> {
  androidAvdName(name);
  signal = AbortSignal.any([signal, AbortSignal.timeout(240_000)]);
  let serial = (await runningAndroidAvds(signal)).get(name);
  let processError: Error | undefined;
  const child = serial
    ? null
    : spawn(
        requireTool("emulator"),
        [
          "-avd",
          name,
          "-no-window",
          "-no-audio",
          "-no-boot-anim",
          ...(wipe ? ["-wipe-data", "-no-snapshot"] : []),
        ],
        { detached: true, stdio: "ignore" },
      );
  if (serial && wipe)
    throw new Error("Shut down the emulator before wiping its data");
  child?.once("error", (error) => {
    processError = error;
  });
  child?.once("exit", (code, exitSignal) => {
    processError = new Error(
      `Android emulator exited before booting (${code ?? exitSignal}). Check the system image and hardware acceleration.`,
    );
  });
  child?.unref();
  try {
    for (;;) {
      signal.throwIfAborted();
      if (processError) throw processError;
      serial = (await runningAndroidAvds(signal)).get(name);
      if (serial && (await isBooted(serial, signal))) return serial;
      await sleep(1_500, undefined, { signal });
    }
  } catch (error) {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
    throw error;
  }
}

async function stopAndroidAvd(serial: string, signal: AbortSignal) {
  await adb(["-s", serial, "emu", "kill"], signal);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  for (;;) {
    const active = await adb(["devices"], deadline);
    if (
      !active
        .split(/\r?\n/)
        .some((line) => line.trim().split(/\s+/)[0] === serial)
    )
      return;
    await sleep(500, undefined, { signal: deadline });
  }
}

export async function performAndroidSimulatorAction(
  input: SimulatorActionPayload,
  signal: AbortSignal,
) {
  const avd = findDevice(
    await devices(await runtimes(signal), signal),
    input.simulatorId,
  );
  const { name, serial } = avd;
  switch (input.action) {
    case "BOOT":
      if (!avd.isAvailable) throw new Error(avd.availabilityError!);
      await bootAndroidAvd(name, signal);
      break;
    case "SHUTDOWN":
      if (serial) await stopAndroidAvd(serial, signal);
      break;
    case "REBOOT":
      if (!serial) throw new Error("Boot the emulator before restarting it");
      await stopAndroidAvd(serial, signal);
      await bootAndroidAvd(name, signal);
      break;
    case "ERASE":
      if (serial)
        throw new Error("Shut down the emulator before wiping its data");
      await stopAndroidAvd(await bootAndroidAvd(name, signal, true), signal);
      break;
    case "RENAME":
      if (serial) throw new Error("Shut down the emulator before renaming it");
      if (name !== input.name)
        await command(
          requireTool("avdmanager"),
          ["move", "avd", "--name", name, "--rename", input.name],
          signal,
        );
      return { ...completed, simulatorId: `android:${input.name}` };
    case "CLONE":
      if (serial)
        throw new Error("Shut down the emulator before duplicating it");
      return createAndroidSimulator(
        simulatorCreatePayload({
          platform: "ANDROID",
          name: input.name,
          runtimeId: avd.runtimeId,
          deviceTypeId: avd.deviceTypeId,
        }),
        signal,
      );
    case "DELETE":
      if (serial) throw new Error("Shut down the emulator before deleting it");
      await command(
        requireTool("avdmanager"),
        ["delete", "avd", "--name", name],
        signal,
      );
      break;
    case "LAUNCH_APP":
    case "TERMINATE_APP": {
      if (!serial || avd.state !== "Booted")
        throw new Error("Boot the emulator before controlling its apps");
      const app = (await installedApps(serial, signal)).find(
        (entry) => entry.bundleId === input.bundleId,
      );
      if (!app)
        throw new Error("App is not installed on this Android emulator");
      if (input.action === "TERMINATE_APP") {
        await adb(
          ["-s", serial, "shell", "am", "force-stop", app.bundleId],
          signal,
        );
      } else {
        const component = await adb(
          [
            "-s",
            serial,
            "shell",
            "cmd",
            "package",
            "resolve-activity",
            "--brief",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LAUNCHER",
            "-p",
            app.bundleId,
          ],
          signal,
        );
        const activity = component.split(/\r?\n/).at(-1);
        if (
          !activity?.startsWith(`${app.bundleId}/`) ||
          !/^[A-Za-z0-9_.$/]+$/.test(activity)
        )
          throw new Error("App has no launcher activity");
        const launched = await adb(
          [
            "-s",
            serial,
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            "'" + activity + "'",
          ],
          signal,
        );
        if (/\bError\b|Status:\s*(?!ok\b)\S/i.test(launched))
          throw new Error(launched);
      }
      break;
    }
    case "OPEN_DATA_FOLDER":
      if (!avd.dataPath)
        throw new Error("The AVD data folder is unavailable on this Mac");
      await command("/usr/bin/open", ["-a", "Finder", avd.dataPath], signal);
      break;
    default:
      throw new Error("This simulator action is unavailable for Android");
  }
  return completed;
}
