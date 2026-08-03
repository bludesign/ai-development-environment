import { createHash, randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import {
  APP_NOTIFICATIONS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import {
  apnsTokenConnectionSettings,
  CREDENTIALS,
  readConnectionSettings,
  type CredentialService,
} from "@/services/credentials";
// Imported from the modules directly rather than the package index: the index also pulls in
// PushNotificationsService, whose constructor starts recovery polling the moment it is built.
import {
  ApnsClient,
  type ApnsAuthentication,
} from "@/services/push-notifications/apns-client";
import type { ApnsEnvironment } from "@/services/push-notifications/validation";
import webpush from "web-push";

import {
  parseNotificationDeviceInput,
  type NotificationDeviceInput,
} from "./notification-devices";
import {
  notificationType,
  notificationTypeDefinitions,
  type NotificationTypeKey,
} from "./notification-types";

const MAX_PAGE_SIZE = 200;
const MAX_SELECTION_IDS = 5_000;
const MAX_SELECTION_RANGES = 366;
const DEFAULT_SIDEBAR_LIMIT = 50;
const VAPID_SETTINGS_ID = "default";
const APNS_ALERT_TTL_SECONDS = 60 * 60;

// APNs reports a token the device no longer honours through these reasons. Every other failure is
// transient or a provider-side mistake, so the device keeps its ACTIVE status and gets retried.
const APNS_DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export type NotificationRecord = {
  id: string;
  dedupeKey: string;
  typeKey: string;
  title: string;
  body: string;
  href: string;
  resourceKind: string;
  resourceId: string;
  worktreeId: string | null;
  highlightColor: string | null;
  sidebarRequested: boolean;
  browserRequested: boolean;
  webPushRequested: boolean;
  apnsRequested: boolean;
  sidebarDismissedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationChangeKind =
  | "CREATED"
  | "DISMISSED"
  | "SIDEBAR_CLEARED"
  | "DELETED"
  | "HISTORY_CLEARED"
  | "PREFERENCES_UPDATED"
  | "DEVICES_CHANGED";

export type NotificationChange = {
  kind: NotificationChangeKind;
  notification: NotificationRecord | null;
  notificationId: string | null;
};

export type NotificationSelection = {
  all?: boolean | null;
  ids?: string[] | null;
  excludedIds?: string[] | null;
  ranges?: Array<{ start: string; end: string }> | null;
  excludedRanges?: Array<{ start: string; end: string }> | null;
};

export type RecordNotificationInput = {
  dedupeKey: string;
  typeKey: NotificationTypeKey;
  title: string;
  body: string;
  href: string;
  resourceKind: string;
  resourceId: string;
  worktreeId?: string | null;
  highlightColor?: string | null;
};

export type RegisterWebPushSubscriptionInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime?: number | null;
  locale?: string | null;
  userAgent?: string | null;
};

function cleanText(value: string, name: string, max: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} is too long`);
  return result;
}

function validInternalHref(value: string): string {
  const href = cleanText(value, "Notification link", 2_000);
  if (!href.startsWith("/") || href.startsWith("//")) {
    throw new Error("Notification links must be same-origin paths");
  }
  return href;
}

function validEndpoint(value: string): string {
  const endpoint = cleanText(value, "Push endpoint", 4_000);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Push endpoint must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Push endpoint must use HTTPS");
  }
  return endpoint;
}

function validDate(value: string, name: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} is invalid`);
  return date;
}

function vapidSubject(): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:") return url.origin;
    } catch {
      // The public-origin helper reports configuration errors in its owning UI.
    }
  }
  return "mailto:notifications@ai-development-environment.local";
}

function statusCode(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : null;
}

export class NotificationsService {
  private vapidPreparation: Promise<{ publicKey: string }> | null = null;

  constructor(
    private readonly credentialService: CredentialService,
    private readonly apns: ApnsClient = new ApnsClient(),
  ) {}

  private publish(change: NotificationChange): void {
    agentEventBus.publish(APP_NOTIFICATIONS_CHANGED_TOPIC, {
      notificationsChanged: change,
    });
  }

