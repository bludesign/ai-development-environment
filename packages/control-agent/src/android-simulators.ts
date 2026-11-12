import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  androidAvdName,
  androidSystemImage,
  type Simulator,
  type SimulatorActionPayload,
  type SimulatorApp,
  type SimulatorDeviceType,
  type SimulatorRuntime,
  type simulatorCreatePayload,
} from "@ai-development-environment/agent-contract/simulators";

import { androidTools } from "./android-tools.js";
import { captureCommand } from "./capture-command.js";

type CreateInput = ReturnType<typeof simulatorCreatePayload>;
type AvdConfiguration = {
  root: string;
  folder: string;
  registeredPath: string;
  metadata: Map<string, string>;
  config: Map<string, string>;
};
type Avd = Simulator & {
  serial: string | null;
  configuration: AvdConfiguration | null;
};

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

function avdHomes(): string[] {
  const { ANDROID_AVD_HOME, ANDROID_EMULATOR_HOME, ANDROID_USER_HOME } =
    process.env;
  const homes = [ANDROID_AVD_HOME ?? ""];
  if (ANDROID_EMULATOR_HOME) homes.push(join(ANDROID_EMULATOR_HOME, "avd"));
  if (ANDROID_USER_HOME) homes.push(join(ANDROID_USER_HOME, "avd"));
  homes.push(join(homedir(), ".android", "avd"));
  return [...new Set(homes.filter(Boolean).map((home) => resolve(home)))];
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

function unavailablePath(error: NodeJS.ErrnoException) {
  if (
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code ?? "")
  )
    return null;
  throw error;
}

async function readAvdIni(path: string): Promise<Map<string, string> | null> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(unavailablePath);
  if (!file) return null;
  try {
    return (await file.stat()).isFile()
      ? ini(await file.readFile("utf8"))
      : null;
  } catch (error) {
    return unavailablePath(error as NodeJS.ErrnoException);
  } finally {
    await file.close();
  }
}

