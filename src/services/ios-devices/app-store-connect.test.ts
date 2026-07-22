// @vitest-environment node
import {
  decodeJwt,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
} from "jose";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
const credentialState = vi.hoisted(() => ({
  appStorePrivateKey: "" as string | null,
  signerPrivateKey: null as string | null,
}));
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

vi.mock("@/services/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/credentials")>();
  return {
    ...original,
    CredentialService: class {
      async isConfigured(descriptor: { id: string }) {
        return descriptor.id.includes("app-store-connect")
          ? Boolean(credentialState.appStorePrivateKey)
          : Boolean(credentialState.signerPrivateKey);
      }

      async getText(descriptor: { id: string }) {
        return descriptor.id.includes("app-store-connect")
          ? credentialState.appStorePrivateKey
          : credentialState.signerPrivateKey;
      }

      async setText(
        descriptor: { id: string },
        value: string,
        mutation?: (transaction: unknown) => Promise<void>,
      ) {
        await mutation?.(await getPrismaClient());
        if (descriptor.id.includes("app-store-connect")) {
          credentialState.appStorePrivateKey = value;
          settings.appStoreConnectPrivateKey = value;
        } else {
          credentialState.signerPrivateKey = value;
          settings.signerPrivateKeyPem = value;
        }
      }

      async delete(
        descriptor: { id: string },
        mutation?: (transaction: unknown) => Promise<void>,
      ) {
        await mutation?.(await getPrismaClient());
        if (descriptor.id.includes("app-store-connect")) {
          credentialState.appStorePrivateKey = null;
          settings.appStoreConnectPrivateKey = null;
        }
      }
    },
  };
});

import { IosDevicesService } from "./ios-devices.service";

type SettingsState = {
  id: string;
  organizationName: string;
  profileIdentifier: string;
  signerCertificatePem: string | null;
  signerPrivateKeyPem: string | null;
  signerFingerprint: string | null;
  signerCreatedAt: Date | null;
  signerExpiresAt: Date | null;
  appStoreConnectIssuerId: string | null;
  appStoreConnectKeyId: string | null;
  appStoreConnectPrivateKey: string | null;
  appStoreConnectPrivateKeyFingerprint: string | null;
  appStoreConnectVerifiedAt: Date | null;
  appStoreConnectLastTestedAt: Date | null;
  appStoreConnectVerificationError: string | null;
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
  enrollments: unknown[];
  ipObservations: unknown[];
};

let p8: string;
let settings: SettingsState;
let device: DeviceState;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setupPrisma() {
  const matchesWhere = (where: {
    id?: string;
    status?: string | { in?: string[]; not?: string };
    registrationClaimedAt?: Date;
    OR?: Array<{
      registrationClaimedAt: null | { lt: Date };
    }>;
  }) => {
    if (where.id && where.id !== device.id) return false;
    if (typeof where.status === "string" && where.status !== device.status) {
      return false;
    }
    if (
      typeof where.status === "object" &&
      where.status.in &&
      !where.status.in.includes(device.status)
    ) {
      return false;
    }
    if (
      typeof where.status === "object" &&
      where.status.not === device.status
    ) {
      return false;
    }
    if (
      where.registrationClaimedAt &&
      where.registrationClaimedAt.getTime() !==
        device.registrationClaimedAt?.getTime()
    ) {
      return false;
    }
    if (
      where.OR &&
      !where.OR.some(({ registrationClaimedAt }) =>
        registrationClaimedAt === null
          ? device.registrationClaimedAt === null
          : Boolean(
              device.registrationClaimedAt &&
              device.registrationClaimedAt < registrationClaimedAt.lt,
            ),
      )
    ) {
      return false;
    }
    return true;
  };
  const prisma = {
    iosDeviceSettings: {
      upsert: vi.fn(async () => settings),
      update: vi.fn(async ({ data }: { data: Partial<SettingsState> }) => {
        Object.assign(settings, data, { updatedAt: new Date() });
        return settings;
      }),
    },
    iosDevice: {
      findUnique: vi.fn(async () => device),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Parameters<typeof matchesWhere>[0];
          data: Partial<DeviceState>;
        }) => {
          if (!matchesWhere(where)) return { count: 0 };
          Object.assign(device, data, { updatedAt: new Date() });
          return { count: 1 };
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: Parameters<typeof matchesWhere>[0] }) => {
          if (!matchesWhere(where)) return { count: 0 };
          return { count: 1 };
        },
      ),
      findMany: vi.fn(async () => [device]),
      update: vi.fn(async ({ data }: { data: Partial<DeviceState> }) => {
        Object.assign(device, data, { updatedAt: new Date() });
        return device;
      }),
    },
  };
  getPrismaClient.mockResolvedValue(prisma);
  return prisma;
}

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  p8 = await exportPKCS8(privateKey);
});