  subscribe() {
    return agentEventBus.iterate<{ notificationsChanged: NotificationChange }>(
      APP_NOTIFICATIONS_CHANGED_TOPIC,
    );
  }

  async preferences() {
    const prisma = await getPrismaClient();
    const saved = await prisma.notificationPreference.findMany();
    const byKey = new Map(saved.map((entry) => [entry.typeKey, entry]));
    return notificationTypeDefinitions().map((definition) => {
      const preference = byKey.get(definition.key);
      return {
        ...definition,
        sidebarEnabled:
          preference?.sidebarEnabled ?? definition.defaultSidebarEnabled,
        browserEnabled:
          preference?.browserEnabled ?? definition.defaultBrowserEnabled,
        webPushEnabled:
          preference?.webPushEnabled ?? definition.defaultWebPushEnabled,
        apnsEnabled: preference?.apnsEnabled ?? definition.defaultApnsEnabled,
        updatedAt: preference?.updatedAt ?? null,
      };
    });
  }

  async savePreference(input: {
    typeKey: string;
    sidebarEnabled: boolean;
    browserEnabled: boolean;
    webPushEnabled: boolean;
    apnsEnabled?: boolean | null;
  }) {
    const definition = notificationType(input.typeKey);
    if (!definition) throw new Error("Unknown notification type");
    const prisma = await getPrismaClient();
    // Clients written before the APNs channel existed omit the field entirely, and every save
    // sends the whole preference. Leave the stored choice alone rather than resetting it to a
    // default, so an old client editing the browser switch cannot silently re-enable APNs.
    const existing = await prisma.notificationPreference.findUnique({
      where: { typeKey: definition.key },
    });
    const apnsEnabled =
      input.apnsEnabled ?? existing?.apnsEnabled ?? definition.defaultApnsEnabled;
    const saved = await prisma.notificationPreference.upsert({
      where: { typeKey: definition.key },
      create: {
        typeKey: definition.key,
        sidebarEnabled: input.sidebarEnabled,
        browserEnabled: input.browserEnabled,
        webPushEnabled: input.webPushEnabled,
        apnsEnabled,
      },
      update: {
        sidebarEnabled: input.sidebarEnabled,
        browserEnabled: input.browserEnabled,
        webPushEnabled: input.webPushEnabled,
        apnsEnabled,
      },
    });
    this.publish({
      kind: "PREFERENCES_UPDATED",
      notification: null,
      notificationId: null,
    });
    return { ...definition, ...saved };
  }

  async recordInTransaction(
    transaction: Prisma.TransactionClient,
    input: RecordNotificationInput,
  ): Promise<NotificationRecord | null> {
    const definition = notificationType(input.typeKey);
    if (!definition) throw new Error("Unknown notification type");
    const preference = await transaction.notificationPreference.findUnique({
      where: { typeKey: definition.key },
    });
    const sidebarRequested =
      preference?.sidebarEnabled ?? definition.defaultSidebarEnabled;
    const browserRequested =
      preference?.browserEnabled ?? definition.defaultBrowserEnabled;
    const webPushRequested =
      preference?.webPushEnabled ?? definition.defaultWebPushEnabled;
    const apnsRequested =
      preference?.apnsEnabled ?? definition.defaultApnsEnabled;
    if (
      !sidebarRequested &&
      !browserRequested &&
      !webPushRequested &&
      !apnsRequested
    ) {
      return null;
    }

    const dedupeKey = cleanText(input.dedupeKey, "Deduplication key", 500);
    const existing = await transaction.appNotification.findUnique({
      where: { dedupeKey },
    });
    if (existing) return null;
    return transaction.appNotification.create({
      data: {
        id: randomUUID(),
        dedupeKey,
        typeKey: definition.key,
        title: cleanText(input.title, "Notification title", 240),
        body: cleanText(input.body, "Notification body", 1_000),
        href: validInternalHref(input.href),
        resourceKind: cleanText(input.resourceKind, "Resource kind", 100),
        resourceId: cleanText(input.resourceId, "Resource ID", 500),
        worktreeId: input.worktreeId ?? null,
        highlightColor: input.highlightColor?.trim() || null,
        sidebarRequested,
        browserRequested,
        webPushRequested,
        apnsRequested,
      },
    });
  }

