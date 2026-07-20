// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { SigningAssetsService } from "./signing-assets.service";

describe("SigningAssetsService profile devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("matches profile UDIDs to enrolled devices without changing profile order", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "device-1",
        udid: "A".repeat(40),
        displayName: "Test iPhone",
        product: "iPhone17,1",
        osVersion: "26.0",
        status: "REGISTERED",
      },
    ]);
    getPrismaClient.mockResolvedValue({ iosDevice: { findMany } });
    const service = new SigningAssetsService({
      registerCompletionHandler: vi.fn(),
    } as never);

    const devices = await service.profileDevices([
      "a".repeat(40),
      "B".repeat(40),
      "A".repeat(40),
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { udid: { in: ["A".repeat(40), "B".repeat(40)] } },
      select: {
        id: true,
        udid: true,
        displayName: true,
        product: true,
        osVersion: true,
        status: true,
      },
    });
    expect(devices).toEqual([
      {
        udid: "a".repeat(40),
        deviceId: "device-1",
        displayName: "Test iPhone",
        product: "iPhone17,1",
        osVersion: "26.0",
        status: "REGISTERED",
      },
      {
        udid: "B".repeat(40),
        deviceId: null,
        displayName: null,
        product: null,
        osVersion: null,
        status: null,
      },
    ]);
  });
});
