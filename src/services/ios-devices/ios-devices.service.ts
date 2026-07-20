import { randomUUID } from "node:crypto";

import {
  parsePlist,
  plistDocument,
} from "@ai-development-environment/agent-contract/plist";
import { importPKCS8, SignJWT } from "jose";

import { getPrismaClient } from "@/data/prisma-client";
import {
  agentEventBus,
  IOS_DEVICES_CHANGED_TOPIC,
} from "@/services/agent-control/event-bus";

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
  IosDeviceSettingsView,
  IosDeviceStatus,
} from "./types";

const SETTINGS_ID = "default";
const ENROLLMENT_TTL_MS = 30 * 60_000;
const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const APP_STORE_CONNECT_API = "https://api.appstoreconnect.apple.com";

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
  const callback = `${publicOrigin}/api/ios/profile-response?token=${encodeURIComponent(token)}`;
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

function settingsView(value: {
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
  updatedAt: Date;
}): IosDeviceSettingsView {
  return {
    organizationName: value.organizationName,
    profileIdentifier: value.profileIdentifier,
    signerConfigured: Boolean(
      value.signerCertificatePem && value.signerPrivateKeyPem,
    ),
    signerFingerprint: value.signerFingerprint,
    signerCreatedAt: value.signerCreatedAt?.toISOString() ?? null,
    signerExpiresAt: value.signerExpiresAt?.toISOString() ?? null,
    appStoreConnectConfigured: Boolean(
      value.appStoreConnectIssuerId &&
      value.appStoreConnectKeyId &&
      value.appStoreConnectPrivateKey &&
      value.appStoreConnectVerifiedAt,
    ),
    appStoreConnectIssuerId: value.appStoreConnectIssuerId,
    appStoreConnectKeyId: value.appStoreConnectKeyId,
    appStoreConnectPrivateKeyConfigured: Boolean(
      value.appStoreConnectPrivateKey,
    ),
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
  constructor(private readonly fetcher: FetchLike = fetch) {}

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
    return settingsView(await this.rawSettings());
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
    const settings = await prisma.iosDeviceSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, organizationName, profileIdentifier },
      update: { organizationName, profileIdentifier },
    });
    return settingsView(settings);
  }

  private async ensureProfileSigner() {
    const current = await this.rawSettings();
    if (current.signerCertificatePem && current.signerPrivateKeyPem) {
      return current;
    }
    return this.regenerateProfileSigner();
  }

  async regenerateProfileSigner() {
    const current = await this.rawSettings();
    const signer = await generateProfileSigner(current.organizationName);
    const prisma = await getPrismaClient();
    return prisma.iosDeviceSettings.update({
      where: { id: SETTINGS_ID },
      data: {
        signerCertificatePem: signer.certificatePem,
        signerPrivateKeyPem: signer.privateKeyPem,
        signerFingerprint: signer.fingerprint,
        signerCreatedAt: signer.createdAt,
        signerExpiresAt: signer.expiresAt,
      },
    });
  }

  async regenerateProfileSignerView(): Promise<IosDeviceSettingsView> {
    return settingsView(await this.regenerateProfileSigner());
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
      await prisma.iosDeviceEnrollment.update({
        where: { id: enrollment.id },
        data: { status: "FAILED", failureCode: "INVALID_DEVICE_RESPONSE" },
      });
      throw new IosEnrollmentError(
        error instanceof Error ? error.message : "Device response is invalid",
        400,
        "INVALID_DEVICE_RESPONSE",
      );
    }

    const now = new Date();
    const prisma = await getPrismaClient();
    const device = await prisma.$transaction(async (tx) => {
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
          consumedAt: now,
          responseDigest,
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
    const prisma = await getPrismaClient();
    return prisma.iosDevice.findUnique({
      where: { id },
      include: {
        enrollments: { orderBy: { createdAt: "desc" } },
        ipObservations: { orderBy: { observedAt: "desc" } },
      },
    });
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
    const prisma = await getPrismaClient();
    const device = await prisma.iosDevice.findUnique({ where: { id } });
    if (!device) throw new Error("Device not found");
    if (device.status === "REGISTERING") {
      throw new Error("Wait for Apple registration to finish before deleting");
    }
    await prisma.iosDevice.delete({ where: { id } });
    this.changed(id);
    return true;
  }

  private async appStoreToken(credentials: {
    appStoreConnectIssuerId: string | null;
    appStoreConnectKeyId: string | null;
    appStoreConnectPrivateKey: string | null;
  }): Promise<string> {
    if (
      !credentials.appStoreConnectIssuerId ||
      !credentials.appStoreConnectKeyId ||
      !credentials.appStoreConnectPrivateKey
    ) {
      throw new Error("App Store Connect API credentials are not configured");
    }
    let key: Awaited<ReturnType<typeof importPKCS8>>;
    try {
      key = await importPKCS8(credentials.appStoreConnectPrivateKey, "ES256");
    } catch {
      throw new Error(
        "The App Store Connect key must be an ES256 PKCS#8 private key",
      );
    }
    return new SignJWT({})
      .setProtectedHeader({
        alg: "ES256",
        kid: credentials.appStoreConnectKeyId,
        typ: "JWT",
      })
      .setIssuer(credentials.appStoreConnectIssuerId)
      .setAudience("appstoreconnect-v1")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(key);
  }

  private async appleRequest<T>(
    credentials: {
      appStoreConnectIssuerId: string | null;
      appStoreConnectKeyId: string | null;
      appStoreConnectPrivateKey: string | null;
    },
    path: string,
    init: RequestInit = {},
    redact = "",
  ): Promise<T> {
    const token = await this.appStoreToken(credentials);
    let response: Response;
    try {
      response = await this.fetcher(`${APP_STORE_CONNECT_API}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new Error(
          "App Store Connect timed out; retry to reconcile the device",
        );
      }
      throw new Error("Could not connect to App Store Connect");
    }
    const body = (await response.json().catch(() => ({}))) as {
      errors?: Array<{
        status?: string;
        code?: string;
        title?: string;
        detail?: string;
      }>;
    } & T;
    if (!response.ok) {
      const detail = body.errors
        ?.map((entry) => entry.detail || entry.title || entry.code)
        .filter(Boolean)
        .join("; ");
      const classification = `${
        body.errors
          ?.map(
            (entry) =>
              `${entry.code ?? ""} ${entry.title ?? ""} ${entry.detail ?? ""}`,
          )
          .join(" ") ?? ""
      }`.toLowerCase();
      const message =
        response.status === 401 || response.status === 403
          ? "App Store Connect rejected the API key or its Certificates, Identifiers & Profiles access"
          : response.status === 429
            ? "Apple rate-limited device registration; wait and retry"
            : /maximum|device.?limit|limit.?reached/.test(classification)
              ? "The Apple Developer account has reached its annual device limit for this platform"
              : /duplicate|already (?:exists|registered)/.test(classification)
                ? "Apple reports that this device already exists; retry registration to reconcile it"
                : /invalid.{0,30}udid|udid.{0,30}invalid/.test(classification)
                  ? "Apple rejected the UDID as invalid; re-enroll the device and try again"
                  : response.status === 422
                    ? `Apple rejected the device data${detail ? `: ${detail}` : ""}`
                    : detail ||
                      `App Store Connect returned HTTP ${response.status}`;
      throw new Error(redact ? redactValue(message, redact) : message);
    }
    return body;
  }

  private async verifyAppStoreCredentials(credentials: {
    appStoreConnectIssuerId: string;
    appStoreConnectKeyId: string;
    appStoreConnectPrivateKey: string;
  }): Promise<void> {
    await this.appleRequest<AppleDeviceListResponse>(
      credentials,
      "/v1/devices?limit=1",
    );
  }

  async saveAppStoreConnectSettings(
    input: AppStoreConnectSettingsInput,
  ): Promise<IosDeviceSettingsView> {
    const current = await this.rawSettings();
    const issuerId = cleanRequired(input.issuerId, "Issuer ID", 100);
    const keyId = cleanRequired(input.keyId, "Key ID", 100);
    const privateKey =
      input.privateKey?.trim() || current.appStoreConnectPrivateKey;
    if (!privateKey) throw new Error("A .p8 private key is required");
    if (
      !privateKey.includes("-----BEGIN PRIVATE KEY-----") ||
      !privateKey.includes("-----END PRIVATE KEY-----")
    ) {
      throw new Error(
        "The App Store Connect key must be a PKCS#8 .p8 private key",
      );
    }
    const credentials = {
      appStoreConnectIssuerId: issuerId,
      appStoreConnectKeyId: keyId,
      appStoreConnectPrivateKey: privateKey,
    };
    await this.verifyAppStoreCredentials(credentials);
    const prisma = await getPrismaClient();
    const settings = await prisma.iosDeviceSettings.update({
      where: { id: SETTINGS_ID },
      data: {
        ...credentials,
        appStoreConnectPrivateKeyFingerprint: sha256(privateKey).toUpperCase(),
        appStoreConnectVerifiedAt: new Date(),
        appStoreConnectLastTestedAt: new Date(),
        appStoreConnectVerificationError: null,
      },
    });
    return settingsView(settings);
  }

  async testAppStoreConnectSettings(): Promise<IosDeviceSettingsView> {
    const current = await this.rawSettings();
    if (
      !current.appStoreConnectIssuerId ||
      !current.appStoreConnectKeyId ||
      !current.appStoreConnectPrivateKey
    ) {
      throw new Error("App Store Connect API credentials are not configured");
    }
    const prisma = await getPrismaClient();
    try {
      await this.verifyAppStoreCredentials({
        appStoreConnectIssuerId: current.appStoreConnectIssuerId,
        appStoreConnectKeyId: current.appStoreConnectKeyId,
        appStoreConnectPrivateKey: current.appStoreConnectPrivateKey,
      });
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
    return settingsView(
      await prisma.iosDeviceSettings.update({
        where: { id: SETTINGS_ID },
        data: {
          appStoreConnectVerifiedAt: new Date(),
          appStoreConnectLastTestedAt: new Date(),
          appStoreConnectVerificationError: null,
        },
      }),
    );
  }

  async clearAppStoreConnectSettings(): Promise<IosDeviceSettingsView> {
    const prisma = await getPrismaClient();
    return settingsView(
      await prisma.iosDeviceSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID },
        update: {
          appStoreConnectIssuerId: null,
          appStoreConnectKeyId: null,
          appStoreConnectPrivateKey: null,
          appStoreConnectPrivateKeyFingerprint: null,
          appStoreConnectVerifiedAt: null,
          appStoreConnectLastTestedAt: null,
          appStoreConnectVerificationError: null,
        },
      }),
    );
  }

  async registerDevice(id: string) {
    const current = await this.rawSettings();
    if (
      !current.appStoreConnectIssuerId ||
      !current.appStoreConnectKeyId ||
      !current.appStoreConnectPrivateKey ||
      !current.appStoreConnectVerifiedAt
    ) {
      throw new Error(
        "Configure and verify an App Store Connect API key in Settings first",
      );
    }
    const prisma = await getPrismaClient();
    const device = await prisma.iosDevice.findUnique({ where: { id } });
    if (!device) throw new Error("Device not found");
    if (!["PENDING", "REGISTRATION_FAILED"].includes(device.status)) {
      throw new Error("This device cannot be registered in its current state");
    }
    const claim = await prisma.iosDevice.updateMany({
      where: {
        id,
        status: { in: ["PENDING", "REGISTRATION_FAILED"] },
      },
      data: { status: "REGISTERING", registrationError: null },
    });
    if (claim.count !== 1) {
      throw new Error("This device cannot be registered in its current state");
    }
    this.changed(id);
    try {
      const encodedUdid = encodeURIComponent(device.udid);
      const existing = await this.appleRequest<AppleDeviceListResponse>(
        current,
        `/v1/devices?filter%5Budid%5D=${encodedUdid}&limit=1`,
        {},
        device.udid,
      );
      const resource =
        existing.data[0] ??
        (
          await this.appleRequest<AppleDeviceResponse>(
            current,
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
      await prisma.iosDevice.update({
        where: { id },
        data: {
          status: "REGISTERED",
          appleDeviceId: resource.id,
          appleStatus: resource.attributes.status ?? "ENABLED",
          registeredAt: new Date(),
          registrationError: null,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Apple registration failed";
      await prisma.iosDevice.update({
        where: { id },
        data: { status: "REGISTRATION_FAILED", registrationError: message },
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
}
