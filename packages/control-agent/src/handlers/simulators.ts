import { lstat, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canDeleteSimulator,
  simulatorActionPayload,
  simulatorCreatePayload,
  simulatorEmptyPayload,
  simulatorId,
  simulatorInspectPayload,
  type Simulator,
  type SimulatorApp,
  type SimulatorDetails,
  type SimulatorDeviceType,
  type SimulatorInventory,
  type SimulatorRuntime,
} from "@ai-development-environment/agent-contract/simulators";

import { captureCommand } from "../capture-command.js";

type Fields = Record<string, unknown>;
type RuntimeDeviceType = SimulatorDeviceType & { profilePath: string | null };
type RuntimeProfile = Omit<SimulatorRuntime, "deviceTypes"> & {
  isAvailable: boolean;
  deviceTypes: RuntimeDeviceType[];
};
type SimulatorHostInventory = {
  simulators: Simulator[];
  runtimes: RuntimeProfile[];
};

class SimulatorCommandTimeoutError extends Error {}

const completed = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
} as const;

function record(value: unknown): Fields {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function versionString(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : string(value);
}

function rows(value: unknown): Fields[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function available(value: Fields): boolean {
  return typeof value.isAvailable === "boolean"
    ? value.isAvailable
    : value.availability === "(available)";
}

function platformName(platform: unknown, runtimeId: string): string {
  const name =
    string(platform) ??
    runtimeId.match(/\.SimRuntime\.([^-]+)/)?.[1] ??
    "Unknown";
  return name === "xrOS" ? "visionOS" : name;
}

function profilePath(type: Fields): string | null {
  const bundlePath = string(type.bundlePath);
  return bundlePath && isAbsolute(bundlePath)
    ? join(bundlePath, "Contents", "Resources", "profile.plist")
    : null;
}

function parseInventory(value: unknown): SimulatorHostInventory {
  const list = record(value);
  if (
    !list.devices ||
    typeof list.devices !== "object" ||
    Array.isArray(list.devices) ||
    !Array.isArray(list.runtimes)
  ) {
    throw new Error("CoreSimulator returned invalid inventory");
  }
  const profiles = new Map(
    rows(list.devicetypes).map((type) => [type.identifier, type]),
  );
  const runtimes = new Map<string, RuntimeProfile>();
  for (const runtime of rows(list.runtimes)) {
    const id = string(runtime.identifier);
    const version = string(runtime.version);
    if (!id || !version)
      throw new Error("CoreSimulator returned an invalid runtime");
    const deviceTypes: RuntimeDeviceType[] = [];
    for (const supported of rows(runtime.supportedDeviceTypes)) {
      const id = string(supported.identifier);
      if (!id) continue;
      const profile = profiles.get(id);
      deviceTypes.push({
        id,
        name: string(supported.name) ?? string(profile?.name) ?? id,
        profilePath:
          profilePath(supported) ?? (profile ? profilePath(profile) : null),
      });
    }
    runtimes.set(id, {
      id,
      name: string(runtime.name) ?? id,
      platform: platformName(runtime.platform, id),
      version,
      isAvailable: available(runtime),
      deviceTypes,
    });
  }
  const simulators: Simulator[] = [];
  for (const [runtimeId, devices] of Object.entries(record(list.devices))) {
    if (!Array.isArray(devices))
      throw new Error("CoreSimulator returned invalid devices");
    const runtime = runtimes.get(runtimeId);
    for (const device of rows(devices)) {
      const id = simulatorId(device.udid);
      const path = string(device.dataPath);
      simulators.push({
        id,
        name: string(device.name) ?? id,
        runtimeId,
        runtimeName: runtime?.name ?? null,
        platform: runtime?.platform ?? platformName(null, runtimeId),
        deviceTypeId: string(device.deviceTypeIdentifier),
        state: string(device.state) ?? "Unknown",
        isAvailable: available(device),
        availabilityError: string(device.availabilityError),
        dataPath: path && isAbsolute(path) ? path : null,
      });
    }
  }
  return {
    simulators: simulators.sort(
      (left, right) =>
        left.platform.localeCompare(right.platform) ||
        left.name.localeCompare(right.name) ||
        left.runtimeId.localeCompare(right.runtimeId),
    ),
    runtimes: [...runtimes.values()],
  };
}

function publicInventory(host: SimulatorHostInventory): SimulatorInventory {
  return {
    simulators: host.simulators,
    runtimes: host.runtimes
      .filter((runtime) => runtime.isAvailable)
      .map(({ id, name, platform, version, deviceTypes }) => ({
        id,
        name,
        platform,
        version,
        deviceTypes: deviceTypes.map(({ id, name }) => ({ id, name })),
      })),
  };
}

function commandRunner(timeoutMs: number, signal: AbortSignal) {
  const deadline = Date.now() + timeoutMs;
  return async (
    command: string,
    args: string[],
    stdoutFileDescriptor?: number,
  ) => {
    signal.throwIfAborted();
    const result = await captureCommand({
      command,
      args,
      timeoutMs: deadline - Date.now(),
      signal,
      stdoutFileDescriptor,
    });
    signal.throwIfAborted();
    if (result.timedOut)
      throw new SimulatorCommandTimeoutError("Simulator operation timed out");
    if (result.outputTruncated)
      throw new Error("Simulator command output was too large");
    if (result.exitCode !== 0)
      throw new Error(
        result.stderr.trim().slice(0, 2_000) || "Simulator command failed",
      );
    return result.stdout.trim();
  };
}

type CommandRunner = ReturnType<typeof commandRunner>;

function simctl(run: CommandRunner, ...args: string[]): Promise<string> {
  return run("/usr/bin/xcrun", ["simctl", ...args]);
}

async function hostInventory(
  run: CommandRunner,
): Promise<SimulatorHostInventory> {
  return parseInventory(JSON.parse(await simctl(run, "list", "-j")));
}

function selectedSimulator(
  host: SimulatorHostInventory,
  id: string,
): Simulator {
  const simulator = host.simulators.find((device) => device.id === id);
  if (!simulator) throw new Error("Simulator not found on this agent");
  return simulator;
}

function checkState(simulator: Simulator, state: "Booted" | "Shutdown") {
  if (simulator.state !== state)
    throw new Error(
      `This action requires the simulator to be ${state === "Booted" ? "booted" : "shut down"}`,
    );
}

async function plist(run: CommandRunner, path: string): Promise<Fields> {
  return record(
    JSON.parse(
      await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path]),
    ),
  );
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function safeChild(
  parent: string,
  child: string,
  kind: "directory" | "file",
): Promise<string | null> {
  const path = join(parent, child);
  try {
    const stats = await lstat(path);
    if (!(kind === "directory" ? stats.isDirectory() : stats.isFile()))
      return null;
    return (await realpath(path)) === path ? path : null;
  } catch (error) {
    if (!missing(error)) throw error;
    return null;
  }
}

async function subdirectory(parent: string, ...components: string[]) {
  let path: string | null = parent;
  for (const component of components) {
    path = await safeChild(path, component, "directory");
    if (!path) return null;
  }
  return path;
}

function deviceSetPath(): string {
  return join(homedir(), "Library", "Developer", "CoreSimulator", "Devices");
}

async function simulatorDataDirectory(
  simulator: Simulator,
): Promise<string | null> {
  if (!simulator.dataPath) return null;
  try {
    const deviceSet = await realpath(deviceSetPath());
    const directory = await subdirectory(deviceSet, simulator.id, "data");
    return directory && (await realpath(simulator.dataPath)) === directory
      ? directory
      : null;
  } catch (error) {
    if (!missing(error)) throw error;
    return null;
  }
}

async function optionalPlist(
  run: CommandRunner,
  path: string,
  signal: AbortSignal,
): Promise<Fields> {
  try {
    return await plist(run, path);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SimulatorCommandTimeoutError) throw error;
    return {};
  }
}

