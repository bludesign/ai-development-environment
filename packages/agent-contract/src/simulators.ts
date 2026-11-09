export const SIMULATOR_INVENTORY_JOB_KIND = "simulators.inventory";
export const SIMULATOR_INSPECT_JOB_KIND = "simulators.inspect";
export const SIMULATOR_CREATE_JOB_KIND = "simulators.create";
export const SIMULATOR_RESET_JOB_KIND = "simulators.reset";
export const SIMULATOR_ACTION_JOB_KIND = "simulators.action";

export const SIMULATOR_JOB_KINDS = [
  SIMULATOR_INVENTORY_JOB_KIND,
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_CREATE_JOB_KIND,
  SIMULATOR_RESET_JOB_KIND,
  SIMULATOR_ACTION_JOB_KIND,
] as const;

export type SimulatorJobKind = (typeof SIMULATOR_JOB_KINDS)[number];

export const SIMULATOR_ACTIONS = [
  "BOOT",
  "SHUTDOWN",
  "REBOOT",
  "RENAME",
  "CLONE",
  "ERASE",
  "DELETE",
  "LAUNCH_APP",
  "TERMINATE_APP",
  "OPEN_DATA_FOLDER",
  "OPEN_APP_BUNDLE_FOLDER",
  "OPEN_APP_DATA_FOLDER",
] as const;

export type SimulatorAction = (typeof SIMULATOR_ACTIONS)[number];

export type Simulator = {
  id: string;
  name: string;
  runtimeId: string;
  runtimeName: string | null;
  platform: string;
  deviceTypeId: string | null;
  state: string;
  isAvailable: boolean;
  availabilityError: string | null;
  dataPath: string | null;
};

export function canDeleteSimulator({
  state,
  isAvailable,
}: Pick<Simulator, "state" | "isAvailable">): boolean {
  // CoreSimulator can leave records with a missing runtime stuck in Creating.
  return state === "Shutdown" || (state === "Creating" && !isAvailable);
}

export type SimulatorDeviceType = { id: string; name: string };

export type SimulatorRuntime = {
  id: string;
  name: string;
  platform: string;
  version: string;
  deviceTypes: SimulatorDeviceType[];
};

export type SimulatorInventory = {
  simulators: Simulator[];
  runtimes: SimulatorRuntime[];
};

export type SimulatorApp = {
  bundleId: string;
  name: string;
  version: string | null;
  build: string | null;
  bundlePath: string | null;
  dataPath: string | null;
};

export type SimulatorDetails = { simulator: Simulator; apps: SimulatorApp[] };

type Fields = Record<string, unknown>;

function object(value: unknown, label: string): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Fields;
}

