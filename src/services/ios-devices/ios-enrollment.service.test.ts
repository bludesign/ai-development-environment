// @vitest-environment node
import { plistDocument } from "@ai-development-environment/agent-contract/plist";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrismaClient: vi.fn(),
  verifyResponse: vi.fn(),
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

vi.mock("./crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("./crypto")>();
  return {
    ...original,
    verifyAppleDeviceResponse: mocks.verifyResponse,
  };
});

import { sha256 } from "./crypto";
import { IosDevicesService, IosEnrollmentError } from "./ios-devices.service";

type EnrollmentState = {
  id: string;
  deviceId: string | null;
  tokenHash: string;
  displayName: string;
  status: string;
  expiresAt: Date;
  downloadedAt: Date | null;
  consumedAt: Date | null;
  responseDigest: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DeviceState = {
  id: string;
  udid: string;
  displayName: string;
  product: string | null;
  osVersion: string | null;
  platform: string;
  status: string;
  appleDeviceId: string | null;
  appleStatus: string | null;
  registrationError: string | null;
  registrationClaimedAt: Date | null;
  registeredAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type IpState = {
  id: string;
  enrollmentId: string;
  deviceId: string | null;
  source: string;
  ipAddress: string;
  headerSource: string;
  observedAt: Date;
};

const token = "0123456789abcdef0123456789abcdef0123456789a";
let enrollment: EnrollmentState;
let devices: DeviceState[];
let ips: IpState[];

function makeDevice(overrides: Partial<DeviceState> = {}): DeviceState {
  return {
    id: "device-1",
    udid: "00008030-001C2D3E4F50002E",
    displayName: "Administrator label",
    product: "iPhone15,2",
    osVersion: "18.5",
    platform: "IOS",
    status: "PENDING",
    appleDeviceId: null,
    appleStatus: null,
    registrationError: null,
    registrationClaimedAt: null,
    registeredAt: null,
    lastSeenAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setupPrisma() {
  const iosDeviceEnrollment = {
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; tokenHash?: string } }) =>
        (where.id && where.id === enrollment.id) ||
        (where.tokenHash && where.tokenHash === enrollment.tokenHash)
          ? enrollment
          : null,
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; consumedAt?: null };
        data: Partial<EnrollmentState>;
      }) => {
        if (
          where.id !== enrollment.id ||
          (where.consumedAt === null && enrollment.consumedAt !== null)
        ) {
          return { count: 0 };
        }
        Object.assign(enrollment, data, { updatedAt: new Date() });
        return { count: 1 };
      },
    ),
    update: vi.fn(async ({ data }: { data: Partial<EnrollmentState> }) => {
      Object.assign(enrollment, data, { updatedAt: new Date() });
      return enrollment;
    }),
  };
  const iosDevice = {
    findUnique: vi.fn(
      async ({ where }: { where: { id?: string; udid?: string } }) =>
        devices.find(
          (device) =>
            (where.id && device.id === where.id) ||
            (where.udid && device.udid === where.udid),
        ) ?? null,
    ),
    create: vi.fn(
      async ({ data }: { data: Partial<DeviceState> & { id: string } }) => {
        const device = makeDevice({
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        devices.push(device);
        return device;
      },
    ),
    update: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<DeviceState>;
      }) => {
        const device = devices.find((entry) => entry.id === where.id);
        if (!device) throw new Error("Device not found");
        Object.assign(device, data, { updatedAt: new Date() });
        return device;
      },
    ),
    updateMany: vi.fn(async () => ({ count: 0 })),
  };
  const iosDeviceIpObservation = {
    updateMany: vi.fn(async ({ data }: { data: { deviceId: string } }) => {
      for (const observation of ips) observation.deviceId = data.deviceId;
      return { count: ips.length };
    }),
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: IpState;
        update: Partial<IpState>;
      }) => {
        const existing = ips.find(
          (entry) =>
            entry.enrollmentId === create.enrollmentId &&
            entry.source === create.source &&
            entry.ipAddress === create.ipAddress,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const observation = { ...create, observedAt: new Date() };
        ips.push(observation);
        return observation;
      },
    ),
  };
  const prisma = {
    iosDeviceEnrollment,
    iosDevice,
    iosDeviceIpObservation,
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(prisma),
  };
  mocks.getPrismaClient.mockResolvedValue(prisma);
  return prisma;
}

