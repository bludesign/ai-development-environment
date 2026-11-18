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
import type { DiskSpaceService } from "@/services/disk-space";
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
import {
  DEFAULT_LIVE_ACTIVITY_SETTINGS,
  liveActivitySettings,
  type LiveActivityCategorySettings,
} from "./live-activity-settings";

const WIDGET_TTL_MS = 30 * 24 * 60 * 60_000;
const ACTIVITY_TTL_MS = 8 * 60 * 60_000;
const WIDGET_INTERVAL_MS = 5 * 60_000;
const ACTIVITY_INTERVAL_MS = 15_000;
const MAX_ACTIVE_SUBSCRIPTIONS = 64;
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
  integrationsKnown = true,
  settings: LiveActivityCategorySettings = DEFAULT_LIVE_ACTIVITY_SETTINGS,
): WorkActivityContent {
  const kinds = (
    [
      [counts.plans, "plan", settings.includePlans],
      [counts.sessions, "session", settings.includeSessions],
      [counts.builds, "build", settings.includeBuilds],
      [counts.workflows, "workflow", settings.includeWorkflows],
      [counts.commands, "command", settings.includeCommands],
      [counts.actions ?? 0, "action", settings.includeGitHubActions],
      [counts.pipelines ?? 0, "pipeline", settings.includeGitLabPipelines],
    ] as const
  ).filter(([, , enabled]) => enabled);
  return {
    activeCount: kinds.reduce((sum, [count]) => sum + count, 0),
    needsAttentionCount,
    summary:
      kinds
        .filter(([count]) => count > 0)
        .map(([count, name]) => `${count} ${name}${count === 1 ? "" : "s"}`)
        .join(" · ") ||
      (integrationsKnown ? "Work finished" : "Checking work status"),
    updatedAt: Math.floor(now.getTime() / 1_000),
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function eligibleSubscription(now: Date) {
  return {
    status: "ACTIVE",
    expiresAt: { gt: now },
    session: { expiresAt: { gt: now } },
    user: { OR: [{ banned: false }, { banned: null }] },
  };
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
    private readonly diskSpace?: Pick<DiskSpaceService, "summary">,
  ) {}

  async snapshot() {
    const settings = await liveActivitySettings();
    const [sidebar, actions, diskSummary] = await Promise.all([
      this.systemStatus.status(false, {
        includeUnfinishedWork: true,
        liveActivityIntegrations: {
          github: settings.includeGitHubActions,
          gitlab: settings.includeGitLabPipelines,
        },
      }),
      this.actionCenter.list({ first: 8 }),
      this.diskSpace?.summary() ?? Promise.resolve({ agents: [] }),
    ]);
    const now = new Date();
    const { unfinishedWork } = sidebar;
    const integrationsKnown =
      (!settings.includeGitHubActions ||
        (unfinishedWork?.githubKnown ??
          unfinishedWork?.integrationsKnown ??
          false)) &&
      (!settings.includeGitLabPipelines ||
        (unfinishedWork?.gitlabKnown ??
          unfinishedWork?.integrationsKnown ??
          false));
    return {
      collectedAt: now.toISOString(),
      usageToday: sidebar.usageToday,
      activity: sidebar.activity,
      diskSpace: diskSummary.agents
        .filter(({ enabled }) => enabled)
        .flatMap(({ agent, status, volumes }) => {
          // Match the sidebar: one ring per agent, using its least-free monitored volume.
          const volume = volumes
            .filter(({ monitored }) => monitored)
            .sort((first, second) => first.freeBytes - second.freeBytes)[0];
          return volume
            ? [
                {
                  id: agent.id,
                  agentName: agent.name,
                  volumeId: volume.id,
                  totalBytes: volume.totalBytes,
                  freeBytes: volume.freeBytes,
                  status,
                },
              ]
            : [];
        })
        .slice(0, 4),
      actionCenter: {
        totalCount: actions.totalCount,
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
        unfinishedWork ?? sidebar.activity,
        actions.needsAttentionCount,
        now,
        integrationsKnown,
        settings,
      ),
      liveActivityCountsKnown: integrationsKnown,
    };
  }

  async register(principal: UserPrincipal, value: unknown) {
    const input = parseStatusRegistration(value);
    const prisma = await getPrismaClient();
    const key = {
      userId: principal.userId,
      clientRegistrationId: input.clientRegistrationId,
    };
    const result = await prisma.$transaction(async (tx) => {
      const subscriptions = tx.iosStatusSubscription;
      const existing = await subscriptions.findUnique({
        where: { userId_clientRegistrationId: key },
        include: { session: { select: { expiresAt: true } } },
      });
      if (existing && existing.kind !== input.kind) {
        throw new Error("An existing registration cannot change kind");
      }
      const sameDestination =
        existing?.token === input.token &&
        existing.topic === input.topic &&
        existing.environment === input.environment;
      const now = new Date();
      // ActivityKit's eight-hour lifetime begins at creation, not on token rotation.
      const expiresAt =
        input.kind === "LIVE_ACTIVITY" && existing
          ? existing.expiresAt
          : new Date(
              now.getTime() +
                (input.kind === "WIDGET" ? WIDGET_TTL_MS : ACTIVITY_TTL_MS),
            );
      const alreadyActive =
        existing?.status === "ACTIVE" &&
        existing.expiresAt > now &&
        existing.session.expiresAt > now;
      const willBeActive =
        expiresAt > now && (!sameDestination || existing.status === "ACTIVE");
      if (
        willBeActive &&
        !alreadyActive &&
        (await subscriptions.count({
          where: { ...eligibleSubscription(now), userId: principal.userId },
        })) >= MAX_ACTIVE_SUBSCRIPTIONS
      ) {
        throw new Error(
          "Too many status subscriptions; remove an existing subscription first",
        );
      }
      const data = {
        ...input,
        sessionId: principal.sessionId,
        lastRegisteredAt: now,
        expiresAt,
      };
      return subscriptions.upsert({
        where: { userId_clientRegistrationId: key },
        create: { id: randomUUID(), userId: principal.userId, ...data },
        update: {
          ...data,
          // A routine repost of the cached token must preserve APNs's delivery result.
          ...(sameDestination
            ? {}
            : {
                status: "ACTIVE",
                lastPayloadHash: null,
                lastAttemptAt: null,
                lastDeliveredAt: null,
                lastFailureReason: null,
              }),
        },
      });
    });
    if (result.status === "ACTIVE") this.schedule();
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
        where: eligibleSubscription(now),
        include: { session: { select: { expiresAt: true } } },
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
        diskSpace: snapshot.diskSpace,
      });
      const activityHash = hash(work);
      // Wait for configured providers to report before treating an empty count as completion.
      const recipients =
        snapshot.liveActivity.activeCount > 0 ||
        snapshot.liveActivityCountsKnown
          ? registrations
          : registrations.filter(({ kind }) => kind === "WIDGET");
      // Bound concurrent APNs work without serializing every recipient's network retries.
      for (let offset = 0; offset < recipients.length; offset += 10) {
        await Promise.all(
          recipients
            .slice(offset, offset + 10)
            .map((registration) =>
              this.deliver(
                registration,
                authentication,
                snapshot.liveActivity,
                registration.kind === "WIDGET" ? widgetHash : activityHash,
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
    registration: IosStatusSubscription & { session: { expiresAt: Date } },
    authentication: {
      kind: "TOKEN";
      teamId: string;
      keyId: string;
      privateKey: string;
    },
    content: WorkActivityContent,
    payloadHash: string,
  ): Promise<void> {
    const now = new Date();
    const sentAt = Math.floor(now.getTime() / 1_000);
    const expiresAt = Math.floor(
      Math.min(
        registration.expiresAt.getTime(),
        registration.session.expiresAt.getTime(),
      ) / 1_000,
    );
    if (expiresAt <= sentAt) return;
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
      topic: registration.topic,
      environment: registration.environment,
      status: "ACTIVE",
    };
    // Persist the attempt before sending so transient failures also respect the budget.
    const claimed = await prisma.iosStatusSubscription.updateMany({
      where: {
        ...where,
        ...eligibleSubscription(now),
        sessionId: registration.sessionId,
        lastAttemptAt: registration.lastAttemptAt,
      },
      data: { lastAttemptAt: now },
    });
    if (!claimed.count) return;
    const attempt = { ...where, lastAttemptAt: now };
    const ending = !widget && content.activeCount === 0;
    const expiration = ending
      ? expiresAt
      : Math.min(expiresAt, sentAt + (widget ? 300 : 60));
    try {
      const result = await this.apns.send({
        environment: registration.environment as "SANDBOX" | "PRODUCTION",
        authentication,
        deviceToken: registration.token,
        headers: {
          "apns-push-type": widget ? "widgets" : "liveactivity",
          "apns-topic": `${registration.topic}.push-type.${widget ? "widgets" : "liveactivity"}`,
          "apns-priority": "5",
          "apns-expiration": String(expiration),
          "apns-collapse-id": `aide-status-${registration.id}`,
        },
        payload: widget
          ? { aps: { "content-changed": true } }
          : {
              aps: {
                timestamp: content.updatedAt,
                event: ending ? "end" : "update",
                "content-state": content,
                ...(ending
                  ? { "dismissal-date": sentAt + 300 }
                  : { "stale-date": sentAt + 300 }),
              },
            },
      });
      const success = result.status === 200;
      await prisma.iosStatusSubscription.updateMany({
        where: attempt,
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
        where: attempt,
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