async function shutdownApps(
  dataDirectory: string | null,
  run: CommandRunner,
  signal: AbortSignal,
): Promise<SimulatorApp[]> {
  if (!dataDirectory) return [];
  const bundleRoot = await subdirectory(
    dataDirectory,
    "Containers",
    "Bundle",
    "Application",
  );
  if (!bundleRoot) return [];

  const apps = new Map<string, SimulatorApp>();
  for (const entry of await readdir(bundleRoot, { withFileTypes: true })) {
    signal.throwIfAborted();
    if (!entry.isDirectory()) continue;
    const container = await subdirectory(bundleRoot, entry.name);
    if (!container) continue;
    for (const bundle of await readdir(container, { withFileTypes: true })) {
      if (!bundle.isDirectory() || !bundle.name.endsWith(".app")) continue;
      const bundlePath = await subdirectory(container, bundle.name);
      if (!bundlePath) continue;
      const infoPath = await safeChild(bundlePath, "Info.plist", "file");
      if (!infoPath) continue;
      const info = await optionalPlist(run, infoPath, signal);
      const bundleId = string(info.CFBundleIdentifier);
      if (!bundleId) continue;
      apps.set(bundleId, {
        bundleId,
        name:
          string(info.CFBundleDisplayName) ??
          string(info.CFBundleName) ??
          bundleId,
        version: versionString(info.CFBundleShortVersionString),
        build: versionString(info.CFBundleVersion),
        bundlePath,
        dataPath: null,
      });
    }
  }
  if (!apps.size) return [];
  const dataRoot = await subdirectory(
    dataDirectory,
    "Containers",
    "Data",
    "Application",
  );
  if (dataRoot) {
    for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (!entry.isDirectory()) continue;
      const path = await subdirectory(dataRoot, entry.name);
      if (!path) continue;
      const metadataPath = await safeChild(
        path,
        ".com.apple.mobile_container_manager.metadata.plist",
        "file",
      );
      if (!metadataPath) continue;
      const metadata = await optionalPlist(run, metadataPath, signal);
      const app = apps.get(string(metadata.MCMMetadataIdentifier) ?? "");
      if (app) app.dataPath = path;
    }
  }
  return [...apps.values()].sort(
    (first, second) =>
      first.name.localeCompare(second.name) ||
      first.bundleId.localeCompare(second.bundleId),
  );
}

