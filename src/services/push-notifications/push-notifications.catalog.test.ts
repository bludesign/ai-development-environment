// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

vi.mock("node:tls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tls")>()),
  createSecureContext: vi.fn(() => ({
    context: { getCertificate: () => Buffer.from("certificate") },
  })),
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  X509Certificate: class {
    readonly validTo = "Jul 29 12:00:00 2030 GMT";
    readonly fingerprint256 = "AA:BB:CC";
  },
}));

import { PushNotificationsService } from "./push-notifications.service";

type CatalogEntry = {
  id: string;
  name: string;
  topic: string;
  environment: "SANDBOX" | "PRODUCTION";
};

describe("APNs certificate catalog mutations", () => {
  let catalog: CatalogEntry[];
  let certificateRows: Array<
    CatalogEntry & {
      fingerprint: string;
      expiresAt: Date;
      lastTestedAt: Date;
      lastError: null;
      createdAt: Date;
      updatedAt: Date;
    }
  >;
  let certificateSecrets: Map<string, unknown>;

  beforeEach(() => {
    catalog = [];
    certificateRows = [];
    certificateSecrets = new Map();
  });

  test("serializes concurrent catalog additions across service instances", async () => {
    let markFirstReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let catalogReads = 0;

    const settings = {
      id: "default",
      tokenPrivateKeyFingerprint: null,
      tokenConfiguredAt: null,
      tokenLastUsedAt: null,
      tokenLastError: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const transaction = {
      pushNotificationSettings: {
        upsert: vi.fn(async () => settings),
      },
      apnsCertificateCredential: {
        create: vi.fn(
          async ({
            data,
          }: {
            data: {
              id: string;
              fingerprint: string;
              expiresAt: Date;
              lastTestedAt: Date;
            };
          }) => {
            const configuration = catalog.find(({ id }) => id === data.id)!;
            const row = {
              ...configuration,
              ...data,
              lastError: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            certificateRows.push(row);
            return row;
          },
        ),
        findMany: vi.fn(
          async ({ where }: { where: { id: { in: string[] } } }) =>
            certificateRows.filter(({ id }) => where.id.in.includes(id)),
        ),
      },
      pushNotificationBatch: {
        findMany: vi.fn(async () => []),
      },
    };
    getPrismaClient.mockResolvedValue(transaction);

    const credentials = {
      getJson: vi.fn(async (descriptor: { id: string }) => {
        if (!descriptor.id.endsWith("/certificate-catalog")) return null;
        const snapshot = catalog.map((entry) => ({ ...entry }));
        catalogReads += 1;
        if (catalogReads === 1) {
          markFirstReadStarted();
          await firstReadGate;
        }
        return snapshot;
      }),
      isConfigured: vi.fn(async () => false),
      setMany: vi.fn(
        async (
          entries: Array<{
            descriptor: { id: string; ownerId?: string | null };
            value: Uint8Array;
          }>,
          mutation: (value: typeof transaction) => Promise<void>,
        ) => {
          for (const entry of entries) {
            const value = JSON.parse(
              Buffer.from(entry.value).toString("utf8"),
            ).value;
            if (entry.descriptor.id.endsWith("/certificate-catalog")) {
              catalog = value;
            } else if (entry.descriptor.ownerId) {
              certificateSecrets.set(entry.descriptor.ownerId, value);
            }
          }
          await mutation(transaction);
        },
      ),
    };
    const firstService = new PushNotificationsService(
      undefined,
      credentials as never,
    );
    const secondService = new PushNotificationsService(
      undefined,
      credentials as never,
    );
    const p12Base64 = Buffer.from("p12").toString("base64");

    const first = firstService.addCertificateCredential({
      name: "Development",
      topic: "com.example.development",
      environment: "SANDBOX",
      p12Base64,
      passphrase: "first-passphrase",
    });
    await firstReadStarted;
    const second = secondService.addCertificateCredential({
      name: "Production",
      topic: "com.example.production",
      environment: "PRODUCTION",
      p12Base64,
      passphrase: "second-passphrase",
    });
    releaseFirstRead();

    await Promise.all([first, second]);

    expect(catalog.map(({ name }) => name).sort()).toEqual([
      "Development",
      "Production",
    ]);
    expect(certificateRows).toHaveLength(2);
    expect(certificateSecrets).toHaveLength(2);
  });
});
