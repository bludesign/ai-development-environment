// @vitest-environment node
import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: {
    id: "default",
    tokenTeamId: null as string | null,
    tokenKeyId: null as string | null,
    tokenPrivateKeyFingerprint: null as string | null,
    tokenConfiguredAt: null as Date | null,
    tokenLastUsedAt: null as Date | null,
    tokenLastError: null as string | null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
  certificates: [] as Array<{
    id: string;
    name: string;
    topic: string;
    environment: string;
    fingerprint: string;
    expiresAt: Date | null;
    lastTestedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
}));

const transaction = vi.hoisted(() => ({
  pushNotificationSettings: {
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state.settings, data, { updatedAt: new Date() });
      return state.settings;
    }),
    upsert: vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
      Object.assign(state.settings, update, { updatedAt: new Date() });
      return state.settings;
    }),
  },
  apnsCertificateCredential: {
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const found = state.certificates.find(({ id }) => id === where.id);
      state.certificates = state.certificates.filter(
        ({ id }) => id !== where.id,
      );
      return found;
    }),
  },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    ...transaction,
    pushNotificationSettings: {
      ...transaction.pushNotificationSettings,
      upsert: vi.fn(
        async ({ update = {} }: { update?: Record<string, unknown> }) => {
          Object.assign(state.settings, update);
          return state.settings;
        },
      ),
    },
    apnsCertificateCredential: {
      ...transaction.apnsCertificateCredential,
      findMany: async () => state.certificates,
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.certificates.find(({ id }) => id === where.id) ?? null,
    },
  }),
}));

import { PushNotificationsService } from "./push-notifications.service";

