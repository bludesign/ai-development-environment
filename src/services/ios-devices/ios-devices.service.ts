import { randomUUID } from "node:crypto";

import {
  parsePlist,
  plistDocument,
} from "@ai-development-environment/agent-contract/plist";
import { getPrismaClient } from "@/data/prisma-client";
import { CREDENTIALS, CredentialService } from "@/services/credentials";
import {
  agentEventBus,
  IOS_DEVICES_CHANGED_TOPIC,
} from "@/services/agent-control/event-bus";
import {
  AppleDeveloperClient,
  AppleDeveloperRequestError,
  type AppleDeveloperCredentials,
} from "@/services/apple-developer";

import type { ClientIp } from "./client-ip";
import {
  generateProfileSigner,
  randomEnrollmentToken,
  sha256,
  signMobileConfig,
  verifyAppleDeviceResponse,
} from "./crypto";
import type {
  AppStoreConnectSettingsInput,
  IosDeviceFirmware,
  IosDeviceSettingsView,
  IosDeviceStatus,
} from "./types";
import { fetchIpswDevice } from "./ipsw";

const SETTINGS_ID = "default";
const ENROLLMENT_TTL_MS = 30 * 60_000;
const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const IPSW_CACHE_TTL_MS = 15 * 60_000;
const REGISTRATION_CLAIM_TTL_MS = 5 * 60_000;
const INTERRUPTED_REGISTRATION_ERROR =
  "The previous Apple registration attempt was interrupted; retry registration";

type FetchLike = typeof fetch;

type AppleDeviceResource = {
  id: string;
  type: "devices";
  attributes: {
    name?: string;
    platform?: string;
    udid?: string;
    status?: string;
    deviceClass?: string;
    model?: string;
    addedDate?: string;
  };
};

type AppleDeviceResponse = { data: AppleDeviceResource };
type AppleDeviceListResponse = { data: AppleDeviceResource[] };

export class IosEnrollmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "IosEnrollmentError";
  }
}

