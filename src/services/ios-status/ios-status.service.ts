import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { getPrismaClient } from "@/data/prisma-client";
import type { IosStatusSubscription } from "@/generated/prisma/client";
import {
  ACTION_CENTER_CHANGED_TOPIC,
  SIDEBAR_STATUS_CHANGED_TOPIC,
  agentEventBus,
} from "@/services/agent-control";
import type { ActionCenterService } from "@/services/action-center";
import type { UserPrincipal } from "@/services/auth/principal";
import {
  CREDENTIALS,
  apnsTokenConnectionSettings,
  readConnectionSettings,
  type CredentialService,
} from "@/services/credentials";
import { ApnsClient } from "@/services/push-notifications/apns-client";
import type { SystemStatusService } from "@/services/system-status";
import {
  parseStatusRegistration,
  registrationId,
  registrationObject,
} from "./registration";

const WIDGET_TTL_MS = 30 * 24 * 60 * 60_000;
const ACTIVITY_TTL_MS = 8 * 60 * 60_000;
const WIDGET_INTERVAL_MS = 5 * 60_000;
const ACTIVITY_INTERVAL_MS = 15_000;
const DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export type WorkActivityContent = {
  activeCount: number;
  needsAttentionCount: number;
  summary: string;
  updatedAt: number;
};

