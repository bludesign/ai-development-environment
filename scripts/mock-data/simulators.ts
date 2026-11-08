import {
  SIMULATOR_INSPECT_JOB_KIND,
  SIMULATOR_INVENTORY_JOB_KIND,
  type Simulator,
  type SimulatorDetails,
  type SimulatorInventory,
  type SimulatorRuntime,
} from "@ai-development-environment/agent-contract/simulators";

import type { PrismaClient } from "../../src/generated/prisma/client";
import { ids } from "./ids";
import { secondsAgo } from "./time";

const runtimeVersion = "27.2";

function runtime(platform: string, models: string[]): SimulatorRuntime {
  const identifier = platform === "visionOS" ? "xrOS" : platform;
  return {
    id: `com.apple.CoreSimulator.SimRuntime.${identifier}-27-2`,
    name: `${platform} ${runtimeVersion}`,
    platform,
    version: runtimeVersion,
    deviceTypes: models.map((name) => ({
      name,
      id: `com.apple.CoreSimulator.SimDeviceType.${name.replaceAll(" ", "-")}`,
    })),
  };
}

const ios = runtime("iOS", ["iPhone 18 Pro", "iPad Air"]);
const tvos = runtime("tvOS", ["Apple TV 4K"]);
const watchos = runtime("watchOS", ["Apple Watch Series 12"]);
const visionos = runtime("visionOS", ["Apple Vision Pro"]);

function device(
  runtime: SimulatorRuntime,
  id: string,
  name: string,
  state = "Shutdown",
): Simulator {
  return {
    id,
    name,
    runtimeId: runtime.id,
    runtimeName: runtime.name,
    platform: runtime.platform,
    deviceTypeId: runtime.deviceTypes[0]!.id,
    state,
    isAvailable: true,
    availabilityError: null,
    dataPath: `/Users/acme/Library/Developer/CoreSimulator/Devices/${id}/data`,
  };
}

const capturedSimulator = device(
  ios,
  ids.simulators.ios,
  "QA iPhone 18 Pro",
  "Booted",
);

const studioInventory: SimulatorInventory = {
  simulators: [
    capturedSimulator,
    device(tvos, ids.simulators.tvos, "Living Room Apple TV"),
    device(watchos, ids.simulators.watchos, "Watch QA"),
  ],
  runtimes: [ios, tvos, watchos],
};

const buildInventory: SimulatorInventory = {
  simulators: [device(visionos, ids.simulators.visionos, "Vision Preview")],
  runtimes: [visionos],
};

const ciInventory: SimulatorInventory = {
  simulators: [
    {
      ...device(ios, ids.simulators.legacyIOS, "Legacy iPhone QA"),
      runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
      runtimeName: "iOS 18.6",
      deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      isAvailable: false,
      availabilityError: "The iOS 18.6 runtime is no longer installed.",
    },
  ],
  runtimes: [],
};

const details: SimulatorDetails = {
  simulator: capturedSimulator,
  apps: [
    {
      bundleId: "com.acme.weather",
      name: "Acme Weather",
      version: "2.4.0",
      build: "164",
      bundlePath: `${capturedSimulator.dataPath}/Containers/Bundle/Application/3B7463DE-CB30-4705-B17D-707F875532DD/Weather.app`,
      dataPath: `${capturedSimulator.dataPath}/Containers/Data/Application/E4423B42-E3AF-4D5F-9B57-97D7D3065E9E`,
    },
    {
      bundleId: "com.acme.mobile",
      name: "Acme Mobile",
      version: "1.8.2",
      build: "87",
      bundlePath: `${capturedSimulator.dataPath}/Containers/Bundle/Application/4C29C56B-D9E8-4AA8-84A2-38148F92F142/Acme Mobile.app`,
      dataPath: null,
    },
  ],
};

export async function seedSimulators(prisma: PrismaClient): Promise<void> {
  const terminal = {
    status: "SUCCEEDED" as const,
    visibility: "SYSTEM" as const,
    timeoutSeconds: 30,
    createdAt: secondsAgo(120),
    startedAt: secondsAgo(119),
    finishedAt: secondsAgo(118),
  };
  await prisma.agentJob.createMany({
    data: [
      ...(
        [
          [ids.agents.studio, studioInventory],
          [ids.agents.build, buildInventory],
          [ids.agents.ci, ciInventory],
        ] as const
      ).map(([agentId, inventory]) => ({
        ...terminal,
        id: `job-simulator-inventory-${agentId}`,
        agentId,
        kind: SIMULATOR_INVENTORY_JOB_KIND,
        idempotencyKey: `${SIMULATOR_INVENTORY_JOB_KIND}:${ids.simulators.inventoryRequest}`,
        payloadJson: "{}",
        resultJson: JSON.stringify({ inventory }),
      })),
      {
        ...terminal,
        id: "job-simulator-detail-ios",
        agentId: ids.agents.studio,
        kind: SIMULATOR_INSPECT_JOB_KIND,
        idempotencyKey: `${SIMULATOR_INSPECT_JOB_KIND}:${ids.simulators.detailRequest}`,
        payloadJson: JSON.stringify({ simulatorId: capturedSimulator.id }),
        resultJson: JSON.stringify({ details }),
      },
    ],
  });
}