beforeEach(() => {
  vi.clearAllMocks();
  settings = {
    id: "default",
    organizationName: "Test Organization",
    profileIdentifier: "com.example.device-enrollment",
    signerCertificatePem: null,
    signerPrivateKeyPem: null,
    signerFingerprint: null,
    signerCreatedAt: null,
    signerExpiresAt: null,
    appStoreConnectIssuerId: "00000000-1111-2222-3333-444444444444",
    appStoreConnectKeyId: "ABC123DEFG",
    appStoreConnectPrivateKey: p8,
    appStoreConnectPrivateKeyFingerprint: "fingerprint",
    appStoreConnectVerifiedAt: new Date(),
    appStoreConnectLastTestedAt: new Date(),
    appStoreConnectVerificationError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  credentialState.appStorePrivateKey = p8;
  credentialState.signerPrivateKey = null;
  device = {
    id: "device-1",
    udid: "00008030-001C2D3E4F50002E",
    displayName: "Test iPhone",
    product: "iPhone16,1",
    osVersion: "19.0",
    platform: "IOS",
    status: "PENDING",
    appleDeviceId: null,
    appleStatus: null,
    registrationError: null,
    registrationClaimedAt: null,
    registeredAt: null,
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    enrollments: [],
    ipObservations: [],
  };
  fetcher = vi.fn<typeof fetch>();
  setupPrisma();
});

describe("App Store Connect device registration", () => {
  test("mints an ES256 token, reconciles by UDID, and sends the documented request", async () => {
    fetcher.mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(
      json({
        data: {
          id: "apple-device-1",
          type: "devices",
          attributes: { status: "ENABLED" },
        },
      }),
    );

    const result = await new IosDevicesService(fetcher).registerDevice(
      device.id,
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [queryUrl, queryInit] = fetcher.mock.calls[0]!;
    expect(String(queryUrl)).toContain(
      "/v1/devices?filter%5Budid%5D=00008030-001C2D3E4F50002E&limit=1",
    );
    const authorization = (queryInit?.headers as Record<string, string>)
      .authorization;
    const token = authorization.slice("Bearer ".length);
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: "ES256",
      kid: "ABC123DEFG",
      typ: "JWT",
    });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: "00000000-1111-2222-3333-444444444444",
      aud: "appstoreconnect-v1",
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(15 * 60);

    const [postUrl, postInit] = fetcher.mock.calls[1]!;
    expect(String(postUrl)).toBe(
      "https://api.appstoreconnect.apple.com/v1/devices",
    );
    expect(postInit?.method).toBe("POST");
    expect(JSON.parse(String(postInit?.body))).toEqual({
      data: {
        type: "devices",
        attributes: {
          name: "Test iPhone",
          platform: "IOS",
          udid: "00008030-001C2D3E4F50002E",
        },
      },
    });
    expect(result).toMatchObject({
      status: "REGISTERED",
      registrationClaimedAt: null,
      appleDeviceId: "apple-device-1",
      appleStatus: "ENABLED",
    });
  });

  test("uses an existing Apple device without attempting a duplicate POST", async () => {
    fetcher.mockResolvedValueOnce(
      json({
        data: [
          {
            id: "existing-apple-device",
            type: "devices",
            attributes: { status: "ENABLED" },
          },
        ],
      }),
    );

    await new IosDevicesService(fetcher).registerDevice(device.id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(device).toMatchObject({
      status: "REGISTERED",
      appleDeviceId: "existing-apple-device",
    });
  });

  test.each([
    [403, { errors: [{ detail: "Forbidden" }] }, "rejected the API key"],
    [
      422,
      { errors: [{ detail: "Maximum device limit reached" }] },
      "annual device limit",
    ],
    [
      422,
      { errors: [{ detail: "Invalid UDID 00008030-001C2D3E4F50002E" }] },
      "UDID as invalid",
    ],
    [
      400,
      {
        errors: [{ detail: "Unknown failure for 00008030-001c2d3e4f50002e" }],
      },
      "Unknown failure for [REDACTED]",
    ],
  ])(
    "maps Apple HTTP %s responses to an actionable registration failure",
    async (status, body, message) => {
      fetcher.mockResolvedValueOnce(json(body, status));
      await expect(
        new IosDevicesService(fetcher).registerDevice(device.id),
      ).rejects.toThrow(message);
      expect(device.status).toBe("REGISTRATION_FAILED");
      expect(device.registrationError).toContain(message);
      expect(device.registrationError?.toLowerCase()).not.toContain(
        device.udid.toLowerCase(),
      );
    },
  );

  test("maps timeouts and leaves the device retryable", async () => {
    const timeout = new Error("aborted");
    timeout.name = "TimeoutError";
    fetcher.mockRejectedValueOnce(timeout);

    await expect(
      new IosDevicesService(fetcher).registerDevice(device.id),
    ).rejects.toThrow("timed out");
    expect(device.status).toBe("REGISTRATION_FAILED");
    expect(device.registrationClaimedAt).toBeNull();
  });

  test("recovers an interrupted registration claim so it can be retried", async () => {
    device.status = "REGISTERING";
    device.registrationClaimedAt = new Date(Date.now() - 10 * 60_000);

    const recovered = await new IosDevicesService(fetcher).device(device.id);

    expect(recovered).toMatchObject({
      status: "REGISTRATION_FAILED",
      registrationClaimedAt: null,
      registrationError: expect.stringContaining("interrupted"),
    });
  });

  test("does not delete a device claimed for registration after the initial read", async () => {
    const prisma = await getPrismaClient();
    vi.mocked(prisma.iosDevice.findUnique).mockImplementationOnce(async () => {
      const snapshot = { ...device };
      device.status = "REGISTERING";
      device.registrationClaimedAt = new Date();
      return snapshot;
    });

    await expect(
      new IosDevicesService(fetcher).deleteDevice(device.id),
    ).rejects.toThrow("Wait for Apple registration");
    expect(device.status).toBe("REGISTERING");
  });

  test("excludes rejected devices from the Apple TSV", async () => {
    const prisma = await getPrismaClient();
    const rejected = {
      ...device,
      id: "device-2",
      udid: "00008030-001C2D3E4F50003F",
      displayName: "Rejected iPhone",
      status: "REJECTED",
    };
    vi.mocked(prisma.iosDevice.findMany).mockImplementationOnce(
      async ({ where }: { where?: { status?: { not?: string } } }) =>
        [device, rejected].filter(
          (entry) => entry.status !== where?.status?.not,
        ) as never,
    );

    const tsv = await new IosDevicesService(fetcher).exportTsv();

    expect(tsv).toContain(device.udid);
    expect(tsv).not.toContain(rejected.udid);
    expect(prisma.iosDevice.findMany).toHaveBeenCalledWith({
      where: { status: { not: "REJECTED" } },
      orderBy: { displayName: "asc" },
    });
  });

  test("validates, stores, verifies, and redacts a new .p8 key", async () => {
    settings.appStoreConnectIssuerId = null;
    settings.appStoreConnectKeyId = null;
    settings.appStoreConnectPrivateKey = null;
    settings.appStoreConnectVerifiedAt = null;
    fetcher.mockResolvedValueOnce(json({ data: [] }));

    const view = await new IosDevicesService(
      fetcher,
    ).saveAppStoreConnectSettings({
      issuerId: "issuer-1",
      keyId: "key-1",
      privateKey: p8,
    });

    expect(settings).toMatchObject({
      appStoreConnectIssuerId: "issuer-1",
      appStoreConnectKeyId: "key-1",
      appStoreConnectPrivateKey: p8,
      appStoreConnectVerificationError: null,
    });
    expect(settings.appStoreConnectVerifiedAt).toBeInstanceOf(Date);
    expect(view).not.toHaveProperty("appStoreConnectPrivateKey");
    expect(view.appStoreConnectPrivateKeyConfigured).toBe(true);
    expect(view.appStoreConnectPrivateKeyFingerprint).toMatch(/^[A-F0-9]{64}$/);
  });

  test("rejects a non-ES256 PKCS#8 key before contacting Apple", async () => {
    const invalidPkcs8 =
      "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----";
    await expect(
      new IosDevicesService(fetcher).saveAppStoreConnectSettings({
        issuerId: "issuer-1",
        keyId: "key-1",
        privateKey: invalidPkcs8,
      }),
    ).rejects.toThrow("ES256 PKCS#8");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("persists a failed retest and disables registration until verification succeeds", async () => {
    fetcher.mockResolvedValueOnce(
      json({ errors: [{ detail: "Forbidden" }] }, 403),
    );
    const service = new IosDevicesService(fetcher);

    await expect(service.testAppStoreConnectSettings()).rejects.toThrow(
      "rejected the API key",
    );
    expect(settings.appStoreConnectVerifiedAt).toBeNull();
    expect(settings.appStoreConnectLastTestedAt).toBeInstanceOf(Date);
    expect(settings.appStoreConnectVerificationError).toContain(
      "rejected the API key",
    );
    await expect(service.registerDevice(device.id)).rejects.toThrow(
      "Configure and verify",
    );
  });
});