async function liveAppPath(
  value: unknown,
  simulator: Simulator,
  dataDirectory: string | null,
  kind: "bundle" | "data",
) {
  const candidate = string(value);
  if (!candidate || !dataDirectory || !simulator.dataPath) return null;
  let path: string;
  try {
    path = candidate.startsWith("file:") ? fileURLToPath(candidate) : candidate;
  } catch {
    return null;
  }
  if (!isAbsolute(path)) return null;
  for (const base of new Set([simulator.dataPath, dataDirectory])) {
    const components = relative(base, path).split(sep);
    const [containers, folder, application, container, bundle] = components;
    if (
      containers !== "Containers" ||
      folder !== (kind === "bundle" ? "Bundle" : "Data") ||
      application !== "Application" ||
      !container ||
      components.length !== (kind === "bundle" ? 5 : 4) ||
      (kind === "bundle" && !bundle?.endsWith(".app"))
    )
      continue;
    return subdirectory(dataDirectory, ...components);
  }
  return null;
}

async function bootedApps(
  simulator: Simulator,
  dataDirectory: string | null,
  run: CommandRunner,
  signal: AbortSignal,
): Promise<SimulatorApp[]> {
  // listapps emits an OpenStep plist. Use plutil to read the same format as Xcode.
  const temporary = await mkdtemp(join(tmpdir(), "aide-simulator-apps-"));
  const path = join(temporary, "apps.plist");
  try {
    const output = await open(path, "wx", 0o600);
    try {
      await run(
        "/usr/bin/xcrun",
        ["simctl", "listapps", simulator.id],
        output.fd,
      );
      if ((await output.stat()).size > 2 * 1024 * 1024)
        throw new Error("Installed simulator app metadata is too large");
    } finally {
      await output.close();
    }
    const apps: SimulatorApp[] = [];
    for (const [id, value] of Object.entries(await plist(run, path))) {
      signal.throwIfAborted();
      const info = record(value);
      if (info.ApplicationType !== "User") continue;
      const bundleId = string(info.CFBundleIdentifier) ?? id;
      apps.push({
        bundleId,
        name:
          string(info.CFBundleDisplayName) ??
          string(info.CFBundleName) ??
          bundleId,
        version: versionString(info.CFBundleShortVersionString),
        build: versionString(info.CFBundleVersion),
        bundlePath: await liveAppPath(
          info.Path ?? info.Bundle,
          simulator,
          dataDirectory,
          "bundle",
        ),
        dataPath: await liveAppPath(
          info.DataContainer,
          simulator,
          dataDirectory,
          "data",
        ),
      });
    }
    return apps.sort(
      (first, second) =>
        first.name.localeCompare(second.name) ||
        first.bundleId.localeCompare(second.bundleId),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function installedApps(
  simulator: Simulator,
  dataDirectory: string | null,
  run: CommandRunner,
  signal: AbortSignal,
): Promise<SimulatorApp[]> {
  return simulator.state === "Booted"
    ? bootedApps(simulator, dataDirectory, run, signal)
    : shutdownApps(dataDirectory, run, signal);
}

async function openFolder(
  run: CommandRunner,
  path: string | null,
  reveal = false,
) {
  if (!path) throw new Error("The folder is not available on this Mac");
  try {
    await run("/usr/bin/open", reveal ? ["-R", path] : ["-a", "Finder", path]);
  } catch (error) {
    throw new Error(
      `Could not open Finder on this Mac: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function deleteDevice(run: CommandRunner, simulator: Simulator) {
  if (!canDeleteSimulator(simulator)) checkState(simulator, "Shutdown");
  await simctl(run, "delete", simulator.id);
}

export async function inventorySimulators(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
) {
  simulatorEmptyPayload(payload);
  const host = await hostInventory(commandRunner(timeoutMs, signal));
  return { ...completed, inventory: publicInventory(host) };
}

export async function inspectSimulator(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const input = simulatorInspectPayload(payload);
  const run = commandRunner(timeoutMs, signal);
  const simulator = selectedSimulator(
    await hostInventory(run),
    input.simulatorId,
  );
  const dataPath = await simulatorDataDirectory(simulator);
  const details: SimulatorDetails = {
    simulator: { ...simulator, dataPath },
    apps: await installedApps(simulator, dataPath, run, signal),
  };
  return { ...completed, details };
}

export async function createSimulator(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const input = simulatorCreatePayload(payload);
  const run = commandRunner(timeoutMs, signal);
  const runtime = (await hostInventory(run)).runtimes.find(
    (runtime) => runtime.id === input.runtimeId && runtime.isAvailable,
  );
  if (!runtime?.deviceTypes.some((type) => type.id === input.deviceTypeId))
    throw new Error(
      "The device type is not supported by the selected installed runtime",
    );
  const id = await createDevice(run, input);
  return { ...completed, simulatorId: id };
}

async function createDevice(
  run: CommandRunner,
  input: ReturnType<typeof simulatorCreatePayload>,
): Promise<string> {
  return simulatorId(
    await simctl(
      run,
      "create",
      input.name,
      input.deviceTypeId,
      input.runtimeId,
    ),
  );
}

export async function performSimulatorAction(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const input = simulatorActionPayload(payload);
  const run = commandRunner(timeoutMs, signal);
  const simulator = selectedSimulator(
    await hostInventory(run),
    input.simulatorId,
  );
  const id = simulator.id;
  if (
    !simulator.isAvailable &&
    input.action !== "DELETE" &&
    !input.action.startsWith("OPEN_")
  )
    throw new Error(
      simulator.availabilityError ?? "Simulator runtime is unavailable",
    );

  switch (input.action) {
    case "BOOT":
      if (simulator.state === "Booted") break;
      checkState(simulator, "Shutdown");
      await simctl(run, "bootstatus", id, "-b");
      break;
    case "SHUTDOWN":
      if (simulator.state === "Shutdown") break;
      checkState(simulator, "Booted");
      await simctl(run, "shutdown", id);
      break;
    case "REBOOT":
      checkState(simulator, "Booted");
      await simctl(run, "reboot", id);
      await simctl(run, "bootstatus", id);
      break;
    case "RENAME":
      if (simulator.name !== input.name)
        await simctl(run, "rename", id, input.name);
      break;
    case "CLONE":
      checkState(simulator, "Shutdown");
      return {
        ...completed,
        simulatorId: simulatorId(await simctl(run, "clone", id, input.name)),
      };
    case "ERASE":
      checkState(simulator, "Shutdown");
      await simctl(run, "erase", id);
      break;
    case "DELETE":
      await deleteDevice(run, simulator);
      break;
    case "OPEN_DATA_FOLDER":
      await openFolder(run, await simulatorDataDirectory(simulator));
      break;
    case "LAUNCH_APP":
    case "TERMINATE_APP":
    case "OPEN_APP_BUNDLE_FOLDER":
    case "OPEN_APP_DATA_FOLDER": {
      const launches = input.action === "LAUNCH_APP";
      const changesState = launches || input.action === "TERMINATE_APP";
      if (changesState) checkState(simulator, "Booted");
      const dataDirectory = await simulatorDataDirectory(simulator);
      const app = (
        await installedApps(simulator, dataDirectory, run, signal)
      ).find((app) => app.bundleId === input.bundleId);
      if (!app) throw new Error("App is not installed on this simulator");
      if (changesState) {
        await simctl(
          run,
          launches ? "launch" : "terminate",
          id,
          input.bundleId,
        );
      } else {
        const reveal = input.action === "OPEN_APP_BUNDLE_FOLDER";
        await openFolder(run, reveal ? app.bundlePath : app.dataPath, reveal);
      }
      break;
    }
  }
  return completed;
}

function compareVersions(first: string, second: string): number {
  if (![first, second].every((version) => /^\d+(?:\.\d+)*$/.test(version)))
    throw new Error("A simulator runtime has an invalid default version range");
  const left = first.split(".").map(Number);
  const right = second.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

async function defaultRoster(host: SimulatorHostInventory, run: CommandRunner) {
  const defaults: ReturnType<typeof simulatorCreatePayload>[] = [];
  const profiles = new Map<string, Fields>();
  for (const runtime of host.runtimes.filter(
    (runtime) => runtime.isAvailable,
  )) {
    if (!runtime.deviceTypes.length)
      throw new Error(
        `Xcode did not provide supported device types for ${runtime.name}`,
      );
    for (const type of runtime.deviceTypes) {
      if (!type.profilePath)
        throw new Error(
          `Xcode did not provide a device type profile for ${type.name}`,
        );
      let profile = profiles.get(type.profilePath);
      if (!profile) {
        profile = await plist(run, type.profilePath);
        profiles.set(type.profilePath, profile);
      }
      const raw = profile.createByDefaultForRuntimeVersions;
      if (raw === undefined) continue;
      const range = record(raw);
      const min = string(range.versionMin);
      const max = string(range.versionMax);
      if (!min || !max || compareVersions(min, max) > 0)
        throw new Error(`Invalid Xcode default version range for ${type.name}`);
      if (
        compareVersions(runtime.version, min) >= 0 &&
        compareVersions(runtime.version, max) <= 0
      )
        defaults.push(
          simulatorCreatePayload({
            name: type.name,
            runtimeId: runtime.id,
            deviceTypeId: type.id,
          }),
        );
    }
  }
  if (!defaults.length)
    throw new Error(
      "No Xcode default simulators were found for the installed runtimes",
    );
  return defaults;
}

export async function resetSimulators(
  payload: unknown,
  timeoutMs: number,
  signal: AbortSignal,
) {
  simulatorEmptyPayload(payload);
  const run = commandRunner(timeoutMs, signal);
  const host = await hostInventory(run);
  if (host.simulators.some((device) => device.state !== "Shutdown"))
    throw new Error("Shut down all simulators before resetting");
  const defaults = await defaultRoster(host, run);

  // Stage the full Xcode roster before touching an original simulator.
  const replacements: string[] = [];
  const originalIds = new Set(host.simulators.map((device) => device.id));
  let originals: Simulator[];
  try {
    for (const target of defaults) {
      const id = await createDevice(run, target);
      if (originalIds.has(id) || replacements.includes(id))
        throw new Error("Xcode did not return a new simulator ID");
      replacements.push(id);
    }
    const current = await hostInventory(run);
    if (
      !replacements.every((id, index) =>
        current.simulators.some(
          (device) =>
            device.id === id &&
            device.runtimeId === defaults[index]!.runtimeId &&
            device.deviceTypeId === defaults[index]!.deviceTypeId,
        ),
      )
    ) {
      throw new Error("The replacement simulators could not be verified");
    }
    originals = current.simulators.filter((device) =>
      originalIds.has(device.id),
    );
    if (originals.some((device) => device.state !== "Shutdown"))
      throw new Error(
        "A simulator started during reset. Shut it down and retry",
      );
  } catch (error) {
    // Staging may have exhausted the job deadline or been cancelled.
    const cleanup = commandRunner(30_000, new AbortController().signal);
    const leftovers: string[] = [];
    for (const id of replacements) {
      try {
        await simctl(cleanup, "delete", id);
      } catch {
        leftovers.push(id);
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not stage Xcode default simulators: ${reason}. Original simulators were kept.${leftovers.length ? ` ${leftovers.length} staged simulator(s) could not be cleaned up.` : ""}`,
    );
  }

  let deleted = 0;
  try {
    for (const original of originals) {
      const current = selectedSimulator(await hostInventory(run), original.id);
      if (current.state !== "Shutdown")
        throw new Error(
          "A simulator started during reset. Shut it down and retry",
        );
      await deleteDevice(run, current);
      deleted++;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Reset created ${replacements.length} defaults and removed ${deleted} of ${originals.length} original simulators: ${reason}`,
    );
  }
  return completed;
}
