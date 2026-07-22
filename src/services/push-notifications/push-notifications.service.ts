import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";

import { importPKCS8 } from "jose";

import { getPrismaClient } from "@/data/prisma-client";
import {
  CREDENTIALS,
  CredentialService,
  apnsCertificateCredential,
} from "@/services/credentials";
import {
  agentEventBus,
  PUSH_NOTIFICATIONS_CHANGED_TOPIC,
} from "@/services/agent-control/event-bus";

import {
  ApnsClient,
  type ApnsAuthentication,
  type ApnsResponse,
} from "./apns-client";
import {
  parseApnsRegistrationInput,
  normalizeDeviceToken,
  validatePushEditor,
  type ApnsRegistrationInput,
  type PushEditor,
} from "./validation";

const SETTINGS_ID = "default";
const STALE_BATCH_MS = 2 * 60_000;
const RECOVERY_INTERVAL_MS = 30_000;
const DELIVERY_CONCURRENCY = 16;
const PUSH_TARGET_MODES = ["DEVICES", "ALL", "DIRECT", "BROADCAST"] as const;

type PushTargetMode = (typeof PUSH_TARGET_MODES)[number];
type ApnsCertificateSecret = { p12Base64: string; passphrase: string };

function isPushTargetMode(value: string): value is PushTargetMode {
  return (PUSH_TARGET_MODES as readonly string[]).includes(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

function inspectCertificateCredential(
  bytes: Buffer,
  passphrase: string,
): { expiresAt: Date; fingerprint: string } {
  let context: ReturnType<typeof createSecureContext>;
  try {
    context = createSecureContext({ pfx: bytes, passphrase });
  } catch {
    throw new Error("The .p12 file or passphrase is invalid");
  }
  const rawCertificate = (
    context.context as unknown as { getCertificate(): Buffer | undefined }
  ).getCertificate();
  if (!rawCertificate?.length) {
    throw new Error("The .p12 file does not contain a leaf certificate");
  }
  const certificate = new X509Certificate(rawCertificate);
  const expiresAt = new Date(certificate.validTo);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("The .p12 certificate expiration date is invalid");
  }
  return {
    expiresAt,
    fingerprint: certificate.fingerprint256.replaceAll(":", "").toUpperCase(),
  };
}

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

function strings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function clean(value: string, name: string, max = 200): string {
  const text = value.trim();
  if (!text || text.length > max || text.includes("\0")) {
    throw new Error(`${name} is required or invalid`);
  }
  return text;
}

export class PushNotificationsService {
  private recoveryStarted = false;
  private readonly activeBatchIds = new Set<string>();

  constructor(
    private readonly client = new ApnsClient(),
    private readonly credentials = new CredentialService(),
  ) {
    queueMicrotask(() => void this.recover().catch(() => undefined));
    const timer = setInterval(
      () => void this.recover().catch(() => undefined),
      RECOVERY_INTERVAL_MS,
    );
    timer.unref();
  }

  private changed(): void {
    agentEventBus.publish(PUSH_NOTIFICATIONS_CHANGED_TOPIC, { changed: true });
  }

  subscribe() {
    return agentEventBus.iterate<{ changed: boolean }>(
      PUSH_NOTIFICATIONS_CHANGED_TOPIC,
    );
  }

  async register(value: unknown, ipAddress: string | null) {
    const input = parseApnsRegistrationInput(value);
    return this.registerValidated(input, ipAddress);
  }

  private async registerValidated(
    input: ApnsRegistrationInput,
    ipAddress: string | null,
  ) {
    const prisma = await getPrismaClient();
    const tokenHash = sha256(input.token);
    const now = new Date();
    const key = {
      clientRegistrationId: input.clientRegistrationId,
      topic: input.topic,
      environment: input.environment,
    };
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.apnsRegistration.findUnique({
        where: { clientRegistrationId_topic_environment: key },
      });
      const tokenOwner = await tx.apnsRegistration.findUnique({
        where: {
          tokenHash_topic_environment: {
            tokenHash,
            topic: input.topic,
            environment: input.environment,
          },
        },
      });
      if (tokenOwner && tokenOwner.id !== existing?.id) {
        await tx.apnsRegistration.update({
          where: { id: tokenOwner.id },
          data: {
            token: "",
            tokenHash: `REASSIGNED:${tokenOwner.id}:${tokenOwner.tokenHash}`,
            status: "INACTIVE",
            invalidatedAt: now,
            lastFailureReason: "TOKEN_REASSIGNED",
            lastFailureAt: now,
          },
        });
      }
      const data = {
        token: input.token,
        tokenHash,
        pushTypesJson: JSON.stringify(input.supportedPushTypes),
        displayName: input.displayName,
        deviceModel: input.deviceModel,
        osVersion: input.osVersion,
        appVersion: input.appVersion,
        appBuild: input.appBuild,
        locale: input.locale,
        pushMagic: input.pushMagic,
        lastIpAddress: ipAddress,
        status: "ACTIVE",
        invalidatedAt: null,
        lastFailureReason: null,
        lastFailureAt: null,
        lastRegisteredAt: now,
      };
      const registration = existing
        ? await tx.apnsRegistration.update({ where: { id: existing.id }, data })
        : await tx.apnsRegistration.create({
            data: {
              id: randomUUID(),
              ...key,
              ...data,
            },
          });
      return { registration, created: !existing };
    });
    this.changed();
    return result;
  }

  async registrations() {
    const prisma = await getPrismaClient();
    const rows = await prisma.apnsRegistration.findMany({
      orderBy: [{ status: "asc" }, { lastRegisteredAt: "desc" }],
    });
    return rows.map((row) => ({
      ...row,
      tokenMasked: row.token
        ? `${row.token.slice(0, 8)}…${row.token.slice(-8)}`
        : "—",
      supportedPushTypes: strings(row.pushTypesJson),
    }));
  }

  async renameRegistration(id: string, displayName: string) {
    const prisma = await getPrismaClient();
    const result = await prisma.apnsRegistration.update({
      where: { id },
      data: { displayName: clean(displayName, "Display name", 120) },
    });
    this.changed();
    return result;
  }

  async setRegistrationActive(id: string, active: boolean) {
    const prisma = await getPrismaClient();
    const result = await prisma.apnsRegistration.update({
      where: { id },
      data: {
        status: active ? "ACTIVE" : "INACTIVE",
        invalidatedAt: active ? null : new Date(),
      },
    });
    this.changed();
    return result;
  }

  async deleteRegistration(id: string) {
    const prisma = await getPrismaClient();
    await prisma.apnsRegistration.delete({ where: { id } });
    this.changed();
    return true;
  }

  private async rawSettings() {
    const prisma = await getPrismaClient();
    return prisma.pushNotificationSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
  }

  async settings() {
    const prisma = await getPrismaClient();
    const [settings, certificates, tokenSecretConfigured] = await Promise.all([
      this.rawSettings(),
      prisma.apnsCertificateCredential.findMany({
        orderBy: { name: "asc" },
      }),
      this.credentials.isConfigured(CREDENTIALS.apnsTokenPrivateKey),
    ]);
    return {
      tokenConfigured: Boolean(
        settings.tokenTeamId && settings.tokenKeyId && tokenSecretConfigured,
      ),
      tokenTeamId: settings.tokenTeamId,
      tokenKeyId: settings.tokenKeyId,
      tokenPrivateKeyFingerprint: settings.tokenPrivateKeyFingerprint,
      tokenConfiguredAt: settings.tokenConfiguredAt,
      tokenLastUsedAt: settings.tokenLastUsedAt,
      tokenLastError: settings.tokenLastError,
      certificates: certificates.map((credential) => ({
        id: credential.id,
        name: credential.name,
        topic: credential.topic,
        environment: credential.environment,
        fingerprint: credential.fingerprint,
        expiresAt: credential.expiresAt,
        lastTestedAt: credential.lastTestedAt,
        lastError: credential.lastError,
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      })),
      updatedAt: settings.updatedAt,
    };
  }

  async saveTokenSettings(input: {
    teamId: string;
    keyId: string;
    privateKey?: string | null;
  }) {
    await this.rawSettings();
    const teamId = clean(input.teamId, "Team ID", 20);
    const keyId = clean(input.keyId, "Key ID", 20);
    const privateKey =
      input.privateKey?.trim() ||
      (await this.credentials.getText(CREDENTIALS.apnsTokenPrivateKey));
    if (!privateKey?.includes("-----BEGIN PRIVATE KEY-----")) {
      throw new Error("An APNs PKCS#8 .p8 private key is required");
    }
    try {
      await importPKCS8(privateKey, "ES256");
    } catch {
      throw new Error("The APNs .p8 key must be an ES256 PKCS#8 private key");
    }
    await this.credentials.setText(
      CREDENTIALS.apnsTokenPrivateKey,
      privateKey,
      async (transaction) => {
        await transaction.pushNotificationSettings.update({
          where: { id: SETTINGS_ID },
          data: {
            tokenTeamId: teamId,
            tokenKeyId: keyId,
            tokenPrivateKeyFingerprint: sha256(privateKey),
            tokenConfiguredAt: new Date(),
            tokenLastError: null,
          },
        });
      },
    );
    this.changed();
    return this.settings();
  }

  async clearTokenSettings() {
    await this.credentials.delete(
      CREDENTIALS.apnsTokenPrivateKey,
      async (transaction) => {
        await transaction.pushNotificationSettings.upsert({
          where: { id: SETTINGS_ID },
          create: { id: SETTINGS_ID },
          update: {
            tokenTeamId: null,
            tokenKeyId: null,
            tokenPrivateKeyFingerprint: null,
            tokenConfiguredAt: null,
            tokenLastUsedAt: null,
            tokenLastError: null,
          },
        });
      },
    );
    this.changed();
    return this.settings();
  }

  async addCertificateCredential(input: {
    name: string;
    topic: string;
    environment: string;
    p12Base64: string;
    passphrase: string;
  }) {
    const bytes = Buffer.from(input.p12Base64, "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
      throw new Error("The .p12 file is empty or larger than 20 MiB");
    }
    if (!["SANDBOX", "PRODUCTION"].includes(input.environment)) {
      throw new Error("Certificate environment is invalid");
    }
    const certificate = inspectCertificateCredential(bytes, input.passphrase);
    const id = randomUUID();
    await this.credentials.setJson<ApnsCertificateSecret>(
      apnsCertificateCredential(id),
      { p12Base64: input.p12Base64, passphrase: input.passphrase },
      async (transaction) => {
        await transaction.apnsCertificateCredential.create({
          data: {
            id,
            name: clean(input.name, "Credential name", 100),
            topic: clean(input.topic, "Topic", 255),
            environment: input.environment,
            fingerprint: certificate.fingerprint,
            expiresAt: certificate.expiresAt,
            lastTestedAt: new Date(),
          },
        });
      },
    );
    this.changed();
    return this.settings();
  }

  async deleteCertificateCredential(id: string) {
    await this.credentials.delete(
      apnsCertificateCredential(id),
      async (transaction) => {
        await transaction.apnsCertificateCredential.delete({ where: { id } });
      },
    );
    this.changed();
    return true;
  }

  async retestCertificateCredential(id: string) {
    const prisma = await getPrismaClient();
    const credential = await prisma.apnsCertificateCredential.findUnique({
      where: { id },
    });
    if (!credential) throw new Error("APNs certificate credential not found");
    const secret = await this.credentials.getJson<ApnsCertificateSecret>(
      apnsCertificateCredential(id),
    );
    if (!secret)
      throw new Error("APNs certificate credential is not configured");
    try {
      const certificate = inspectCertificateCredential(
        Buffer.from(secret.p12Base64, "base64"),
        secret.passphrase,
      );
      await prisma.apnsCertificateCredential.update({
        where: { id },
        data: {
          fingerprint: certificate.fingerprint,
          expiresAt: certificate.expiresAt,
          lastTestedAt: new Date(),
          lastError: null,
        },
      });
    } catch (error) {
      await prisma.apnsCertificateCredential.update({
        where: { id },
        data: {
          lastTestedAt: new Date(),
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
      this.changed();
      throw error;
    }
    this.changed();
    return this.settings();
  }

  async channels() {
    const prisma = await getPrismaClient();
    return prisma.apnsBroadcastChannel.findMany({
      orderBy: { createdAt: "desc" },
    });
  }

  private async tokenAuthentication(
    errorMessage = "APNs token authentication is not configured",
  ): Promise<Extract<ApnsAuthentication, { kind: "TOKEN" }>> {
    const settings = await this.rawSettings();
    if (!settings.tokenTeamId || !settings.tokenKeyId) {
      throw new Error(errorMessage);
    }
    const privateKey = await this.credentials.getText(
      CREDENTIALS.apnsTokenPrivateKey,
    );
    if (!privateKey) throw new Error(errorMessage);
    return {
      kind: "TOKEN",
      teamId: settings.tokenTeamId,
      keyId: settings.tokenKeyId,
      privateKey,
    };
  }

  async createChannel(input: {
    channelId?: string | null;
    bundleId: string;
    environment: string;
    storagePolicy: string;
  }) {
    if (!["SANDBOX", "PRODUCTION"].includes(input.environment)) {
      throw new Error("Channel environment is invalid");
    }
    if (!["NO_STORAGE", "MOST_RECENT"].includes(input.storagePolicy)) {
      throw new Error("Channel storage policy is invalid");
    }
    const bundleId = clean(input.bundleId, "Bundle ID", 255);
    const authentication = input.channelId
      ? null
      : await this.tokenAuthentication(
          "APNs token authentication is required for broadcast channels",
        );
    const channelId =
      input.channelId?.trim() ||
      (await this.client.createBroadcastChannel({
        environment: input.environment as "SANDBOX" | "PRODUCTION",
        authentication: authentication!,
        bundleId,
        storagePolicy: input.storagePolicy as "NO_STORAGE" | "MOST_RECENT",
      }));
    const prisma = await getPrismaClient();
    const channel = await prisma.apnsBroadcastChannel.create({
      data: {
        id: randomUUID(),
        channelId,
        bundleId,
        environment: input.environment,
        storagePolicy: input.storagePolicy,
      },
    });
    this.changed();
    return channel;
  }

  async deleteChannel(id: string) {
    const prisma = await getPrismaClient();
    const channel = await prisma.apnsBroadcastChannel.findUnique({
      where: { id },
    });
    if (!channel) throw new Error("Broadcast channel not found");
    const authentication = await this.tokenAuthentication(
      "APNs token authentication is required for broadcast channels",
    );
    await this.client.deleteBroadcastChannel({
      environment: channel.environment as "SANDBOX" | "PRODUCTION",
      authentication,
      bundleId: channel.bundleId,
      channelId: channel.channelId,
    });
    await prisma.apnsBroadcastChannel.delete({ where: { id } });
    this.changed();
    return true;
  }

  async presets() {
    const prisma = await getPrismaClient();
    return prisma.pushNotificationPreset.findMany({
      orderBy: { updatedAt: "desc" },
    });
  }

  async preset(id: string) {
    const prisma = await getPrismaClient();
    return prisma.pushNotificationPreset.findUnique({ where: { id } });
  }

  async savePreset(name: string, editor: unknown, id?: string | null) {
    const validated = validatePushEditor(editor);
    const prisma = await getPrismaClient();
    const value = id
      ? await prisma.pushNotificationPreset.update({
          where: { id },
          data: {
            name: clean(name, "Preset name", 100),
            editorJson: JSON.stringify(validated.editor),
          },
        })
      : await prisma.pushNotificationPreset.create({
          data: {
            id: randomUUID(),
            name: clean(name, "Preset name", 100),
            editorJson: JSON.stringify(validated.editor),
          },
        });
    this.changed();
    return value;
  }

  async deletePreset(id: string) {
    const prisma = await getPrismaClient();
    await prisma.pushNotificationPreset.delete({ where: { id } });
    this.changed();
    return true;
  }

  async history(limit = 100) {
    const prisma = await getPrismaClient();
    return prisma.pushNotificationBatch.findMany({
      include: { deliveries: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(limit, 200)),
    });
  }

  async historyItem(id: string) {
    const prisma = await getPrismaClient();
    return prisma.pushNotificationBatch.findUnique({
      where: { id },
      include: { deliveries: { orderBy: { createdAt: "asc" } } },
    });
  }

  async saveDraft(editor: unknown) {
    const validated = validatePushEditor(editor);
    const prisma = await getPrismaClient();
    const batch = await prisma.pushNotificationBatch.create({
      data: {
        id: randomUUID(),
        requestId: randomUUID(),
        status: "DRAFT",
        editorJson: JSON.stringify(validated.editor),
        payloadJson: JSON.stringify(validated.payload),
        headersJson: JSON.stringify(validated.headers),
        targetMode: "DRAFT",
      },
      include: { deliveries: true },
    });
    this.changed();
    return batch;
  }

  async deleteHistory(id: string) {
    const prisma = await getPrismaClient();
    const deleted = await prisma.pushNotificationBatch.deleteMany({
      where: { id, status: { notIn: ["QUEUED", "SENDING"] } },
    });
    if (deleted.count !== 1) {
      const batch = await prisma.pushNotificationBatch.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!batch) throw new Error("Push history item not found");
      throw new Error("Queued or sending push notifications cannot be deleted");
    }
    this.changed();
    return true;
  }

  async clearHistory() {
    const prisma = await getPrismaClient();
    const result = await prisma.pushNotificationBatch.deleteMany({
      where: { status: { notIn: ["QUEUED", "SENDING"] } },
    });
    this.changed();
    return result.count;
  }

  async send(input: {
    requestId: string;
    editor: unknown;
    targetMode: string;
    registrationIds?: string[];
    channelId?: string | null;
    directToken?: string | null;
    directTokenEncoding?: "HEX" | "BASE64" | null;
    directEnvironment?: "SANDBOX" | "PRODUCTION" | null;
  }) {
    if (!isPushTargetMode(input.targetMode)) {
      throw new Error(`Unsupported push target mode: ${input.targetMode}`);
    }
    const targetMode = input.targetMode;
    const validated = validatePushEditor(input.editor);
    const prisma = await getPrismaClient();
    const existing = await prisma.pushNotificationBatch.findUnique({
      where: { requestId: input.requestId },
      include: { deliveries: true },
    });
    if (existing) return existing;

    let recipients: Array<{
      id: string;
      tokenHash: string;
      topic: string;
      environment: string;
    }> = [];
    let channel = null;
    let directRecipient: {
      token: string;
      tokenHash: string;
      environment: "SANDBOX" | "PRODUCTION";
    } | null = null;
    if (targetMode === "BROADCAST") {
      if (validated.editor.pushType !== "liveactivity") {
        throw new Error(
          "Broadcast delivery is available only for Live Activities",
        );
      }
      if (!input.channelId) throw new Error("Select a broadcast channel");
      channel = await prisma.apnsBroadcastChannel.findUnique({
        where: { id: input.channelId },
      });
      if (!channel) throw new Error("Broadcast channel not found");
    } else if (targetMode === "DIRECT") {
      if (validated.editor.pushType !== "liveactivity") {
        throw new Error(
          "Direct-token delivery is available only for Live Activities",
        );
      }
      if (!input.directToken) {
        throw new Error("Enter a Live Activity push token");
      }
      const encoding = input.directTokenEncoding ?? "HEX";
      if (encoding !== "HEX" && encoding !== "BASE64") {
        throw new Error("Direct token encoding must be HEX or BASE64");
      }
      const environment = input.directEnvironment ?? "SANDBOX";
      if (environment !== "SANDBOX" && environment !== "PRODUCTION") {
        throw new Error("Direct token environment is invalid");
      }
      const token = normalizeDeviceToken(input.directToken, encoding);
      directRecipient = { token, tokenHash: sha256(token), environment };
    } else {
      const ids = [...new Set(input.registrationIds ?? [])];
      const rows = await prisma.apnsRegistration.findMany({
        where: {
          status: "ACTIVE",
          topic: validated.headers["apns-topic"],
          ...(targetMode === "DEVICES" ? { id: { in: ids } } : {}),
        },
      });
      recipients = rows
        .filter((row) =>
          strings(row.pushTypesJson).includes(validated.editor.pushType),
        )
        .map((row) => ({
          id: row.id,
          tokenHash: row.tokenHash,
          topic: row.topic,
          environment: row.environment,
        }));
      if (!recipients.length)
        throw new Error("No eligible APNs devices selected");
    }

    const batch = await prisma.pushNotificationBatch.create({
      data: {
        id: randomUUID(),
        requestId: input.requestId,
        status: "QUEUED",
        editorJson: JSON.stringify(validated.editor),
        payloadJson: JSON.stringify(validated.payload),
        headersJson: JSON.stringify(validated.headers),
        targetMode,
        channelId: channel?.id ?? null,
        recipientCount: channel || directRecipient ? 1 : recipients.length,
        deliveries: {
          create: channel
            ? [
                {
                  id: randomUUID(),
                  topic: channel.bundleId,
                  environment: channel.environment,
                },
              ]
            : directRecipient
              ? [
                  {
                    id: randomUUID(),
                    tokenHash: directRecipient.tokenHash,
                    topic: validated.headers["apns-topic"],
                    environment: directRecipient.environment,
                    recipientSecret: {
                      create: {
                        id: randomUUID(),
                        token: directRecipient.token,
                      },
                    },
                  },
                ]
              : recipients.map((recipient) => ({
                  id: randomUUID(),
                  registrationId: recipient.id,
                  tokenHash: recipient.tokenHash,
                  topic: recipient.topic,
                  environment: recipient.environment,
                })),
        },
      },
      include: { deliveries: true },
    });
    this.changed();
    void this.processBatch(batch.id).catch(() => undefined);
    return batch;
  }

  async resend(id: string, requestId: string) {
    const prisma = await getPrismaClient();
    const batch = await prisma.pushNotificationBatch.findUnique({
      where: { id },
      include: { deliveries: true },
    });
    if (!batch) throw new Error("Push history item not found");
    if (batch.targetMode === "DRAFT") {
      throw new Error("Choose recipients before sending a draft");
    }
    if (batch.targetMode === "DIRECT") {
      throw new Error(
        "Direct Live Activity tokens are not retained; load the item and enter the token again",
      );
    }
    return this.send({
      requestId,
      editor: json(batch.editorJson),
      targetMode: batch.targetMode as "DEVICES" | "ALL" | "BROADCAST",
      registrationIds: batch.deliveries
        .map((delivery) => delivery.registrationId)
        .filter((value): value is string => Boolean(value)),
      channelId: batch.channelId,
    });
  }

  private async authentication(
    editor: PushEditor,
    environment: string,
    topic: string,
  ): Promise<ApnsAuthentication> {
    const prisma = await getPrismaClient();
    if (editor.credentialId) {
      const credential = await prisma.apnsCertificateCredential.findUnique({
        where: { id: editor.credentialId },
      });
      if (!credential) throw new Error("APNs certificate credential not found");
      if (
        credential.environment !== environment ||
        credential.topic !== topic
      ) {
        throw new Error(
          "APNs certificate does not match the target topic/environment",
        );
      }
      const secret = await this.credentials.getJson<ApnsCertificateSecret>(
        apnsCertificateCredential(credential.id),
      );
      if (!secret) {
        throw new Error("APNs certificate credential is not configured");
      }
      return {
        kind: "CERTIFICATE",
        p12Base64: secret.p12Base64,
        passphrase: secret.passphrase,
        fingerprint: credential.fingerprint,
      };
    }
    if (editor.pushType === "mdm") {
      throw new Error("MDM requires certificate authentication");
    }
    return this.tokenAuthentication();
  }

  private async failDelivery(id: string, reason: string) {
    const prisma = await getPrismaClient();
    await prisma.pushNotificationDelivery.update({
      where: { id },
      data: {
        status: "FAILED",
        reason,
        finishedAt: new Date(),
      },
    });
    this.changed();
  }

  private async executeDelivery(
    delivery: {
      id: string;
      registrationId: string | null;
      environment: string;
      topic: string;
    },
    editor: PushEditor,
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    channel: { channelId: string; bundleId: string } | null,
  ): Promise<void> {
    const prisma = await getPrismaClient();
    await prisma.pushNotificationDelivery.update({
      where: { id: delivery.id },
      data: { status: "SENDING", startedAt: new Date() },
    });
    this.changed();
    try {
      const registration = delivery.registrationId
        ? await prisma.apnsRegistration.findUnique({
            where: { id: delivery.registrationId },
          })
        : null;
      const directRecipient = !delivery.registrationId
        ? await prisma.apnsPushRecipientSecret.findUnique({
            where: { deliveryId: delivery.id },
          })
        : null;
      if (
        delivery.registrationId &&
        (!registration || registration.status !== "ACTIVE")
      ) {
        await this.failDelivery(
          delivery.id,
          "Registration is no longer active",
        );
        return;
      }
      if (!registration && !directRecipient && !channel) {
        await this.failDelivery(delivery.id, "Direct recipient token expired");
        return;
      }
      const authentication = await this.authentication(
        editor,
        delivery.environment,
        delivery.topic,
      );
      const recipientPayload =
        editor.pushType === "mdm" ? { mdm: registration?.pushMagic } : payload;
      if (editor.pushType === "mdm" && !registration?.pushMagic) {
        await this.failDelivery(
          delivery.id,
          "Registration has no MDM push magic",
        );
        return;
      }
      const response = await this.client.send({
        environment: delivery.environment as "SANDBOX" | "PRODUCTION",
        authentication,
        deviceToken: registration?.token || directRecipient?.token,
        broadcastTopic: channel?.bundleId,
        payload: recipientPayload,
        headers: {
          ...headers,
          ...(channel ? { "apns-channel-id": channel.channelId } : {}),
        },
      });
      await this.recordResponse(
        delivery.id,
        registration,
        response,
        authentication.kind === "TOKEN",
      );
      if (authentication.kind === "CERTIFICATE" && editor.credentialId) {
        await prisma.apnsCertificateCredential.updateMany({
          where: { id: editor.credentialId },
          data: {
            lastTestedAt: new Date(),
            lastError:
              response.status === 200
                ? null
                : `HTTP ${response.status}${response.reason ? `: ${response.reason}` : ""}`,
          },
        });
      }
    } catch (error) {
      if (!editor.credentialId && editor.pushType !== "mdm") {
        const prisma = await getPrismaClient();
        await prisma.pushNotificationSettings.updateMany({
          where: { id: SETTINGS_ID },
          data: {
            tokenLastError:
              error instanceof Error ? error.message : String(error),
          },
        });
      }
      if (editor.credentialId) {
        const prisma = await getPrismaClient();
        await prisma.apnsCertificateCredential.updateMany({
          where: { id: editor.credentialId },
          data: {
            lastTestedAt: new Date(),
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
      }
      await this.failDelivery(
        delivery.id,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await prisma.apnsPushRecipientSecret.deleteMany({
        where: { deliveryId: delivery.id },
      });
    }
  }

  private async recordResponse(
    deliveryId: string,
    registration: {
      id: string;
      lastRegisteredAt: Date;
    } | null,
    response: ApnsResponse,
    tokenAuthentication: boolean,
  ) {
    const prisma = await getPrismaClient();
    const succeeded = response.status === 200;
    await prisma.pushNotificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: succeeded ? "SUCCEEDED" : "FAILED",
        responseCode: response.status,
        reason: response.reason,
        responseTimestamp: response.timestamp,
        apnsId: response.apnsId,
        attempts: response.attempts,
        durationMs: response.durationMs,
        finishedAt: new Date(),
      },
    });
    this.changed();
    if (tokenAuthentication) {
      await prisma.pushNotificationSettings.updateMany({
        where: { id: SETTINGS_ID },
        data: succeeded
          ? { tokenLastUsedAt: new Date(), tokenLastError: null }
          : {
              tokenLastError: `HTTP ${response.status}${response.reason ? `: ${response.reason}` : ""}`,
            },
      });
    }
    if (!registration) return;
    if (succeeded) {
      await prisma.apnsRegistration.update({
        where: { id: registration.id },
        data: { lastSentAt: new Date(), lastFailureReason: null },
      });
      return;
    }
    const invalid =
      response.status === 410 && response.reason === "Unregistered";
    const confirmedBad =
      response.status === 400 &&
      ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(
        response.reason ?? "",
      );
    const safeTimestamp =
      !response.timestamp ||
      response.timestamp >= registration.lastRegisteredAt;
    if ((invalid && safeTimestamp) || confirmedBad) {
      await prisma.apnsRegistration.updateMany({
        where: {
          id: registration.id,
          lastRegisteredAt: registration.lastRegisteredAt,
        },
        data: {
          status: "INVALID",
          invalidatedAt: new Date(),
          lastFailureReason: response.reason,
          lastFailureAt: new Date(),
        },
      });
    } else {
      await prisma.apnsRegistration.update({
        where: { id: registration.id },
        data: {
          lastFailureReason: response.reason,
          lastFailureAt: new Date(),
        },
      });
    }
  }

  private async processBatch(id: string): Promise<void> {
    const prisma = await getPrismaClient();
    const claim = await prisma.pushNotificationBatch.updateMany({
      where: { id, status: "QUEUED" },
      data: { status: "SENDING", startedAt: new Date(), error: null },
    });
    if (claim.count !== 1) return;
    this.activeBatchIds.add(id);
    try {
      const batch = await prisma.pushNotificationBatch.findUnique({
        where: { id },
        include: { deliveries: { where: { status: "QUEUED" } } },
      });
      if (!batch) return;
      const editor = json<PushEditor>(batch.editorJson);
      const payload = json<Record<string, unknown>>(batch.payloadJson);
      const headers = json<Record<string, string>>(batch.headersJson);
      const channel = batch.channelId
        ? await prisma.apnsBroadcastChannel.findUnique({
            where: { id: batch.channelId },
          })
        : null;
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(DELIVERY_CONCURRENCY, batch.deliveries.length) },
        async () => {
          while (cursor < batch.deliveries.length) {
            const delivery = batch.deliveries[cursor++];
            if (!delivery) return;
            await this.executeDelivery(
              delivery,
              editor,
              payload,
              headers,
              channel,
            );
          }
        },
      );
      await Promise.all(workers);
      const deliveries = await prisma.pushNotificationDelivery.findMany({
        where: { batchId: id },
        select: { status: true },
      });
      const successCount = deliveries.filter(
        (delivery) => delivery.status === "SUCCEEDED",
      ).length;
      const failureCount = deliveries.length - successCount;
      await prisma.pushNotificationBatch.update({
        where: { id },
        data: {
          status: failureCount
            ? successCount
              ? "PARTIAL"
              : "FAILED"
            : "SUCCEEDED",
          successCount,
          failureCount,
          finishedAt: new Date(),
        },
      });
      this.changed();
    } finally {
      this.activeBatchIds.delete(id);
    }
  }

  async recover(): Promise<void> {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    try {
      const prisma = await getPrismaClient();
      while (true) {
        const staleBefore = new Date(Date.now() - STALE_BATCH_MS);
        const stale = await prisma.pushNotificationBatch.findMany({
          where: {
            OR: [
              { status: "QUEUED" },
              { status: "SENDING", startedAt: { lt: staleBefore } },
            ],
          },
          orderBy: { createdAt: "asc" },
          take: 100,
        });
        if (!stale.length) break;
        const recoverableIds: string[] = [];
        for (const batch of stale) {
          if (this.activeBatchIds.has(batch.id)) continue;
          if (batch.status === "SENDING") {
            await prisma.pushNotificationDelivery.updateMany({
              where: { batchId: batch.id, status: "SENDING" },
              data: { status: "QUEUED", startedAt: null },
            });
            const reset = await prisma.pushNotificationBatch.updateMany({
              where: {
                id: batch.id,
                status: "SENDING",
                startedAt: { lt: staleBefore },
              },
              data: { status: "QUEUED", startedAt: null },
            });
            if (reset.count !== 1) continue;
          }
          recoverableIds.push(batch.id);
        }
        if (!recoverableIds.length) break;
        await Promise.all(
          recoverableIds.map((batchId) => this.processBatch(batchId)),
        );
      }
    } finally {
      this.recoveryStarted = false;
    }
  }
}
