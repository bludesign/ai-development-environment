import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { getPrismaClient } from "@/data/prisma-client";
import {
  APP_NOTIFICATIONS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import { CREDENTIALS, type CredentialService } from "@/services/credentials";
import webpush from "web-push";

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
  | "PREFERENCES_UPDATED";

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

  constructor(private readonly credentialService: CredentialService) {}

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
        updatedAt: preference?.updatedAt ?? null,
      };
    });
  }

  async savePreference(input: {
    typeKey: string;
    sidebarEnabled: boolean;
    browserEnabled: boolean;
    webPushEnabled: boolean;
  }) {
    const definition = notificationType(input.typeKey);
    if (!definition) throw new Error("Unknown notification type");
    const prisma = await getPrismaClient();
    const saved = await prisma.notificationPreference.upsert({
      where: { typeKey: definition.key },
      create: {
        typeKey: definition.key,
        sidebarEnabled: input.sidebarEnabled,
        browserEnabled: input.browserEnabled,
        webPushEnabled: input.webPushEnabled,
      },
      update: {
        sidebarEnabled: input.sidebarEnabled,
        browserEnabled: input.browserEnabled,
        webPushEnabled: input.webPushEnabled,
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
    if (!sidebarRequested && !browserRequested && !webPushRequested)
      return null;

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
    const ids = [...new Set(selection.ids ?? [])];
    const excludedIds = [...new Set(selection.excludedIds ?? [])];
    const ranges = selection.ranges ?? [];
    const excludedRanges = selection.excludedRanges ?? [];
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
    const exclusions: Prisma.AppNotificationWhereInput[] = [];
    if (excludedIds.length) exclusions.push({ id: { notIn: excludedIds } });
    if (excludedRanges.length) {
      exclusions.push({
        NOT: {
          OR: excludedRanges.map((range) => {
            const start = validDate(range.start, "Excluded selection start");
            const end = validDate(range.end, "Excluded selection end");
            if (start >= end)
              throw new Error("Excluded selection range is invalid");
            return { createdAt: { gte: start, lt: end } };
          }),
        },
      });
    }
    if (selection.all) return exclusions.length ? { AND: exclusions } : {};
    const choices: Prisma.AppNotificationWhereInput[] = [];
    if (ids.length) choices.push({ id: { in: ids } });
    for (const range of ranges) {
      const start = validDate(range.start, "Selection start");
      const end = validDate(range.end, "Selection end");
      if (start >= end) throw new Error("Selection range is invalid");
      choices.push({ createdAt: { gte: start, lt: end } });
    }
    if (!choices.length) return { id: { in: [] } };
    return { AND: [{ OR: choices }, ...exclusions] };
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
