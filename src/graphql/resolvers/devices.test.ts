import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { IosDevicesService } from "@/services/ios-devices";

import { createIosDeviceResolvers } from "./devices";

const context = (agentId: string | null) => ({ agentId }) as GraphQLContext;

describe("iOS device resolver authorization", () => {
  test("allows control-plane reads and mutations", async () => {
    const service = {
      devices: vi.fn().mockResolvedValue([]),
      deviceFirmware: vi.fn().mockResolvedValue({
        name: "iPhone 11",
        identifier: "iPhone12,1",
        firmwares: [],
      }),
      renameDevice: vi.fn().mockResolvedValue({ id: "device-1" }),
    } as unknown as IosDevicesService;
    const resolvers = createIosDeviceResolvers(service);

    await expect(
      resolvers.Query.iosDevices({}, {}, context(null)),
    ).resolves.toEqual([]);
    await expect(
      resolvers.Query.iosDeviceFirmware({}, { id: "device-1" }, context(null)),
    ).resolves.toMatchObject({ name: "iPhone 11" });
    expect(service.deviceFirmware).toHaveBeenCalledWith("device-1");
    await expect(
      resolvers.Mutation.renameIosDevice(
        {},
        { id: "device-1", displayName: "New label" },
        context(null),
      ),
    ).resolves.toEqual({ id: "device-1" });
    expect(service.renameDevice).toHaveBeenCalledWith("device-1", "New label");
  });

  test("rejects reads, secret settings, mutations, and subscriptions from agents", () => {
    const service = {
      devices: vi.fn(),
      deviceFirmware: vi.fn(),
      getSettings: vi.fn(),
      deleteDevice: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as IosDevicesService;
    const resolvers = createIosDeviceResolvers(service);
    const agent = context("agent-1");

    expect(() => resolvers.Query.iosDevices({}, {}, agent)).toThrow(
      /cannot perform control-plane operations/,
    );
    expect(() =>
      resolvers.Query.iosDeviceFirmware({}, { id: "device-1" }, agent),
    ).toThrow(/cannot perform control-plane operations/);
    expect(() => resolvers.Query.iosDeviceSettings({}, {}, agent)).toThrow(
      /cannot perform control-plane operations/,
    );
    expect(() =>
      resolvers.Mutation.deleteIosDevice({}, { id: "device-1" }, agent),
    ).toThrow(/cannot perform control-plane operations/);
    expect(() =>
      resolvers.Subscription.iosDevicesChanged.subscribe({}, {}, agent),
    ).toThrow(/cannot perform control-plane operations/);
  });
});