describe("push notification credential integration", () => {
  let privateKey: string;
  let tokenSecret: string | null;
  let certificateSecrets: Map<
    string,
    { p12Base64: string; passphrase: string }
  >;
  let credentials: Record<string, ReturnType<typeof vi.fn>>;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("ES256", { extractable: true });
    privateKey = await exportPKCS8(keyPair.privateKey);
  });

  beforeEach(() => {
    tokenSecret = null;
    certificateSecrets = new Map();
    state.settings.tokenTeamId = null;
    state.settings.tokenKeyId = null;
    state.settings.tokenPrivateKeyFingerprint = null;
    state.certificates = [];
    credentials = {
      isConfigured: vi.fn(
        async (descriptor: { id: string; ownerId?: string | null }) =>
          descriptor.id.includes("token-private-key")
            ? Boolean(tokenSecret)
            : certificateSecrets.has(descriptor.ownerId ?? ""),
      ),
      getText: vi.fn(async () => tokenSecret),
      getJson: vi.fn(
        async (descriptor: { id: string; ownerId?: string | null }) => {
          if (descriptor.id.endsWith("/token-settings")) {
            return state.settings.tokenTeamId && state.settings.tokenKeyId
              ? {
                  teamId: state.settings.tokenTeamId,
                  keyId: state.settings.tokenKeyId,
                }
              : null;
          }
          if (descriptor.id.endsWith("/certificate-catalog")) {
            return state.certificates.map(
              ({ id, name, topic, environment }) => ({
                id,
                name,
                topic,
                environment,
              }),
            );
          }
          return certificateSecrets.get(descriptor.ownerId ?? "") ?? null;
        },
      ),
      setMany: vi.fn(
        async (
          entries: Array<{
            descriptor: { id: string; ownerId?: string | null };
            value: Uint8Array;
          }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          for (const entry of entries) {
            if (entry.descriptor.id.endsWith("/token-settings")) {
              const value = JSON.parse(
                Buffer.from(entry.value).toString("utf8"),
              ).value;
              state.settings.tokenTeamId = value.teamId;
              state.settings.tokenKeyId = value.keyId;
            } else if (entry.descriptor.id.endsWith("token-private-key")) {
              tokenSecret = Buffer.from(entry.value).toString("utf8");
            } else if (entry.descriptor.ownerId) {
              const value = JSON.parse(
                Buffer.from(entry.value).toString("utf8"),
              ).value;
              certificateSecrets.set(entry.descriptor.ownerId, value);
            }
          }
          await mutation?.(transaction);
        },
      ),
      setText: vi.fn(
        async (
          _descriptor: unknown,
          value: string,
          mutation: (value: unknown) => Promise<void>,
        ) => {
          tokenSecret = value;
          await mutation(transaction);
        },
      ),
      delete: vi.fn(
        async (
          descriptor: { id: string; ownerId?: string | null },
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          if (descriptor.id.includes("token-private-key")) tokenSecret = null;
          else certificateSecrets.delete(descriptor.ownerId ?? "");
          await mutation?.(transaction);
        },
      ),
      deleteMany: vi.fn(
        async (
          descriptors: Array<{ id: string }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          if (descriptors.some(({ id }) => id.endsWith("token-private-key"))) {
            tokenSecret = null;
            state.settings.tokenTeamId = null;
            state.settings.tokenKeyId = null;
          }
          await mutation?.(transaction);
        },
      ),
      setJson: vi.fn(
        async (
          _descriptor: unknown,
          catalog: Array<{
            id: string;
            name: string;
            topic: string;
            environment: string;
          }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          state.certificates = state.certificates.filter((certificate) =>
            catalog.some(({ id }) => id === certificate.id),
          );
          await mutation?.(transaction);
        },
      ),
      setAndDeleteMany: vi.fn(
        async (
          _entries: Array<{ value: Uint8Array }>,
          descriptors: Array<{ ownerId?: string | null }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          for (const descriptor of descriptors) {
            certificateSecrets.delete(descriptor.ownerId ?? "");
          }
          await mutation?.(transaction);
        },
      ),
    };
  });

  test("keeps the APNs token key out of settings rows", async () => {
    const service = new PushNotificationsService(
      undefined,
      credentials as never,
    );
    await service.saveTokenSettings({
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey,
    });
    expect(credentials.setMany).toHaveBeenCalledOnce();
    expect(tokenSecret).toBe(privateKey);
    expect(state.settings).not.toHaveProperty("tokenPrivateKey");
    await expect(service.settings()).resolves.toMatchObject({
      tokenConfigured: true,
    });

    await service.clearTokenSettings();
    expect(credentials.deleteMany).toHaveBeenCalled();
    expect(tokenSecret).toBeNull();
    await expect(service.settings()).resolves.toMatchObject({
      tokenConfigured: false,
    });
  });

  test("reads and deletes APNs certificate bundles through CredentialService", async () => {
    const certificate = {
      id: "certificate-1",
      name: "Development",
      topic: "com.example.app",
      environment: "SANDBOX",
      fingerprint: "ABC",
      expiresAt: null,
      lastTestedAt: null,
      lastError: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    state.certificates = [certificate];
    certificateSecrets.set(certificate.id, {
      p12Base64: "certificate-secret",
      passphrase: "passphrase-secret",
    });
    const service = new PushNotificationsService(
      undefined,
      credentials as never,
    );
    const authentication = await (
      service as unknown as {
        authentication(
          editor: { credentialId: string; pushType: string },
          environment: string,
          topic: string,
        ): Promise<Record<string, unknown>>;
      }
    ).authentication(
      { credentialId: certificate.id, pushType: "alert" },
      "SANDBOX",
      certificate.topic,
    );
    expect(authentication).toMatchObject({
      kind: "CERTIFICATE",
      p12Base64: "certificate-secret",
      passphrase: "passphrase-secret",
    });
    expect(credentials.getJson).toHaveBeenCalled();
    expect(certificate).not.toHaveProperty("p12Base64");

    await service.deleteCertificateCredential(certificate.id);
    expect(credentials.setAndDeleteMany).toHaveBeenCalled();
    expect(certificateSecrets.has(certificate.id)).toBe(false);
    expect(state.certificates).toEqual([]);
  });
});