async function avdConfig(name: string): Promise<AvdConfiguration | null> {
  for (const home of avdHomes()) {
    const root = await realpath(home).catch(unavailablePath);
    if (!root) continue;
    const registration = join(root, `${name}.ini`);
    const entry = await lstat(registration).catch(unavailablePath);
    if (!entry) continue;
    if (!entry.isFile()) return null;
    const metadata = await readAvdIni(registration);
    if (!metadata) return null;
    const relativePath = metadata.get("path.rel");
    const absolutePath = metadata.get("path");
    const candidates = [
      relativePath && !isAbsolute(relativePath)
        ? resolve(dirname(root), relativePath)
        : null,
      absolutePath && isAbsolute(absolutePath) ? absolutePath : null,
    ];
    for (const registeredPath of candidates) {
      if (!registeredPath) continue;
      const folder = await realpath(registeredPath).catch(unavailablePath);
      if (
        !folder ||
        !(await stat(folder).catch(unavailablePath))?.isDirectory()
      )
        continue;
      const config = await readAvdIni(join(folder, "config.ini"));
      return config ? { root, folder, registeredPath, metadata, config } : null;
    }
    return null;
  }
  return null;
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
        const configuration = await avdConfig(name);
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
          configuration,
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
      simulators: avds.map(
        ({ serial: _serial, configuration: _configuration, ...avd }) => avd,
      ),
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
  const {
    serial,
    configuration: _configuration,
    ...simulator
  } = findDevice(await devices(await runtimes(signal), signal), id);
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

function inside(folder: string, path: string) {
  return (
    path === folder || path.startsWith(folder === sep ? folder : folder + sep)
  );
}

async function writeAvdIni(
  path: string,
  values: Map<string, string>,
  flag = "w",
) {
  await writeFile(
    path,
    Array.from(values, ([key, value]) => `${key}=${value}\n`).join(""),
    { flag, mode: 0o600 },
  );
}

async function rebaseClonedImages(
  source: string,
  destination: string,
  images: string[],
  signal: AbortSignal,
) {
  const qemuImg = join(dirname(requireTool("emulator")), "qemu-img");
  const imageInfo = async (file: string) =>
    JSON.parse(
      await command(qemuImg, ["info", "--output=json", file], signal),
    ) as Record<string, unknown>;
  for (const image of images) {
    const copy = join(destination, relative(source, image));
    const info = await imageInfo(copy);
    const backing = info["backing-filename"];
    if (typeof backing !== "string" || !backing) continue;
    const backingPath = await realpath(resolve(dirname(image), backing));
    const newBacking = inside(source, backingPath)
      ? relative(dirname(image), backingPath)
      : backingPath;
    if (backing === newBacking) continue;
    const format =
      info["backing-filename-format"] ?? (await imageInfo(backingPath)).format;
    if (typeof format !== "string")
      throw new Error("Could not identify the AVD backing disk image format");
    await command(
      qemuImg,
      ["rebase", "-u", "-f", "qcow2", "-b", newBacking, "-F", format, copy],
      signal,
    );
  }
}

async function cloneAndroidSimulator(
  avd: Avd,
  name: string,
  signal: AbortSignal,
) {
  const source = avd.configuration;
  if (!source) throw new Error("The source AVD data folder is unavailable");
  if (inside(source.folder, source.root))
    throw new Error(
      "The source AVD data folder contains its registration directory",
    );

  // Use a unique unregistered data directory so a failed copy cannot hide an
  // existing AVD or prevent another attempt from registering the requested name.
  const folder = await mkdtemp(join(source.root, `${name}.avd-`));
  let registrationFolder: string | undefined;
  let registered = false;
  try {
    const images: string[] = [];
    await cp(source.folder, folder, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      preserveTimestamps: true,
      filter: async (path) => {
        signal.throwIfAborted();
        if (path !== source.folder && basename(path).endsWith(".lock"))
          return false;
        const entry = await lstat(path);
        if (!entry.isDirectory() && !entry.isFile())
          throw new Error(
            `Cannot clone the AVD entry ${relative(source.folder, path)}`,
          );
        if (entry.isFile() && path.endsWith(".qcow2")) images.push(path);
        return true;
      },
    });
    await rebaseClonedImages(source.folder, folder, images, signal);

    const sdCard = source.config.get("sdcard.path");
    let clonedSdCard: string | undefined;
    if (sdCard && isAbsolute(sdCard)) {
      const path = await realpath(sdCard);
      if (inside(source.folder, path)) {
        clonedSdCard = join(folder, relative(source.folder, path));
      } else {
        if (!(await stat(path)).isFile())
          throw new Error("The AVD SD card image is unavailable");
        const storage = await mkdtemp(join(folder, "sdcard-"));
        clonedSdCard = join(storage, "sdcard.img");
        await copyFile(
          path,
          clonedSdCard,
          constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
        );
      }
    }

    const config = new Map(source.config);
    config.set("AvdId", name);
    config.set("avd.ini.displayname", name);
    const hardwarePath = join(folder, "hardware-qemu.ini");
    const hardware = await readAvdIni(hardwarePath);
    if (hardware?.has("avd.name")) hardware.set("avd.name", name);
    if (hardware?.has("avd.id")) hardware.set("avd.id", name);
    const configs = [
      [join(folder, "config.ini"), config],
      ...(hardware ? [[hardwarePath, hardware] as const] : []),
    ] as const;
    for (const [path, values] of configs) {
      for (const [key, value] of values) {
        if (clonedSdCard && value === sdCard) values.set(key, clonedSdCard);
        else if (inside(source.registeredPath, value))
          values.set(key, folder + value.slice(source.registeredPath.length));
        else if (inside(source.folder, value))
          values.set(key, folder + value.slice(source.folder.length));
      }
      await writeAvdIni(path, values);
    }

    if ((await runningAndroidAvds(signal)).has(avd.name))
      throw new Error("Shut down the emulator before duplicating it");
    const metadata = new Map(source.metadata);
    metadata.set("path", folder);
    metadata.delete("path.rel");
    registrationFolder = await mkdtemp(join(folder, ".registration-"));
    const tempRegistration = join(registrationFolder, `${name}.ini`);
    await writeAvdIni(tempRegistration, metadata, "wx");
    signal.throwIfAborted();
    // Hard-linking publishes the complete registration without replacing a name
    // registered by another process while the data was being copied.
    await link(tempRegistration, join(source.root, `${name}.ini`)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new Error(`An Android emulator named ${name} already exists`);
        throw error;
      },
    );
    registered = true;
    return { ...completed, simulatorId: `android:${name}` };
  } finally {
    if (!registered) await rm(folder, { recursive: true, force: true });
    else if (registrationFolder)
      await rm(registrationFolder, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
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
  const avds = await devices(await runtimes(signal), signal);
  const avd = findDevice(avds, input.simulatorId);
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
    case "CLONE": {
      if (serial)
        throw new Error("Shut down the emulator before duplicating it");
      const copyName = androidAvdName(input.name);
      if (
        avds.some(
          (entry) => entry.name.toLowerCase() === copyName.toLowerCase(),
        )
      )
        throw new Error(`An Android emulator named ${copyName} already exists`);
      return cloneAndroidSimulator(avd, copyName, signal);
    }
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