  created(notification: NotificationRecord | null): void {
    if (!notification) return;
    this.publish({
      kind: "CREATED",
      notification,
      notificationId: notification.id,
    });
    if (notification.webPushRequested) {
      void this.deliverWebPush(notification).catch((error: unknown) => {
        console.error("Web Push delivery failed:", error);
      });
    }
    if (notification.apnsRequested) {
      void this.deliverApns(notification).catch((error: unknown) => {
        console.error("APNs delivery failed:", error);
      });
    }
  }

  async history(input: { first?: number | null; after?: string | null } = {}) {
    const first = Math.max(1, Math.min(input.first ?? 100, MAX_PAGE_SIZE));
    const prisma = await getPrismaClient();
    const [rows, totalCount] = await Promise.all([
      prisma.appNotification.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: first + 1,
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : undefined),
      }),
      prisma.appNotification.count(),
    ]);
    return {
      items: rows.slice(0, first),
      nextCursor: rows.length > first ? rows[first - 1]!.id : null,
      totalCount,
    };
  }

  async sidebar(limit = DEFAULT_SIDEBAR_LIMIT) {
    const prisma = await getPrismaClient();
    return prisma.appNotification.findMany({
      where: { sidebarRequested: true, sidebarDismissedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.max(1, Math.min(limit, 100)),
    });
  }

  async dismiss(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const result = await prisma.appNotification.updateMany({
      where: { id, sidebarRequested: true, sidebarDismissedAt: null },
      data: { sidebarDismissedAt: new Date() },
    });
    if (result.count) {
      this.publish({
        kind: "DISMISSED",
        notification: null,
        notificationId: id,
      });
    }
    return result.count > 0;
  }

  async dismissAll(): Promise<number> {
    const prisma = await getPrismaClient();
    const result = await prisma.appNotification.updateMany({
      where: { sidebarRequested: true, sidebarDismissedAt: null },
      data: { sidebarDismissedAt: new Date() },
    });
    if (result.count) {
      this.publish({
        kind: "SIDEBAR_CLEARED",
        notification: null,
        notificationId: null,
      });
    }
    return result.count;
  }

  private selectionWhere(
    selection: NotificationSelection,
  ): Prisma.AppNotificationWhereInput {
    const excludedRanges = selection.excludedRanges ?? [];
    const ids =
      selection.all && excludedRanges.length === 0
        ? []
        : [...new Set(selection.ids ?? [])];
    const excludedIds = [...new Set(selection.excludedIds ?? [])];
    const ranges = selection.ranges ?? [];
    if (
      ids.length > MAX_SELECTION_IDS ||
      excludedIds.length > MAX_SELECTION_IDS
    ) {
      throw new Error("Notification selection is too large");
    }
    if (
      ranges.length > MAX_SELECTION_RANGES ||
      excludedRanges.length > MAX_SELECTION_RANGES
    ) {
      throw new Error("Notification date selection is too large");
    }
    const excludedRangeChoices = excludedRanges.map((range) => {
      const start = validDate(range.start, "Excluded selection start");
      const end = validDate(range.end, "Excluded selection end");
      if (start >= end) throw new Error("Excluded selection range is invalid");
      return { createdAt: { gte: start, lt: end } };
    });
    const rangeExclusion: Prisma.AppNotificationWhereInput = {
      NOT: { OR: excludedRangeChoices },
    };
    const choices: Prisma.AppNotificationWhereInput[] = [];
    if (ids.length) choices.push({ id: { in: ids } });
    if (selection.all) {
      choices.push(excludedRangeChoices.length ? rangeExclusion : {});
    } else if (ranges.length) {
      const rangeChoices = ranges.map((range) => {
        const start = validDate(range.start, "Selection start");
        const end = validDate(range.end, "Selection end");
        if (start >= end) throw new Error("Selection range is invalid");
        return { createdAt: { gte: start, lt: end } };
      });
      choices.push({
        AND: [
          { OR: rangeChoices },
          ...(excludedRangeChoices.length ? [rangeExclusion] : []),
        ],
      });
    }
    if (!choices.length) return { id: { in: [] } };
    const inclusion = choices.length === 1 ? choices[0] : { OR: choices };
    return excludedIds.length
      ? { AND: [inclusion, { id: { notIn: excludedIds } }] }
      : inclusion;
  }

  async deleteSelection(selection: NotificationSelection): Promise<number> {
    const prisma = await getPrismaClient();
    const result = await prisma.appNotification.deleteMany({
      where: this.selectionWhere(selection),
    });
    if (result.count) {
      this.publish({
        kind: "DELETED",
        notification: null,
        notificationId: null,
      });
    }
    return result.count;
  }

  async deleteAll(): Promise<number> {
    const prisma = await getPrismaClient();
    const result = await prisma.appNotification.deleteMany();
    if (result.count) {
      this.publish({
        kind: "HISTORY_CLEARED",
        notification: null,
        notificationId: null,
      });
    }
    return result.count;
  }

  async webPushState() {
    const prisma = await getPrismaClient();
    const [settings, subscriptionCount] = await Promise.all([
      prisma.webPushSettings.findUnique({ where: { id: VAPID_SETTINGS_ID } }),
      prisma.webPushSubscription.count(),
    ]);
    const privateKeyConfigured = await this.credentialService.isConfigured(
      CREDENTIALS.webPushVapidPrivateKey,
    );
    return {
      configured: Boolean(settings?.vapidPublicKey && privateKeyConfigured),
      publicKey: settings?.vapidPublicKey ?? null,
      subscriptionCount,
    };
  }

  async webPushSubscriptions() {
    const prisma = await getPrismaClient();
    return prisma.webPushSubscription.findMany({
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        endpoint: true,
        expirationTime: true,
        locale: true,
        userAgent: true,
        lastSeenAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async prepareWebPush(): Promise<{ publicKey: string }> {
    if (!this.vapidPreparation) {
      this.vapidPreparation = this.prepareWebPushOnce().finally(() => {
        this.vapidPreparation = null;
      });
    }
    return this.vapidPreparation;
  }

  private async prepareWebPushOnce(): Promise<{ publicKey: string }> {
    const prisma = await getPrismaClient();
    const settings = await prisma.webPushSettings.findUnique({
      where: { id: VAPID_SETTINGS_ID },
    });
    if (settings?.vapidPublicKey) {
      const privateKey = await this.credentialService.getText(
        CREDENTIALS.webPushVapidPrivateKey,
      );
      if (!privateKey) {
        throw new Error("The Web Push private key is unavailable");
      }
      return { publicKey: settings.vapidPublicKey };
    }
    const keys = webpush.generateVAPIDKeys();
    await this.credentialService.setText(
      CREDENTIALS.webPushVapidPrivateKey,
      keys.privateKey,
      (transaction) =>
        transaction.webPushSettings
          .upsert({
            where: { id: VAPID_SETTINGS_ID },
            create: {
              id: VAPID_SETTINGS_ID,
              vapidPublicKey: keys.publicKey,
              vapidGeneratedAt: new Date(),
            },
            update: {
              vapidPublicKey: keys.publicKey,
              vapidGeneratedAt: new Date(),
            },
          })
          .then(() => undefined),
    );
    return { publicKey: keys.publicKey };
  }

  async registerWebPush(input: RegisterWebPushSubscriptionInput) {
    const endpoint = validEndpoint(input.endpoint);
    const p256dh = cleanText(input.p256dh, "Push p256dh key", 1_000);
    const auth = cleanText(input.auth, "Push auth key", 1_000);
    const expirationTime =
      input.expirationTime === null || input.expirationTime === undefined
        ? null
        : new Date(input.expirationTime);
    if (expirationTime && !Number.isFinite(expirationTime.getTime())) {
      throw new Error("Push subscription expiration is invalid");
    }
    await this.prepareWebPush();
    const prisma = await getPrismaClient();
    return prisma.webPushSubscription.upsert({
      where: { endpoint },
      create: {
        id: randomUUID(),
        endpoint,
        p256dh,
        auth,
        expirationTime,
        locale: input.locale?.trim().slice(0, 35) || null,
        userAgent: input.userAgent?.trim().slice(0, 1_000) || null,
      },
      update: {
        p256dh,
        auth,
        expirationTime,
        locale: input.locale?.trim().slice(0, 35) || null,
        userAgent: input.userAgent?.trim().slice(0, 1_000) || null,
        lastSeenAt: new Date(),
      },
    });
  }

  async unregisterWebPush(endpointValue: string): Promise<boolean> {
    const endpoint = validEndpoint(endpointValue);
    const prisma = await getPrismaClient();
    const result = await prisma.webPushSubscription.deleteMany({
      where: { endpoint },
    });
    return result.count > 0;
  }

  async deleteWebPushSubscription(idValue: string): Promise<boolean> {
    const id = cleanText(idValue, "Push subscription", 200);
    const prisma = await getPrismaClient();
    const result = await prisma.webPushSubscription.deleteMany({
      where: { id },
    });
    return result.count > 0;
  }

  async testWebPushSubscription(idValue: string): Promise<boolean> {
    const id = cleanText(idValue, "Push subscription", 200);
    const prisma = await getPrismaClient();
    const [settings, subscription] = await Promise.all([
      prisma.webPushSettings.findUnique({ where: { id: VAPID_SETTINGS_ID } }),
      prisma.webPushSubscription.findUnique({ where: { id } }),
    ]);
    if (!subscription) throw new Error("Push subscription was not found");
    if (!settings?.vapidPublicKey) {
      throw new Error("Web Push is not configured");
    }
    const privateKey = await this.credentialService.getText(
      CREDENTIALS.webPushVapidPrivateKey,
    );
    if (!privateKey) throw new Error("The Web Push private key is unavailable");
    webpush.setVapidDetails(
      vapidSubject(),
      settings.vapidPublicKey,
      privateKey,
    );
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime?.getTime() ?? null,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify({
          id: `test:${Date.now()}`,
          title: "Test notification",
          body: "Web Push is working for this browser.",
          href: "/notifications",
          icon: "/icon-192.png",
          badge: "/icon-192.png",
        }),
        { TTL: 60, timeout: 10_000 },
      );
      return true;
    } catch (error) {
      if ([404, 410].includes(statusCode(error) ?? 0)) {
        await prisma.webPushSubscription.deleteMany({ where: { id } });
        throw new Error("The browser subscription expired and was removed");
      }
      throw error;
    }
  }

  async apnsState() {
    const prisma = await getPrismaClient();
    const [settings, deviceCount] = await Promise.all([
      readConnectionSettings(
        this.credentialService,
        CREDENTIALS.apnsTokenSettings,
        apnsTokenConnectionSettings,
      ),
      prisma.notificationDevice.count({ where: { status: "ACTIVE" } }),
    ]);
    const privateKeyConfigured = await this.credentialService.isConfigured(
      CREDENTIALS.apnsTokenPrivateKey,
    );
    return {
      configured: Boolean(settings && privateKeyConfigured),
      deviceCount,
    };
  }

  async notificationDevices() {
    const prisma = await getPrismaClient();
    const rows = await prisma.notificationDevice.findMany({
      orderBy: [{ status: "asc" }, { lastRegisteredAt: "desc" }],
    });
    return rows.map(({ token, tokenHash: _tokenHash, ...row }) => ({
      ...row,
      // The full token is a credential for pushing to that device; the list only needs enough
      // to tell two phones apart.
      tokenMasked: `${token.slice(0, 8)}…${token.slice(-8)}`,
    }));
  }

  async registerDevice(value: unknown, ipAddress: string | null) {
    const input = parseNotificationDeviceInput(value);
    return this.registerDeviceValidated(input, ipAddress);
  }

  private async registerDeviceValidated(
    input: NotificationDeviceInput,
    ipAddress: string | null,
  ) {
    const prisma = await getPrismaClient();
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const now = new Date();
    const data = {
      token: input.token,
      tokenHash,
      topic: input.topic,
      environment: input.environment,
      displayName: input.displayName,
      deviceModel: input.deviceModel,
      osVersion: input.osVersion,
      appVersion: input.appVersion,
      appBuild: input.appBuild,
      locale: input.locale,
      lastIpAddress: ipAddress,
      status: "ACTIVE",
      lastFailureReason: null,
      lastFailureAt: null,
      lastRegisteredAt: now,
    };
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.notificationDevice.findUnique({
        where: { clientRegistrationId: input.clientRegistrationId },
      });
      // APNs recycles a device token when an app is reinstalled or restored onto another phone.
      // Whichever registration last claimed the token owns it, so drop the stale holder rather
      // than letting the unique index reject the fresh registration.
      const tokenOwner = await tx.notificationDevice.findUnique({
        where: { tokenHash },
      });
      if (tokenOwner && tokenOwner.id !== existing?.id) {
        await tx.notificationDevice.delete({ where: { id: tokenOwner.id } });
      }
      const device = existing
        ? await tx.notificationDevice.update({
            where: { id: existing.id },
            data,
          })
        : await tx.notificationDevice.create({
            data: {
              id: randomUUID(),
              clientRegistrationId: input.clientRegistrationId,
              ...data,
            },
          });
      return { device, created: !existing };
    });
    this.publish({
      kind: "DEVICES_CHANGED",
      notification: null,
      notificationId: null,
    });
    return result;
  }

  async deleteNotificationDevice(idValue: string): Promise<boolean> {
    const id = cleanText(idValue, "Notification device", 200);
    const prisma = await getPrismaClient();
    const result = await prisma.notificationDevice.deleteMany({
      where: { id },
    });
    if (result.count) {
      this.publish({
        kind: "DEVICES_CHANGED",
        notification: null,
        notificationId: null,
      });
    }
    return result.count > 0;
  }

  async renameNotificationDevice(idValue: string, displayNameValue: string) {
    const id = cleanText(idValue, "Notification device", 200);
    const displayName = cleanText(displayNameValue, "Display name", 120);
    const prisma = await getPrismaClient();
    const device = await prisma.notificationDevice.update({
      where: { id },
      data: { displayName },
    });
    this.publish({
      kind: "DEVICES_CHANGED",
      notification: null,
      notificationId: null,
    });
    return device;
  }

  private async apnsAuthentication(): Promise<
    Extract<ApnsAuthentication, { kind: "TOKEN" }>
  > {
    const settings = await readConnectionSettings(
      this.credentialService,
      CREDENTIALS.apnsTokenSettings,
      apnsTokenConnectionSettings,
    );
    const privateKey = await this.credentialService.getText(
      CREDENTIALS.apnsTokenPrivateKey,
    );
    if (!settings || !privateKey) {
      throw new Error(
        "APNs token authentication is not configured. Add the team ID, key ID, and .p8 key under Settings.",
      );
    }
    return {
      kind: "TOKEN",
      teamId: settings.value.teamId,
      keyId: settings.value.keyId,
      privateKey,
    };
  }

  private async sendApns(
    device: {
      id: string;
      token: string;
      topic: string;
      environment: string;
      displayName: string;
    },
    authentication: Extract<ApnsAuthentication, { kind: "TOKEN" }>,
    payload: {
      id: string;
      title: string;
      body: string;
      href: string;
      typeKey: string;
      collapseId?: string;
    },
  ): Promise<boolean> {
    const prisma = await getPrismaClient();
    const now = new Date();
    let response: Awaited<ReturnType<ApnsClient["send"]>>;
    try {
      response = await this.apns.send({
        environment: device.environment as ApnsEnvironment,
        authentication,
        deviceToken: device.token,
        payload: {
          aps: {
            alert: { title: payload.title, body: payload.body },
            sound: "default",
            "thread-id": payload.typeKey,
            "interruption-level": "active",
          },
          notificationId: payload.id,
          typeKey: payload.typeKey,
          href: payload.href,
        },
        headers: {
          "apns-topic": device.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(
            Math.floor(now.getTime() / 1_000) + APNS_ALERT_TTL_SECONDS,
          ),
          ...(payload.collapseId
            ? { "apns-collapse-id": payload.collapseId.slice(0, 64) }
            : {}),
        },
      });
    } catch (error) {
      await prisma.notificationDevice.updateMany({
        where: { id: device.id },
        data: {
          lastFailureReason:
            error instanceof Error ? error.message.slice(0, 200) : "SendFailed",
          lastFailureAt: now,
        },
      });
      throw error;
    }

    if (response.status === 200) {
      await prisma.notificationDevice.updateMany({
        where: { id: device.id },
        data: {
          lastDeliveredAt: now,
          lastFailureReason: null,
          lastFailureAt: null,
        },
      });
      return true;
    }

    const reason = response.reason ?? `HTTP ${response.status}`;
    const dead = response.status === 410 || APNS_DEAD_TOKEN_REASONS.has(reason);
    await prisma.notificationDevice.updateMany({
      where: { id: device.id },
      data: {
        lastFailureReason: reason,
        lastFailureAt: now,
        ...(dead ? { status: "INACTIVE" } : {}),
      },
    });
    if (dead) {
      this.publish({
        kind: "DEVICES_CHANGED",
        notification: null,
        notificationId: null,
      });
    }
    return false;
  }

  async testNotificationDevice(idValue: string): Promise<boolean> {
    const id = cleanText(idValue, "Notification device", 200);
    const prisma = await getPrismaClient();
    const device = await prisma.notificationDevice.findUnique({
      where: { id },
    });
    if (!device) throw new Error("Notification device was not found");
    const authentication = await this.apnsAuthentication();
    const delivered = await this.sendApns(device, authentication, {
      id: `test:${Date.now()}`,
      title: "Test notification",
      body: "Native notifications are working on this device.",
      href: "/notifications",
      typeKey: "TEST",
    });
    if (!delivered) {
      const refreshed = await prisma.notificationDevice.findUnique({
        where: { id },
      });
      throw new Error(
        refreshed?.lastFailureReason
          ? `APNs rejected the notification: ${refreshed.lastFailureReason}`
          : "APNs rejected the notification",
      );
    }
    return true;
  }

  async deliverApns(notification: NotificationRecord): Promise<void> {
    if (!notification.apnsRequested) return;
    const prisma = await getPrismaClient();
    const devices = await prisma.notificationDevice.findMany({
      where: { status: "ACTIVE" },
    });
    if (!devices.length) return;
    // A missing provider key is a configuration state, not a per-notification failure. Report it
    // once and move on rather than throwing for every notification the server raises.
    let authentication: Extract<ApnsAuthentication, { kind: "TOKEN" }>;
    try {
      authentication = await this.apnsAuthentication();
    } catch (error) {
      console.error("APNs delivery skipped:", error);
      return;
    }
    await Promise.allSettled(
      devices.map(async (device) => {
        try {
          await this.sendApns(device, authentication, {
            id: notification.id,
            title: notification.title,
            body: notification.body,
            href: notification.href,
            typeKey: notification.typeKey,
            collapseId: notification.dedupeKey,
          });
        } catch (error) {
          console.error(
            `APNs delivery to ${device.displayName} failed:`,
            error,
          );
        }
      }),
    );
  }

  async deliverWebPush(notification: NotificationRecord): Promise<void> {
    if (!notification.webPushRequested) return;
    const prisma = await getPrismaClient();
    const [settings, subscriptions] = await Promise.all([
      prisma.webPushSettings.findUnique({ where: { id: VAPID_SETTINGS_ID } }),
      prisma.webPushSubscription.findMany(),
    ]);
    if (!settings?.vapidPublicKey || !subscriptions.length) return;
    const privateKey = await this.credentialService.getText(
      CREDENTIALS.webPushVapidPrivateKey,
    );
    if (!privateKey) return;
    webpush.setVapidDetails(
      vapidSubject(),
      settings.vapidPublicKey,
      privateKey,
    );
    const payload = JSON.stringify({
      id: notification.id,
      title: notification.title,
      body: notification.body,
      href: notification.href,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    });
    await Promise.allSettled(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              expirationTime: subscription.expirationTime?.getTime() ?? null,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            payload,
            { TTL: 60 * 60, timeout: 10_000 },
          );
        } catch (error) {
          if ([404, 410].includes(statusCode(error) ?? 0)) {
            await prisma.webPushSubscription.deleteMany({
              where: { endpoint: subscription.endpoint },
            });
            return;
          }
          console.error(
            `Web Push delivery to ${subscription.endpoint} failed:`,
            error,
          );
        }
      }),
    );
  }
}