export function workActivityContent(
  counts: {
    plans: number;
    sessions: number;
    builds: number;
    workflows: number;
    commands: number;
    actions: number | null;
    pipelines: number | null;
  },
  needsAttentionCount: number,
  now = new Date(),
): WorkActivityContent {
  const kinds = [
    [counts.plans, "plan"],
    [counts.sessions, "session"],
    [counts.builds, "build"],
    [counts.workflows, "workflow"],
    [counts.commands, "command"],
    [counts.actions ?? 0, "action"],
    [counts.pipelines ?? 0, "pipeline"],
  ] as const;
  return {
    activeCount: kinds.reduce((sum, [count]) => sum + count, 0),
    needsAttentionCount,
    summary:
      kinds
        .filter(([count]) => count > 0)
        .map(([count, name]) => `${count} ${name}${count === 1 ? "" : "s"}`)
        .join(" · ") || "Work finished",
    updatedAt: Math.floor(now.getTime() / 1_000),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The native app's read-only status surfaces. Separate from the APNs test console. */
export class IosStatusService {
  private readonly streams = new Set<AsyncIterableIterator<unknown>>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceDue = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private dirty = false;

  constructor(
    private readonly systemStatus: Pick<SystemStatusService, "status">,
    private readonly actionCenter: Pick<ActionCenterService, "list">,
    private readonly credentials: CredentialService,
    private readonly apns = new ApnsClient(),
  ) {}

  async snapshot() {
    const [sidebar, actions] = await Promise.all([
      this.systemStatus.status(false),
      this.actionCenter.list({ first: 8 }),
    ]);
    const now = new Date();
    return {
      collectedAt: now.toISOString(),
      usageToday: sidebar.usageToday,
      activity: sidebar.activity,
      actionCenter: {
        needsAttentionCount: actions.needsAttentionCount,
        activeCount: actions.activeCount,
        items: actions.items.map((item) => ({
          key: item.key,
          resourceKind: item.resourceKind,
          resourceId: item.resourceId,
          label: item.label,
          summary: item.summary,
          status: item.status,
          reason: item.reason,
          updatedAt: item.updatedAt,
          href: item.href,
        })),
      },
      liveActivity: workActivityContent(
        sidebar.activity,
        actions.needsAttentionCount,
        now,
      ),
    };
  }

  async register(principal: UserPrincipal, value: unknown) {
    const input = parseStatusRegistration(value);
    const prisma = await getPrismaClient();
    const key = {
      userId: principal.userId,
      clientRegistrationId: input.clientRegistrationId,
    };
    const existing = await prisma.iosStatusSubscription.findUnique({
      where: { userId_clientRegistrationId: key },
    });
    if (existing && existing.kind !== input.kind) {
      throw new Error("An existing registration cannot change kind");
    }
    if (
      !existing &&
      (await prisma.iosStatusSubscription.count({
        where: { userId: principal.userId },
      })) >= 64
    ) {
      throw new Error(
        "Too many status subscriptions; remove an existing subscription first",
      );
    }
    const now = new Date();
    const data = {
      ...input,
      sessionId: principal.sessionId,
      status: "ACTIVE",
      lastRegisteredAt: now,
      // ActivityKit's eight-hour lifetime begins at creation, not on token rotation.
      expiresAt:
        input.kind === "LIVE_ACTIVITY" && existing
          ? existing.expiresAt
          : new Date(
              now.getTime() +
                (input.kind === "WIDGET" ? WIDGET_TTL_MS : ACTIVITY_TTL_MS),
            ),
      ...(existing?.token === input.token
        ? {}
        : { lastPayloadHash: null, lastAttemptAt: null }),
      lastFailureReason: null,
    };
    const result = await prisma.iosStatusSubscription.upsert({
      where: { userId_clientRegistrationId: key },
      create: { id: randomUUID(), userId: principal.userId, ...data },
      update: data,
    });
    this.schedule();
    return {
      id: result.id,
      status: result.status,
      lastRegisteredAt: result.lastRegisteredAt.toISOString(),
    };
  }

  async unregister(principal: UserPrincipal, value: unknown) {
    const input = registrationObject(value);
    if (Object.keys(input).some((key) => key !== "clientRegistrationId")) {
      throw new Error("Deletion accepts only clientRegistrationId");
    }
    const prisma = await getPrismaClient();
    const result = await prisma.iosStatusSubscription.deleteMany({
      where: {
        userId: principal.userId,
        clientRegistrationId: registrationId(input.clientRegistrationId),
      },
    });
    return { deleted: result.count > 0 };
  }

  startRuntime(): void {
    if (this.reconcileTimer) return;
    for (const topic of [
      SIDEBAR_STATUS_CHANGED_TOPIC,
      ACTION_CENTER_CHANGED_TOPIC,
    ]) {
      const stream = agentEventBus.iterate(topic);
      this.streams.add(stream);
      void (async () => {
        for await (const _change of stream) this.schedule();
      })().catch((error) =>
        console.error("iOS status subscription failed:", error),
      );
    }
    // Reconcile durable registrations after restart and catch time-based usage changes.
    this.reconcileTimer = setInterval(() => this.schedule(), 60_000);
    this.reconcileTimer.unref();
    this.schedule();
  }

  stopRuntime(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.debounceTimer = undefined;
    this.debounceDue = 0;
    this.reconcileTimer = undefined;
    for (const stream of this.streams) void stream.return?.();
    this.streams.clear();
    this.apns.close();
  }

  private schedule(delay = 2_000, markDirty = true): void {
    if (markDirty) this.dirty = true;
    const due = Date.now() + delay;
    if (this.debounceTimer && this.debounceDue <= due) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceDue = due;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.debounceDue = 0;
      void this.flush().catch((error) =>
        console.error("iOS status push failed:", error),
      );
    }, delay);
    this.debounceTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.flushing) {
      this.dirty = true;
      return;
    }
    this.flushing = true;
    this.dirty = false;
    try {
      const prisma = await getPrismaClient();
      const now = new Date();
      await prisma.iosStatusSubscription.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      const registrations = await prisma.iosStatusSubscription.findMany({
        where: {
          status: "ACTIVE",
          expiresAt: { gt: now },
          session: { expiresAt: { gt: now } },
          user: { OR: [{ banned: false }, { banned: null }] },
        },
      });
      if (!registrations.length) return;
      const settings = await readConnectionSettings(
        this.credentials,
        CREDENTIALS.apnsTokenSettings,
        apnsTokenConnectionSettings,
      );
      const privateKey = await this.credentials.getText(
        CREDENTIALS.apnsTokenPrivateKey,
      );
      // Widgets keep using their timelines when APNs hasn't been configured.
      if (!settings || !privateKey) return;
      const authentication = {
        kind: "TOKEN" as const,
        teamId: settings.value.teamId,
        keyId: settings.value.keyId,
        privateKey,
      };
      const snapshot = await this.snapshot();
      const { updatedAt: _updatedAt, ...work } = snapshot.liveActivity;
      const widgetHash = hash({
        usageToday: snapshot.usageToday,
        activity: snapshot.activity,
        actionCenter: snapshot.actionCenter,
      });
      const activityHash = hash(work);
      // Bound concurrent APNs work without serializing every recipient's network retries.
      for (let offset = 0; offset < registrations.length; offset += 10) {
        await Promise.all(
          registrations
            .slice(offset, offset + 10)
            .map((registration) =>
              this.deliver(
                registration,
                authentication,
                snapshot.liveActivity,
                registration.kind === "WIDGET" ? widgetHash : activityHash,
                now,
              ),
            ),
        );
      }
    } finally {
      this.flushing = false;
      if (this.dirty) this.schedule();
    }
  }

  private async deliver(
    registration: IosStatusSubscription,
    authentication: {
      kind: "TOKEN";
      teamId: string;
      keyId: string;
      privateKey: string;
    },
    content: WorkActivityContent,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    const widget = registration.kind === "WIDGET";
    // Refresh unchanged long-running work before ActivityKit's stale-date. Otherwise a
    // quiet build would appear stale despite the server continuing to monitor it.
    const heartbeatDue =
      !widget &&
      content.activeCount > 0 &&
      (!registration.lastDeliveredAt ||
        now.getTime() - registration.lastDeliveredAt.getTime() >= 4 * 60_000);
    if (registration.lastPayloadHash === payloadHash && !heartbeatDue) return;
    const interval = widget ? WIDGET_INTERVAL_MS : ACTIVITY_INTERVAL_MS;
    const wait = registration.lastAttemptAt
      ? interval - (now.getTime() - registration.lastAttemptAt.getTime())
      : 0;
    if (wait > 0) {
      // Keep a pending change even when no further domain events occur (e.g. work completed).
      this.schedule(wait, false);
      return;
    }
    const prisma = await getPrismaClient();
    const where = {
      id: registration.id,
      token: registration.token,
      status: "ACTIVE",
    };
    // Persist the attempt before sending so transient failures also respect the budget.
    const claimed = await prisma.iosStatusSubscription.updateMany({
      where: { ...where, lastAttemptAt: registration.lastAttemptAt },
      data: { lastAttemptAt: now },
    });
    if (!claimed.count) return;
    const ending = !widget && content.activeCount === 0;
    try {
      const result = await this.apns.send({
        environment: registration.environment as "SANDBOX" | "PRODUCTION",
        authentication,
        deviceToken: registration.token,
        headers: {
          "apns-push-type": widget ? "widgets" : "liveactivity",
          "apns-topic": `${registration.topic}.push-type.${widget ? "widgets" : "liveactivity"}`,
          "apns-priority": "5",
          "apns-expiration": String(
            Math.floor(now.getTime() / 1_000) + (widget ? 300 : 60),
          ),
          "apns-collapse-id": `aide-status-${registration.id}`,
        },
        payload: widget
          ? { aps: { "content-changed": true } }
          : {
              aps: {
                timestamp: Math.floor(now.getTime() / 1_000),
                event: ending ? "end" : "update",
                "content-state": content,
                ...(ending
                  ? {
                      "dismissal-date": Math.floor(now.getTime() / 1_000) + 300,
                    }
                  : { "stale-date": Math.floor(now.getTime() / 1_000) + 300 }),
              },
            },
      });
      const success = result.status === 200;
      await prisma.iosStatusSubscription.updateMany({
        where,
        data: {
          status:
            result.status === 410 || DEAD_TOKEN_REASONS.has(result.reason ?? "")
              ? "INVALID"
              : success && ending
                ? "ENDED"
                : "ACTIVE",
          lastFailureReason: success
            ? null
            : (result.reason ?? `APNs HTTP ${result.status}`),
          ...(success
            ? { lastPayloadHash: payloadHash, lastDeliveredAt: now }
            : {}),
        },
      });
    } catch (error) {
      await prisma.iosStatusSubscription.updateMany({
        where,
        data: {
          lastFailureReason: (error instanceof Error
            ? error.message
            : "APNs delivery failed"
          ).slice(0, 500),
        },
      });
    }
  }
}