function exactFields(value: Fields, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`Unexpected simulator field: ${unexpected}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, label: string): string | null {
  return value == null ? null : text(value, label);
}

function items<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid simulator result list");
  return value.map(parse);
}

export function simulatorId(value: unknown): string {
  const id = text(value, "Simulator ID");
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    throw new Error("Simulator ID must be a UUID");
  return id.toUpperCase();
}

function name(value: unknown): string {
  const label = text(value, "Simulator name").trim();
  if (
    !label ||
    label.length > 200 ||
    label.startsWith("-") ||
    [...label].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error(
      "Simulator name must be 1–200 characters and contain no command flags or control characters",
    );
  }
  return label;
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(id))
    throw new Error(`${label} is invalid`);
  return id;
}

export function simulatorEmptyPayload(value: unknown) {
  exactFields(object(value, "Simulator payload"), []);
  return {};
}

export function simulatorInspectPayload(value: unknown) {
  const input = object(value, "Simulator details payload");
  exactFields(input, ["simulatorId"]);
  return { simulatorId: simulatorId(input.simulatorId) };
}

export function simulatorCreatePayload(value: unknown) {
  const input = object(value, "Create simulator payload");
  exactFields(input, ["name", "runtimeId", "deviceTypeId"]);
  return {
    name: name(input.name),
    runtimeId: identifier(input.runtimeId, "Runtime ID"),
    deviceTypeId: identifier(input.deviceTypeId, "Device type ID"),
  };
}

export type SimulatorActionPayload =
  | { simulatorId: string; action: "RENAME" | "CLONE"; name: string }
  | {
      simulatorId: string;
      action:
        | "LAUNCH_APP"
        | "TERMINATE_APP"
        | "OPEN_APP_BUNDLE_FOLDER"
        | "OPEN_APP_DATA_FOLDER";
      bundleId: string;
    }
  | {
      simulatorId: string;
      action:
        | "BOOT"
        | "SHUTDOWN"
        | "REBOOT"
        | "ERASE"
        | "DELETE"
        | "OPEN_DATA_FOLDER";
    };

export function simulatorActionPayload(value: unknown): SimulatorActionPayload {
  const input = object(value, "Simulator action payload");
  const id = simulatorId(input.simulatorId);
  switch (input.action) {
    case "RENAME":
    case "CLONE":
      exactFields(input, ["simulatorId", "action", "name"]);
      return { simulatorId: id, action: input.action, name: name(input.name) };
    case "LAUNCH_APP":
    case "TERMINATE_APP":
    case "OPEN_APP_BUNDLE_FOLDER":
    case "OPEN_APP_DATA_FOLDER":
      exactFields(input, ["simulatorId", "action", "bundleId"]);
      return {
        simulatorId: id,
        action: input.action,
        bundleId: identifier(input.bundleId, "Bundle ID"),
      };
    case "BOOT":
    case "SHUTDOWN":
    case "REBOOT":
    case "ERASE":
    case "DELETE":
    case "OPEN_DATA_FOLDER":
      exactFields(input, ["simulatorId", "action"]);
      return { simulatorId: id, action: input.action };
    default:
      throw new Error("Unsupported simulator action");
  }
}

function parseSimulator(value: unknown): Simulator {
  const result = object(value, "Simulator");
  if (typeof result.isAvailable !== "boolean")
    throw new Error("Simulator availability is invalid");
  return {
    id: simulatorId(result.id),
    name: text(result.name, "Simulator name"),
    runtimeId: text(result.runtimeId, "Runtime ID"),
    runtimeName: optionalText(result.runtimeName, "Runtime name"),
    platform: text(result.platform, "Simulator platform"),
    deviceTypeId: optionalText(result.deviceTypeId, "Device type ID"),
    state: text(result.state, "Simulator state"),
    isAvailable: result.isAvailable,
    availabilityError: optionalText(
      result.availabilityError,
      "Availability error",
    ),
    dataPath: optionalText(result.dataPath, "Simulator data path"),
  };
}

export function parseSimulatorInventory(value: unknown): SimulatorInventory {
  const result = object(value, "Simulator inventory");
  return {
    simulators: items(result.simulators, parseSimulator),
    runtimes: items(result.runtimes, (value) => {
      const runtime = object(value, "Simulator runtime");
      return {
        id: text(runtime.id, "Runtime ID"),
        name: text(runtime.name, "Runtime name"),
        platform: text(runtime.platform, "Runtime platform"),
        version: text(runtime.version, "Runtime version"),
        deviceTypes: items(runtime.deviceTypes, (value) => {
          const type = object(value, "Simulator device type");
          return {
            id: text(type.id, "Device type ID"),
            name: text(type.name, "Device type name"),
          };
        }),
      };
    }),
  };
}

export function parseSimulatorDetails(value: unknown): SimulatorDetails {
  const result = object(value, "Simulator details");
  return {
    simulator: parseSimulator(result.simulator),
    apps: items(result.apps, (value) => {
      const app = object(value, "Simulator app");
      return {
        bundleId: text(app.bundleId, "Bundle ID"),
        name: text(app.name, "App name"),
        version: optionalText(app.version, "App version"),
        build: optionalText(app.build, "App build"),
        bundlePath: optionalText(app.bundlePath, "App bundle path"),
        dataPath: optionalText(app.dataPath, "App data path"),
      };
    }),
  };
}