function cleanRequired(value: string, name: string, max: number): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${name} is required`);
  if (cleaned.length > max) throw new Error(`${name} is too long`);
  return cleaned;
}

function cleanDeviceAttribute(
  value: unknown,
  name: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const cleaned = value.trim();
  if (cleaned.length > max) throw new Error(`${name} is too long`);
  return cleaned || null;
}

export function normalizeUdid(value: unknown): string {
  if (typeof value !== "string") throw new Error("UDID is missing");
  const udid = value.trim().toUpperCase();
  if (!/^(?:[A-F0-9]{40}|[A-F0-9]{8}-[A-F0-9]{16})$/.test(udid)) {
    throw new Error("UDID has an invalid format");
  }
  return udid;
}

function redactValue(message: string, value: string): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escaped, "gi"), "[REDACTED]");
}

export function enrollmentProfileXml({
  token,
  publicOrigin,
  organizationName,
  profileIdentifier,
  payloadUuid = randomUUID().toUpperCase(),
}: {
  token: string;
  publicOrigin: string;
  organizationName: string;
  profileIdentifier: string;
  payloadUuid?: string;
}): string {
  const callback = `${publicOrigin}/api/public/ios/profile-response?token=${encodeURIComponent(token)}`;
  return plistDocument({
    PayloadContent: {
      URL: callback,
      DeviceAttributes: ["UDID", "PRODUCT", "VERSION"],
      Challenge: token,
    },
    PayloadType: "Profile Service",
    PayloadVersion: 1,
    PayloadIdentifier: profileIdentifier,
    PayloadUUID: payloadUuid,
    PayloadDisplayName: `Register device for ${organizationName}`,
    PayloadDescription:
      "Shares this device's identifier, product, and software version for development registration.",
    PayloadOrganization: organizationName,
  });
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Device response plist must be a dictionary");
  }
  return value as Record<string, unknown>;
}

function settingsView(
  value: {
    organizationName: string;
    profileIdentifier: string;
    signerCertificatePem: string | null;
    signerFingerprint: string | null;
    signerCreatedAt: Date | null;
    signerExpiresAt: Date | null;
    appStoreConnectIssuerId: string | null;
    appStoreConnectKeyId: string | null;
    appStoreConnectPrivateKeyFingerprint: string | null;
    appStoreConnectVerifiedAt: Date | null;
    appStoreConnectLastTestedAt: Date | null;
    appStoreConnectVerificationError: string | null;
    updatedAt: Date;
  },
  signerKeyConfigured: boolean,
  appStoreKeyConfigured: boolean,
): IosDeviceSettingsView {
  return {
    organizationName: value.organizationName,
    profileIdentifier: value.profileIdentifier,
    signerConfigured: Boolean(
      value.signerCertificatePem && signerKeyConfigured,
    ),
    signerFingerprint: value.signerFingerprint,
    signerCreatedAt: value.signerCreatedAt?.toISOString() ?? null,
    signerExpiresAt: value.signerExpiresAt?.toISOString() ?? null,
    appStoreConnectConfigured: Boolean(
      value.appStoreConnectIssuerId &&
      value.appStoreConnectKeyId &&
      appStoreKeyConfigured &&
      value.appStoreConnectVerifiedAt,
    ),
    appStoreConnectIssuerId: value.appStoreConnectIssuerId,
    appStoreConnectKeyId: value.appStoreConnectKeyId,
    appStoreConnectPrivateKeyConfigured: Boolean(appStoreKeyConfigured),
    appStoreConnectPrivateKeyFingerprint:
      value.appStoreConnectPrivateKeyFingerprint,
    appStoreConnectVerifiedAt:
      value.appStoreConnectVerifiedAt?.toISOString() ?? null,
    appStoreConnectLastTestedAt:
      value.appStoreConnectLastTestedAt?.toISOString() ?? null,
    appStoreConnectVerificationError: value.appStoreConnectVerificationError,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function safeTsv(value: string): string {
  return value.replace(/[\t\r\n]/g, " ").trim();
}

export class IosDevicesService {
  private readonly firmwareCache = new Map<
    string,
    { expiresAt: number; value: IosDeviceFirmware }
  >();

  constructor(
    private readonly fetcher: FetchLike = fetch,
    private readonly credentials = new CredentialService(),
  ) {}

  private changed(id: string | null = null): void {
    agentEventBus.publish(IOS_DEVICES_CHANGED_TOPIC, { id });
  }

  subscribe() {
    return agentEventBus.iterate<{ id: string | null }>(
      IOS_DEVICES_CHANGED_TOPIC,
    );
  }

  private async rawSettings() {
    const prisma = await getPrismaClient();
    return prisma.iosDeviceSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async getSettings(): Promise<IosDeviceSettingsView> {
    const [settings, signerKeyConfigured, appStoreKeyConfigured] =
      await Promise.all([
        this.rawSettings(),
        this.credentials.isConfigured(CREDENTIALS.iosProfileSignerPrivateKey),
        this.credentials.isConfigured(CREDENTIALS.appStoreConnectPrivateKey),
      ]);
    return settingsView(settings, signerKeyConfigured, appStoreKeyConfigured);
  }

  async saveProfileSettings(input: {
    organizationName: string;
    profileIdentifier: string;
  }): Promise<IosDeviceSettingsView> {
    const organizationName = cleanRequired(
      input.organizationName,
      "Organization name",
      100,
    );
    const profileIdentifier = cleanRequired(
      input.profileIdentifier,
      "Profile identifier",
      200,
    );
    if (!/^[A-Za-z0-9.-]+$/.test(profileIdentifier)) {
      throw new Error(
        "Profile identifier may contain only letters, numbers, dots, and hyphens",
      );
    }
    const prisma = await getPrismaClient();
    await prisma.iosDeviceSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, organizationName, profileIdentifier },
      update: { organizationName, profileIdentifier },
    });
    return this.getSettings();
  }

  private async ensureProfileSigner() {
    const current = await this.rawSettings();
    const privateKeyPem = current.signerCertificatePem
      ? await this.credentials.getText(CREDENTIALS.iosProfileSignerPrivateKey)
      : null;
    if (current.signerCertificatePem && privateKeyPem) {
      return { ...current, signerPrivateKeyPem: privateKeyPem };
    }
    return this.regenerateProfileSigner();
  }

  async regenerateProfileSigner() {
    const current = await this.rawSettings();
    const signer = await generateProfileSigner(current.organizationName);
    await this.credentials.setText(
      CREDENTIALS.iosProfileSignerPrivateKey,
      signer.privateKeyPem,
      async (transaction) => {
        await transaction.iosDeviceSettings.update({
          where: { id: SETTINGS_ID },
          data: {
            signerCertificatePem: signer.certificatePem,
            signerFingerprint: signer.fingerprint,
            signerCreatedAt: signer.createdAt,
            signerExpiresAt: signer.expiresAt,
          },
        });
      },
    );
    return {
      ...(await this.rawSettings()),
      signerPrivateKeyPem: signer.privateKeyPem,
    };
  }

  async regenerateProfileSignerView(): Promise<IosDeviceSettingsView> {
    await this.regenerateProfileSigner();
    return this.getSettings();
  }

  async purgeExpiredEnrollments(now = new Date()): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.iosDeviceEnrollment.updateMany({
      where: {
        status: { in: ["ISSUED", "DOWNLOADED"] },
        expiresAt: { lt: now },
      },
      data: { status: "EXPIRED", failureCode: "TOKEN_EXPIRED" },
    });
    await prisma.iosDeviceEnrollment.deleteMany({
      where: {
        deviceId: null,
        expiresAt: { lt: new Date(now.getTime() - EXPIRED_RETENTION_MS) },
      },
    });
  }

  async createEnrollment(displayName: string): Promise<{
    id: string;
    token: string;
    expiresAt: Date;
  }> {
    const cleanedDisplayName = cleanRequired(displayName, "Device label", 100);
    await this.purgeExpiredEnrollments();
    await this.ensureProfileSigner();
    const token = randomEnrollmentToken();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
    const prisma = await getPrismaClient();
    const enrollment = await prisma.iosDeviceEnrollment.create({
      data: {
        id: randomUUID(),
        tokenHash: sha256(token),
        displayName: cleanedDisplayName,
        expiresAt,
      },
    });
    return { id: enrollment.id, token, expiresAt };
  }

  private async enrollmentForToken(token: string) {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      throw new IosEnrollmentError(
        "Enrollment token is invalid",
        404,
        "INVALID_TOKEN",
      );
    }
    const prisma = await getPrismaClient();
    const enrollment = await prisma.iosDeviceEnrollment.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!enrollment) {
      throw new IosEnrollmentError(
        "Enrollment token is invalid",
        404,
        "INVALID_TOKEN",
      );
    }
    if (!enrollment.consumedAt && enrollment.expiresAt.getTime() < Date.now()) {
      await prisma.iosDeviceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "EXPIRED", failureCode: "TOKEN_EXPIRED" },
      });
      throw new IosEnrollmentError(
        "Enrollment token has expired",
        410,
        "TOKEN_EXPIRED",
      );
    }
    return enrollment;
  }

  private async recordIp(
    enrollmentId: string,
    source: "PROFILE_DOWNLOAD" | "PROFILE_RESPONSE",
    ip: ClientIp | null,
    deviceId?: string | null,
  ): Promise<void> {
    if (!ip) return;
    const prisma = await getPrismaClient();
    await prisma.iosDeviceIpObservation.upsert({
      where: {
        enrollmentId_source_ipAddress: {
          enrollmentId,
          source,
          ipAddress: ip.address,
        },
      },
      create: {
        id: randomUUID(),
        enrollmentId,
        deviceId: deviceId ?? null,
        source,
        ipAddress: ip.address,
        headerSource: ip.source,
      },
      update: {
        deviceId: deviceId ?? undefined,
        headerSource: ip.source,
      },
    });
  }

  async enrollmentProfile(
    token: string,
    publicOrigin: string,
    ip: ClientIp | null,
  ): Promise<Uint8Array> {
    const enrollment = await this.enrollmentForToken(token);
    if (enrollment.consumedAt) {
      throw new IosEnrollmentError(
        "Enrollment has already completed",
        410,
        "TOKEN_CONSUMED",
      );
    }
    const settings = await this.ensureProfileSigner();
    if (!settings.signerCertificatePem || !settings.signerPrivateKeyPem) {
      throw new IosEnrollmentError(
        "Profile signer is unavailable",
        503,
        "SIGNER_UNAVAILABLE",
      );
    }
    const profile = enrollmentProfileXml({
      token,
      publicOrigin,
      organizationName: settings.organizationName,
      profileIdentifier: settings.profileIdentifier,
    });
    const signed = await signMobileConfig(
      profile,
      settings.signerCertificatePem,
      settings.signerPrivateKeyPem,
    );
    const prisma = await getPrismaClient();
    await prisma.iosDeviceEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: "DOWNLOADED",
        downloadedAt: enrollment.downloadedAt ?? new Date(),
        failureCode: null,
      },
    });
    await this.recordIp(enrollment.id, "PROFILE_DOWNLOAD", ip);
    return signed;
  }

  async completeEnrollment(
    token: string,
    cmsBytes: Uint8Array,
    ip: ClientIp | null,
  ) {
    const enrollment = await this.enrollmentForToken(token);
    const responseDigest = sha256(cmsBytes);
    if (enrollment.consumedAt) {
      if (enrollment.responseDigest === responseDigest && enrollment.deviceId) {
        const prisma = await getPrismaClient();
        const device = await prisma.iosDevice.findUnique({
          where: { id: enrollment.deviceId },
          include: {
            enrollments: { orderBy: { createdAt: "desc" } },
            ipObservations: { orderBy: { observedAt: "desc" } },
          },
        });
        if (device) return device;
      }
      throw new IosEnrollmentError(
        "Enrollment token has already been consumed",
        409,
        "TOKEN_CONSUMED",
      );
    }

    let udid: string;
    let product: string | null;
    let osVersion: string | null;
    try {
      const attributes = asObject(
        parsePlist(await verifyAppleDeviceResponse(cmsBytes)),
      );
      if (attributes.CHALLENGE !== token) {
        throw new Error("Device response challenge does not match");
      }
      udid = normalizeUdid(attributes.UDID);
      product = cleanDeviceAttribute(attributes.PRODUCT, "Product", 100);
      osVersion = cleanDeviceAttribute(
        attributes.VERSION,
        "Software version",
        50,
      );
    } catch (error) {
      const prisma = await getPrismaClient();
      const failed = await prisma.iosDeviceEnrollment.updateMany({
        where: { id: enrollment.id, consumedAt: null },
        data: { status: "FAILED", failureCode: "INVALID_DEVICE_RESPONSE" },
      });
      if (failed.count !== 1) {
        throw new IosEnrollmentError(
          "Enrollment token has already been consumed",
          409,
          "TOKEN_CONSUMED",
        );
      }
      throw new IosEnrollmentError(
        error instanceof Error ? error.message : "Device response is invalid",
        400,
        "INVALID_DEVICE_RESPONSE",
      );
    }

    const now = new Date();
    const prisma = await getPrismaClient();
    const device = await prisma.$transaction(async (tx) => {
      const claim = await tx.iosDeviceEnrollment.updateMany({
        where: { id: enrollment.id, consumedAt: null },
        data: {
          status: "PROCESSING",
          consumedAt: now,
          responseDigest,
          failureCode: null,
        },
      });
      if (claim.count !== 1) {
        const consumed = await tx.iosDeviceEnrollment.findUnique({
          where: { id: enrollment.id },
        });
        if (consumed?.responseDigest === responseDigest && consumed.deviceId) {
          const retried = await tx.iosDevice.findUnique({
            where: { id: consumed.deviceId },
          });
          if (retried) return retried;
        }
        throw new IosEnrollmentError(
          "Enrollment token has already been consumed",
          409,
          "TOKEN_CONSUMED",
        );
      }

      const existing = await tx.iosDevice.findUnique({ where: { udid } });
      const stored = existing
        ? await tx.iosDevice.update({
            where: { id: existing.id },
            data: { product, osVersion, lastSeenAt: now },
          })
        : await tx.iosDevice.create({
            data: {
              id: randomUUID(),
              udid,
              displayName: enrollment.displayName,
              product,
              osVersion,
              lastSeenAt: now,
            },
          });
      await tx.iosDeviceEnrollment.update({
        where: { id: enrollment.id },
        data: {
          deviceId: stored.id,
          status: "COMPLETED",
          failureCode: null,
        },
      });
      await tx.iosDeviceIpObservation.updateMany({
        where: { enrollmentId: enrollment.id },
        data: { deviceId: stored.id },
      });
      if (ip) {
        await tx.iosDeviceIpObservation.upsert({
          where: {
            enrollmentId_source_ipAddress: {
              enrollmentId: enrollment.id,
              source: "PROFILE_RESPONSE",
              ipAddress: ip.address,
            },
          },
          create: {
            id: randomUUID(),
            enrollmentId: enrollment.id,
            deviceId: stored.id,
            source: "PROFILE_RESPONSE",
            ipAddress: ip.address,
            headerSource: ip.source,
          },
          update: { deviceId: stored.id, headerSource: ip.source },
        });
      }
      return stored;
    });
    this.changed(device.id);
    return this.device(device.id);
  }

  async devices(status?: IosDeviceStatus | null) {
    await this.purgeExpiredEnrollments();
    await this.recoverStaleRegistrationClaims();
    const prisma = await getPrismaClient();
    return prisma.iosDevice.findMany({
      where: status ? { status } : undefined,
      include: {
        ipObservations: { orderBy: { observedAt: "desc" }, take: 1 },
      },
      orderBy: [{ createdAt: "desc" }, { displayName: "asc" }],
    });
  }

  async device(id: string) {
    await this.recoverStaleRegistrationClaims();
    const prisma = await getPrismaClient();
    return prisma.iosDevice.findUnique({
      where: { id },
      include: {
        enrollments: { orderBy: { createdAt: "desc" } },
        ipObservations: { orderBy: { observedAt: "desc" } },
      },
    });
  }

  async deviceFirmware(id: string): Promise<IosDeviceFirmware | null> {
    const prisma = await getPrismaClient();
    const device = await prisma.iosDevice.findUnique({
      where: { id },
      select: { product: true },
    });
    if (!device) throw new Error("Device not found");
    if (!device.product) return null;
    const cached = this.firmwareCache.get(device.product);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await fetchIpswDevice(device.product, this.fetcher);
    this.firmwareCache.set(device.product, {
      expiresAt: Date.now() + IPSW_CACHE_TTL_MS,
      value,
    });
    return value;
  }

  async renameDevice(id: string, displayName: string) {
    const prisma = await getPrismaClient();
    await prisma.iosDevice.update({
      where: { id },
      data: { displayName: cleanRequired(displayName, "Device label", 100) },
    });
    this.changed(id);
    return this.device(id);
  }

  async rejectDevice(id: string) {
    const prisma = await getPrismaClient();
    const result = await prisma.iosDevice.updateMany({
      where: {
        id,
        status: { in: ["PENDING", "REGISTRATION_FAILED"] },
      },
      data: { status: "REJECTED", registrationError: null },
    });
    if (result.count !== 1) {
      throw new Error("This device cannot be rejected in its current state");
    }
    this.changed(id);
    return this.device(id);
  }

  async deleteDevice(id: string): Promise<boolean> {
    await this.recoverStaleRegistrationClaims();
    const prisma = await getPrismaClient();
    const device = await prisma.iosDevice.findUnique({ where: { id } });
    if (!device) throw new Error("Device not found");
    if (device.status === "REGISTERING") {
      throw new Error("Wait for Apple registration to finish before deleting");
    }
    const deleted = await prisma.iosDevice.deleteMany({
      where: { id, status: { not: "REGISTERING" } },
    });
    if (deleted.count !== 1) {
      throw new Error("Wait for Apple registration to finish before deleting");
    }
    this.changed(id);
    return true;
  }

  private async appleDeveloperCredentials(credentials: {
    appStoreConnectIssuerId: string | null;
    appStoreConnectKeyId: string | null;
  }): Promise<AppleDeveloperCredentials> {
    const privateKey = await this.credentials.getText(
      CREDENTIALS.appStoreConnectPrivateKey,
    );
    if (
      !credentials.appStoreConnectIssuerId ||
      !credentials.appStoreConnectKeyId ||
      !privateKey
    ) {
      throw new Error("App Store Connect API credentials are not configured");
    }
    return {
      issuerId: credentials.appStoreConnectIssuerId,
      keyId: credentials.appStoreConnectKeyId,
      privateKey,
    };
  }

  private async appleRequest<T>(
    credentials: AppleDeveloperCredentials,
    path: string,
    init: RequestInit = {},
    redact = "",
  ): Promise<T> {
    try {
      return await new AppleDeveloperClient(
        credentials,
        this.fetcher,
      ).request<T>(path, init);
    } catch (error) {
      if (!(error instanceof AppleDeveloperRequestError)) {
        if (error instanceof Error && error.message.includes("timed out")) {
          throw new Error(
            "App Store Connect timed out; retry to reconcile the device",
          );
        }
        if (error instanceof Error && error.message.includes("ES256 PKCS#8")) {
          throw error;
        }
        throw new Error("Could not connect to App Store Connect");
      }
      const detail = error.errors
        ?.map((entry) => entry.detail || entry.title || entry.code)
        .filter(Boolean)
        .join("; ");
      const classification = `${
        error.errors
          ?.map(
            (entry) =>
              `${entry.code ?? ""} ${entry.title ?? ""} ${entry.detail ?? ""}`,
          )
          .join(" ") ?? ""
      }`.toLowerCase();
      const message =
        error.status === 401 || error.status === 403
          ? "App Store Connect rejected the API key or its Certificates, Identifiers & Profiles access"
          : error.status === 429
            ? "Apple rate-limited device registration; wait and retry"
            : /maximum|device.?limit|limit.?reached/.test(classification)
              ? "The Apple Developer account has reached its annual device limit for this platform"
              : /duplicate|already (?:exists|registered)/.test(classification)
                ? "Apple reports that this device already exists; retry registration to reconcile it"
                : /invalid.{0,30}udid|udid.{0,30}invalid/.test(classification)
                  ? "Apple rejected the UDID as invalid; re-enroll the device and try again"
                  : error.status === 422
                    ? `Apple rejected the device data${detail ? `: ${detail}` : ""}`
                    : detail ||
                      `App Store Connect returned HTTP ${error.status}`;
      throw new Error(redact ? redactValue(message, redact) : message);
    }
  }

  private async verifyAppStoreCredentials(credentials: {
    issuerId: string;
    keyId: string;
    privateKey: string;
  }): Promise<void> {
    await this.appleRequest<AppleDeviceListResponse>(
      credentials,
      "/v1/devices?limit=1",
    );
  }

  async saveAppStoreConnectSettings(
    input: AppStoreConnectSettingsInput,
  ): Promise<IosDeviceSettingsView> {
    await this.rawSettings();
    const issuerId = cleanRequired(input.issuerId, "Issuer ID", 100);
    const keyId = cleanRequired(input.keyId, "Key ID", 100);
    const privateKey =
      input.privateKey?.trim() ||
      (await this.credentials.getText(CREDENTIALS.appStoreConnectPrivateKey));
    if (!privateKey) throw new Error("A .p8 private key is required");
    if (
      !privateKey.includes("-----BEGIN PRIVATE KEY-----") ||
      !privateKey.includes("-----END PRIVATE KEY-----")
    ) {
      throw new Error(
        "The App Store Connect key must be a PKCS#8 .p8 private key",
      );
    }
    await this.verifyAppStoreCredentials({ issuerId, keyId, privateKey });
    await this.credentials.setText(
      CREDENTIALS.appStoreConnectPrivateKey,
      privateKey,
      async (transaction) => {
        await transaction.iosDeviceSettings.update({
          where: { id: SETTINGS_ID },
          data: {
            appStoreConnectIssuerId: issuerId,
            appStoreConnectKeyId: keyId,
            appStoreConnectPrivateKeyFingerprint:
              sha256(privateKey).toUpperCase(),
            appStoreConnectVerifiedAt: new Date(),
            appStoreConnectLastTestedAt: new Date(),
            appStoreConnectVerificationError: null,
          },
        });
      },
    );
    return this.getSettings();
  }

  async testAppStoreConnectSettings(): Promise<IosDeviceSettingsView> {
    const current = await this.rawSettings();
    if (!current.appStoreConnectIssuerId || !current.appStoreConnectKeyId) {
      throw new Error("App Store Connect API credentials are not configured");
    }
    const prisma = await getPrismaClient();
    try {
      await this.verifyAppStoreCredentials(
        await this.appleDeveloperCredentials(current),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Credential verification failed";
      await prisma.iosDeviceSettings.update({
        where: { id: SETTINGS_ID },
        data: {
          appStoreConnectVerifiedAt: null,
          appStoreConnectLastTestedAt: new Date(),
          appStoreConnectVerificationError: message,
        },
      });
      throw new Error(message);
    }
    await prisma.iosDeviceSettings.update({
      where: { id: SETTINGS_ID },
      data: {
        appStoreConnectVerifiedAt: new Date(),
        appStoreConnectLastTestedAt: new Date(),
        appStoreConnectVerificationError: null,
      },
    });
    return this.getSettings();
  }

  async clearAppStoreConnectSettings(): Promise<IosDeviceSettingsView> {
    await this.credentials.delete(
      CREDENTIALS.appStoreConnectPrivateKey,
      async (transaction) => {
        await transaction.iosDeviceSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID },
          update: {
            appStoreConnectIssuerId: null,
            appStoreConnectKeyId: null,
            appStoreConnectPrivateKeyFingerprint: null,
            appStoreConnectVerifiedAt: null,
            appStoreConnectLastTestedAt: null,
            appStoreConnectVerificationError: null,
          },
        });
      },
    );
    return this.getSettings();
  }

  async registerDevice(id: string) {
    await this.recoverStaleRegistrationClaims();
    const current = await this.rawSettings();
    if (
      !current.appStoreConnectIssuerId ||
      !current.appStoreConnectKeyId ||
      !current.appStoreConnectVerifiedAt
    ) {
      throw new Error(
        "Configure and verify an App Store Connect API key in Settings first",
      );
    }
    const appleCredentials = await this.appleDeveloperCredentials(current);
    const prisma = await getPrismaClient();
    const device = await prisma.iosDevice.findUnique({ where: { id } });
    if (!device) throw new Error("Device not found");
    const claimedAt = new Date();
    const claim = await prisma.iosDevice.updateMany({
      where: {
        id,
        status: { in: ["PENDING", "REGISTRATION_FAILED"] },
      },
      data: {
        status: "REGISTERING",
        registrationClaimedAt: claimedAt,
        registrationError: null,
      },
    });
    if (claim.count !== 1) {
      throw new Error("This device cannot be registered in its current state");
    }
    this.changed(id);
    try {
      const encodedUdid = encodeURIComponent(device.udid);
      const existing = await this.appleRequest<AppleDeviceListResponse>(
        appleCredentials,
        `/v1/devices?filter%5Budid%5D=${encodedUdid}&limit=1`,
        {},
        device.udid,
      );
      const resource =
        existing.data[0] ??
        (
          await this.appleRequest<AppleDeviceResponse>(
            appleCredentials,
            "/v1/devices",
            {
              method: "POST",
              body: JSON.stringify({
                data: {
                  type: "devices",
                  attributes: {
                    name: device.displayName,
                    platform: "IOS",
                    udid: device.udid,
                  },
                },
              }),
            },
            device.udid,
          )
        ).data;
      await prisma.iosDevice.updateMany({
        where: { id, status: "REGISTERING", registrationClaimedAt: claimedAt },
        data: {
          status: "REGISTERED",
          registrationClaimedAt: null,
          appleDeviceId: resource.id,
          appleStatus: resource.attributes.status ?? "ENABLED",
          registeredAt: new Date(),
          registrationError: null,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Apple registration failed";
      await prisma.iosDevice.updateMany({
        where: { id, status: "REGISTERING", registrationClaimedAt: claimedAt },
        data: {
          status: "REGISTRATION_FAILED",
          registrationClaimedAt: null,
          registrationError: message,
        },
      });
      this.changed(id);
      throw new Error(message);
    }
    this.changed(id);
    return this.device(id);
  }

  async exportTsv(): Promise<string> {
    const prisma = await getPrismaClient();
    const devices = await prisma.iosDevice.findMany({
      where: { status: { not: "REJECTED" } },
      orderBy: { displayName: "asc" },
    });
    return [
      "Device ID\tDevice Name\tDevice Platform",
      ...devices.map(
        (device) =>
          `${safeTsv(device.udid)}\t${safeTsv(device.displayName)}\tios`,
      ),
    ].join("\n");
  }

  private async recoverStaleRegistrationClaims(now = new Date()) {
    const prisma = await getPrismaClient();
    const recovered = await prisma.iosDevice.updateMany({
      where: {
        status: "REGISTERING",
        OR: [
          { registrationClaimedAt: null },
          {
            registrationClaimedAt: {
              lt: new Date(now.getTime() - REGISTRATION_CLAIM_TTL_MS),
            },
          },
        ],
      },
      data: {
        status: "REGISTRATION_FAILED",
        registrationClaimedAt: null,
        registrationError: INTERRUPTED_REGISTRATION_ERROR,
      },
    });
    if (recovered.count) this.changed();
  }
}
