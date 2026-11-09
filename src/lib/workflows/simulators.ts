import {
  SIMULATOR_ACTIONS,
  type SimulatorAction,
} from "@ai-development-environment/agent-contract/simulators";

export const SIMULATOR_DEVICE_ACTIONS = [
  "BOOT",
  "SHUTDOWN",
  "REBOOT",
  "RENAME",
  "CLONE",
  "ERASE",
] as const satisfies readonly SimulatorAction[];

export const SIMULATOR_APP_ACTIONS = [
  "LAUNCH_APP",
  "TERMINATE_APP",
] as const satisfies readonly SimulatorAction[];

export const SIMULATOR_FOLDER_ACTIONS = [
  "OPEN_DATA_FOLDER",
  "OPEN_APP_BUNDLE_FOLDER",
  "OPEN_APP_DATA_FOLDER",
] as const satisfies readonly SimulatorAction[];

export const SIMULATOR_COMPLETION_OPERATIONS = [
  "CREATE",
  "RESET",
  ...SIMULATOR_ACTIONS,
] as const;

export const SIMULATOR_COMPLETION_STATUSES = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
] as const;