beforeEach(() => {
  vi.clearAllMocks();
  enrollment = {
    id: "enrollment-1",
    deviceId: null,
    tokenHash: sha256(token),
    displayName: "Submitted label",
    status: "DOWNLOADED",
    expiresAt: new Date(Date.now() + 60_000),
    downloadedAt: new Date(),
    consumedAt: null,
    responseDigest: null,
    failureCode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  devices = [];
  ips = [
    {
      id: "ip-download",
      enrollmentId: enrollment.id,
      deviceId: null,
      source: "PROFILE_DOWNLOAD",
      ipAddress: "203.0.113.4",
      headerSource: "CLOUDFLARE",
      observedAt: new Date(),
    },
  ];
  setupPrisma();
  mocks.verifyResponse.mockResolvedValue(
    plistDocument({
      UDID: "00008030-001c2d3e4f50002e",
      PRODUCT: "iPhone16,1",
      VERSION: "19.0",
      CHALLENGE: token,
    }),
  );
});

describe("IosDevicesService enrollment completion", () => {
  test("atomically consumes the token, creates a device, and attaches IP history", async () => {
    const cms = new TextEncoder().encode("signed-response-one");
    const device = await new IosDevicesService().completeEnrollment(
      token,
      cms,
      { address: "198.51.100.8", source: "FORWARDED" },
    );

    expect(device).toMatchObject({
      udid: "00008030-001C2D3E4F50002E",
      displayName: "Submitted label",
      product: "iPhone16,1",
      osVersion: "19.0",
    });
    expect(enrollment).toMatchObject({
      deviceId: device?.id,
      status: "COMPLETED",
      responseDigest: sha256(cms),
      failureCode: null,
    });
    expect(enrollment.consumedAt).toBeInstanceOf(Date);
    expect(ips).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "PROFILE_DOWNLOAD",
          deviceId: device?.id,
        }),
        expect.objectContaining({
          source: "PROFILE_RESPONSE",
          ipAddress: "198.51.100.8",
          headerSource: "FORWARDED",
          deviceId: device?.id,
        }),
      ]),
    );
  });

  test("re-enrollment refreshes observations but preserves administrator and Apple state", async () => {
    devices.push(
      makeDevice({
        status: "REGISTERED",
        appleDeviceId: "apple-device-1",
        appleStatus: "ENABLED",
        registeredAt: new Date("2026-01-01T00:00:00Z"),
      }),
    );

    const device = await new IosDevicesService().completeEnrollment(
      token,
      new TextEncoder().encode("signed-response"),
      null,
    );

    expect(device).toMatchObject({
      displayName: "Administrator label",
      status: "REGISTERED",
      appleDeviceId: "apple-device-1",
      product: "iPhone16,1",
      osVersion: "19.0",
    });
  });

  test("allows an identical iOS retry after expiry and rejects a different replay", async () => {
    const service = new IosDevicesService();
    const cms = new TextEncoder().encode("signed-response");
    const first = await service.completeEnrollment(token, cms, null);
    enrollment.expiresAt = new Date(Date.now() - 60_000);

    const retry = await service.completeEnrollment(token, cms, null);
    expect(retry?.id).toBe(first?.id);
    expect(enrollment.status).toBe("COMPLETED");

    await expect(
      service.completeEnrollment(
        token,
        new TextEncoder().encode("different-response"),
        null,
      ),
    ).rejects.toMatchObject({ status: 409, code: "TOKEN_CONSUMED" });
  });

  test("allows only one overlapping response to claim an enrollment", async () => {
    let verificationCount = 0;
    let releaseVerification!: () => void;
    const bothVerifying = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    mocks.verifyResponse.mockImplementation(async (cmsBytes: Uint8Array) => {
      verificationCount += 1;
      if (verificationCount === 2) releaseVerification();
      await bothVerifying;
      const first = new TextDecoder().decode(cmsBytes).endsWith("one");
      return plistDocument({
        UDID: first ? "00008030-001C2D3E4F50002E" : "00008030-001C2D3E4F50003F",
        PRODUCT: first ? "iPhone16,1" : "iPhone16,2",
        VERSION: "19.0",
        CHALLENGE: token,
      });
    });

    const results = await Promise.allSettled([
      new IosDevicesService().completeEnrollment(
        token,
        new TextEncoder().encode("signed-response-one"),
        null,
      ),
      new IosDevicesService().completeEnrollment(
        token,
        new TextEncoder().encode("signed-response-two"),
        null,
      ),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      code: "TOKEN_CONSUMED",
    });
    expect(devices).toHaveLength(1);
    expect(enrollment.deviceId).toBe(devices[0]?.id);
    expect(enrollment.responseDigest).toBe(
      sha256(
        new TextEncoder().encode(
          devices[0]?.udid.endsWith("002E")
            ? "signed-response-one"
            : "signed-response-two",
        ),
      ),
    );
  });

  test("marks malformed device attributes failed before persisting a device", async () => {
    mocks.verifyResponse.mockResolvedValue(
      plistDocument({
        UDID: "invalid!",
        PRODUCT: "iPhone",
        VERSION: "19.0",
        CHALLENGE: token,
      }),
    );

    await expect(
      new IosDevicesService().completeEnrollment(
        token,
        new Uint8Array([1, 2, 3]),
        null,
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: "INVALID_DEVICE_RESPONSE",
    } satisfies Partial<IosEnrollmentError>);
    expect(enrollment).toMatchObject({
      status: "FAILED",
      failureCode: "INVALID_DEVICE_RESPONSE",
    });
    expect(devices).toHaveLength(0);
  });

  test("expires an unconsumed token before CMS validation", async () => {
    enrollment.expiresAt = new Date(Date.now() - 1);
    await expect(
      new IosDevicesService().completeEnrollment(
        token,
        new Uint8Array([1]),
        null,
      ),
    ).rejects.toMatchObject({ status: 410, code: "TOKEN_EXPIRED" });
    expect(enrollment.status).toBe("EXPIRED");
    expect(mocks.verifyResponse).not.toHaveBeenCalled();
  });
});
