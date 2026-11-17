import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CredentialService } from "@/services/credentials";
import type { IosStatusSubscription } from "@/generated/prisma/client";
import type { SystemStatusService } from "@/services/system-status";
import type { ActionCenterService } from "@/services/action-center";
import type { ApnsClient } from "@/services/push-notifications/apns-client";

const getPrismaClient = vi.hoisted(() => vi.fn());
vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import {
  agentEventBus,
  SIDEBAR_STATUS_CHANGED_TOPIC,
} from "@/services/agent-control";
import { IosStatusService } from "./ios-status.service";
import { parseStatusRegistration } from "./registration";
import {
  DEFAULT_LIVE_ACTIVITY_SETTINGS,
  saveLiveActivitySettings,
  type LiveActivityCategorySettings,
} from "./live-activity-settings";

const principal = {
  kind: "user" as const,
  userId: "user-1",
  sessionId: "session-1",
  email: "test@example.com",
};
const input = {
  clientRegistrationId: "installation-1",
  kind: "WIDGET",
  token: "AB".repeat(32),
  topic: "com.bludesign.aidevelopmentenvironment",
  environment: "SANDBOX",
};

type Registration = IosStatusSubscription & {
  session: { expiresAt: Date };
  user: { banned: boolean | null };
};

function registration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: "registration-1",
    userId: principal.userId,
    sessionId: principal.sessionId,
    ...input,
    status: "ACTIVE",
    lastPayloadHash: null,
    lastAttemptAt: null,
    lastDeliveredAt: null,
    lastFailureReason: null,
    lastRegisteredAt: new Date(),
    expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    session: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
    user: { banned: false },
    ...overrides,
  };
}

type SubscriptionFilter = Record<string, unknown> & {
  expiresAt?: { gt: Date };
  session?: { expiresAt: { gt: Date } };
  user?: unknown;
};

type RegistrationKey = Pick<
  IosStatusSubscription,
  "userId" | "clientRegistrationId"
>;
type UniqueRegistrationFilter = {
  userId_clientRegistrationId: RegistrationKey;
};

function matchesSubscription(row: Registration, where: SubscriptionFilter) {
  const { expiresAt, session, user, ...fields } = where;
  return (
    (!expiresAt || row.expiresAt > expiresAt.gt) &&
    (!session || row.session.expiresAt > session.expiresAt.gt) &&
    (!user || !row.user.banned) &&
    Object.entries(fields).every(([key, value]) => {
      const actual = row[key as keyof Registration];
      return actual instanceof Date && value instanceof Date
        ? actual.getTime() === value.getTime()
        : actual === value;
    })
  );
}

const services: IosStatusService[] = [];

function harness(records: Registration[] = [registration()]) {
  const counts: Awaited<ReturnType<SystemStatusService["status"]>>["activity"] =
    {
      plans: 0,
      sessions: 1,
      builds: 0,
      workflows: 0,
      commands: 0,
      actions: null,
      pipelines: null,
      pullRequests: 2,
      mergeRequests: null,
      dirtyWorktrees: null,
      offMainWorktrees: null,
    };
  const work = {
    queuedWorkflows: 0,
    integrationsKnown: true,
    githubKnown: undefined as boolean | undefined,
    gitlabKnown: undefined as boolean | undefined,
  };
  const settings: LiveActivityCategorySettings = {
    ...DEFAULT_LIVE_ACTIVITY_SETTINGS,
  };
  const status = vi.fn(async () => ({
    usageToday: { totalCost: 12.5, collectedAt: "2026-11-17T12:00:00Z" },
    activity: { ...counts },
    unfinishedWork: {
      ...counts,
      workflows: counts.workflows + work.queuedWorkflows,
      integrationsKnown: work.integrationsKnown,
      githubKnown: work.githubKnown,
      gitlabKnown: work.gitlabKnown,
    },
  }));
  const list = vi.fn(async () => ({
    activeCount: 1,
    needsAttentionCount: 2,
    items: [
      {
        key: "SESSION:1",
        resourceKind: "SESSION",
        resourceId: "1",
        label: "Fix tests",
        summary: null,
        status: "IN_PROGRESS",
        reason: "ACTIVE",
        updatedAt: "2026-11-17T12:00:00Z",
        href: "/ai/sessions/1",
        error: "private error omitted",
      },
    ],
  }));
  const findRegistration = ({
    userId,
    clientRegistrationId,
  }: RegistrationKey) =>
    records.find(
      (row) =>
        row.userId === userId &&
        row.clientRegistrationId === clientRegistrationId,
    );
  const database = {
    findUnique: vi.fn(
      async ({ where }: { where: UniqueRegistrationFilter }) =>
        findRegistration(where.userId_clientRegistrationId) ?? null,
    ),
    count: vi.fn(
      async ({ where }: { where: SubscriptionFilter }) =>
        records.filter((row) => matchesSubscription(row, where)).length,
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: UniqueRegistrationFilter;
        create: Partial<IosStatusSubscription>;
        update: Partial<IosStatusSubscription>;
      }) => {
        const existing = findRegistration(where.userId_clientRegistrationId);
        if (existing) return Object.assign(existing, update);
        const created = registration(create);
        records.push(created);
        return created;
      },
    ),
    findMany: vi.fn(async ({ where }: { where: SubscriptionFilter }) =>
      records.filter((row) => matchesSubscription(row, where)),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: SubscriptionFilter;
        data: Partial<IosStatusSubscription>;
      }) => {
        const matching = records.filter((row) =>
          matchesSubscription(row, where),
        );
        for (const row of matching) Object.assign(row, data);
        return { count: matching.length };
      },
    ),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  const client = { iosStatusSubscription: database };
  getPrismaClient.mockResolvedValue({
    ...client,
    liveActivitySettings: {
      upsert: vi.fn(
        async ({
          update,
        }: {
          update: Partial<LiveActivityCategorySettings>;
        }) => {
          Object.assign(settings, update);
          return { id: "default", ...settings, updatedAt: new Date() };
        },
      ),
    },
    $transaction: (run: (tx: typeof client) => unknown) => run(client),
  });
  const send = vi.fn().mockResolvedValue({ status: 200, reason: null });
  const credentials = {
    getText: vi.fn().mockResolvedValue("private-key"),
    getValidatedJsonWithMetadata: vi.fn().mockResolvedValue({
      value: { teamId: "TEAM123456", keyId: "KEY1234567" },
    }),
  } as unknown as CredentialService;
  const service = new IosStatusService(
    { status } as unknown as SystemStatusService,
    { list } as unknown as ActionCenterService,
    credentials,
    { send, close: vi.fn() } as unknown as ApnsClient,
  );
  services.push(service);
  return {
    service,
    send,
    database,
    status,
    counts,
    work,
    settings,
    records,
    credentials,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
});
afterEach(() => {
  for (const service of services.splice(0)) service.stopRuntime();
  vi.useRealTimers();
});

describe("native status subscriptions", () => {
  test("accepts only the first-party topic and recognized token types", () => {
    expect(
      parseStatusRegistration({ ...input, token: "ab".repeat(32) }).token,
    ).toBe(input.token);
    expect(() =>
      parseStatusRegistration({ ...input, topic: "com.other.app" }),
    ).toThrow(/bundle identifier/);
    expect(() => parseStatusRegistration({ ...input, kind: "ALERT" })).toThrow(
      /WIDGET or LIVE_ACTIVITY/,
    );
    expect(() =>
      parseStatusRegistration({ ...input, token: "not-hex" }),
    ).toThrow();
    expect(() =>
      parseStatusRegistration({ ...input, userId: "other-user" }),
    ).toThrow(/unsupported/);
  });

  test("rotates a token within its authenticated owner and preserves the activity lifetime", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const { service, database } = harness([
      registration({ kind: "LIVE_ACTIVITY", expiresAt }),
    ]);
    await service.register(principal, {
      ...input,
      kind: "LIVE_ACTIVITY",
      token: "CD".repeat(32),
    });
    expect(database.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_clientRegistrationId: {
            userId: principal.userId,
            clientRegistrationId: input.clientRegistrationId,
          },
        },
        update: expect.objectContaining({
          token: "CD".repeat(32),
          sessionId: principal.sessionId,
          expiresAt,
          lastPayloadHash: null,
        }),
      }),
    );
  });

  test("keeps a rejected cached token inactive until its destination changes", async () => {
    const rejected = registration({
      status: "INVALID",
      lastFailureReason: "Unregistered",
      lastAttemptAt: new Date(),
      lastDeliveredAt: new Date(),
      lastPayloadHash: "old-content",
    });
    const { service, send } = harness([rejected]);
    await expect(service.register(principal, input)).resolves.toMatchObject({
      status: "INVALID",
    });
    expect(rejected.lastFailureReason).toBe("Unregistered");
    await service.flush();
    expect(send).not.toHaveBeenCalled();

    await expect(
      service.register(principal, { ...input, environment: "PRODUCTION" }),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    expect(rejected).toMatchObject({
      lastFailureReason: null,
      lastAttemptAt: null,
      lastDeliveredAt: null,
      lastPayloadHash: null,
    });
    await service.flush();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "PRODUCTION" }),
    );
  });

  test("enforces quota on eligible registrations including reactivations", async () => {
    const expired = new Date(Date.now() - 1_000);
    const { service } = harness([
      ...Array.from({ length: 63 }, (_, index) =>
        registration({
          id: `active-${index}`,
          clientRegistrationId: `active-${index}`,
        }),
      ),
      registration({ status: "INVALID" }),
      registration({
        id: "ended",
        clientRegistrationId: "ended",
        status: "ENDED",
      }),
      registration({
        id: "expired",
        clientRegistrationId: "expired",
        expiresAt: expired,
      }),
      registration({
        id: "expired-session",
        clientRegistrationId: "expired-session",
        session: { expiresAt: expired },
      }),
      registration({ id: "other-user", userId: "user-2" }),
    ]);
    const newWidget = { ...input, clientRegistrationId: "new-widget" };
    await expect(service.register(principal, newWidget)).resolves.toMatchObject(
      { status: "ACTIVE" },
    );
    await expect(
      service.register(principal, { ...input, token: "CD".repeat(32) }),
    ).rejects.toThrow(/Too many status subscriptions/);
    await expect(
      service.register(principal, {
        ...input,
        clientRegistrationId: "expired-session",
      }),
    ).rejects.toThrow(/Too many status subscriptions/);
    await expect(service.register(principal, newWidget)).resolves.toMatchObject(
      { status: "ACTIVE" },
    );
  });

  test("deletion is scoped to the authenticated user", async () => {
    const { service, database } = harness();
    await service.unregister(principal, { clientRegistrationId: "some-id" });
    expect(database.deleteMany).toHaveBeenCalledWith({
      where: { userId: principal.userId, clientRegistrationId: "some-id" },
    });
  });

  test("returns a bounded read-only status snapshot without action errors", async () => {
    const { service } = harness();
    const snapshot = await service.snapshot();
    expect(snapshot.liveActivity).toEqual({
      activeCount: 1,
      needsAttentionCount: 2,
      summary: "1 session",
      updatedAt: 1794916800,
    });
    expect(snapshot.actionCenter.items[0]).not.toHaveProperty("error");
    expect(snapshot.activity.pullRequests).toBe(2);
  });

  test("keeps a queued workflow in the Live Activity until it finishes", async () => {
    const activity = registration({ kind: "LIVE_ACTIVITY" });
    const { service, counts, work, send } = harness([activity]);
    counts.sessions = 0;
    work.queuedWorkflows = 1;

    const snapshot = await service.snapshot();
    expect(snapshot.activity.workflows).toBe(0);
    expect(snapshot.liveActivity).toMatchObject({
      activeCount: 1,
      summary: "1 workflow",
    });
    await service.flush();
    expect(send.mock.calls[0]![0].payload.aps).toMatchObject({
      event: "update",
    });
    expect(activity.status).toBe("ACTIVE");

    work.queuedWorkflows = 0;
    vi.setSystemTime(new Date(Date.now() + 15_000));
    await service.flush();
    expect(send.mock.calls[1]![0].payload.aps).toMatchObject({ event: "end" });
    expect(activity.status).toBe("ENDED");
  });

  test("waits for provider counts before ending an otherwise quiet Live Activity", async () => {
    const activity = registration({
      id: "activity-1",
      kind: "LIVE_ACTIVITY",
    });
    const { service, counts, work, send } = harness([activity, registration()]);
    counts.sessions = 0;
    work.integrationsKnown = false;

    expect((await service.snapshot()).liveActivity.summary).toBe(
      "Checking work status",
    );
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].headers["apns-push-type"]).toBe("widgets");
    expect(activity.status).toBe("ACTIVE");

    work.integrationsKnown = true;
    counts.pipelines = 1;
    await service.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].payload.aps).toMatchObject({
      event: "update",
      "content-state": { activeCount: 1, summary: "1 pipeline" },
    });
  });

  test("filters the active count and summary while preserving attention and sidebar counts", async () => {
    const { service, settings, counts } = harness();
    Object.assign(counts, {
      plans: 2,
      sessions: 3,
      builds: 4,
      workflows: 5,
      commands: 6,
      actions: 7,
      pipelines: 8,
    });
    Object.assign(settings, {
      includePlans: false,
      includeBuilds: false,
      includeWorkflows: false,
      includeCommands: false,
      includeGitLabPipelines: false,
    });
    const snapshot = await service.snapshot();
    expect(snapshot.liveActivity).toMatchObject({
      activeCount: 10,
      summary: "3 sessions · 7 actions",
      needsAttentionCount: 2,
    });
    expect(snapshot.activity).toMatchObject({
      plans: 2,
      sessions: 3,
      builds: 4,
      actions: 7,
      pipelines: 8,
    });
    expect(snapshot.actionCenter.needsAttentionCount).toBe(2);
  });

  test("a shared settings save promptly ends existing activity when every category is excluded", async () => {
    const { service, send } = harness([
      registration({ kind: "LIVE_ACTIVITY" }),
    ]);
    service.startRuntime();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send.mock.calls[0]![0].payload.aps.event).toBe("update");
    await saveLiveActivitySettings({
      includePlans: false,
      includeSessions: false,
      includeBuilds: false,
      includeWorkflows: false,
      includeCommands: false,
      includeGitHubActions: false,
      includeGitLabPipelines: false,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send.mock.calls[1]![0].payload.aps).toMatchObject({
      event: "end",
      "content-state": {
        activeCount: 0,
        needsAttentionCount: 2,
        summary: "Work finished",
      },
    });
  });

  test("an excluded unknown integration cannot prevent ending attention-only activity", async () => {
    const { service, settings, counts, work, send } = harness([
      registration({ kind: "LIVE_ACTIVITY" }),
    ]);
    counts.sessions = 0;
    work.integrationsKnown = false;
    work.githubKnown = false;
    work.gitlabKnown = true;
    settings.includeGitHubActions = false;
    expect((await service.snapshot()).liveActivity).toMatchObject({
      activeCount: 0,
      needsAttentionCount: 2,
      summary: "Work finished",
    });
    await service.flush();
    expect(send.mock.calls[0]![0].payload.aps.event).toBe("end");
  });

  test("attention by itself never activates or keeps a Live Activity", async () => {
    const { service, counts, send } = harness([
      registration({ kind: "LIVE_ACTIVITY" }),
    ]);
    counts.sessions = 0;
    const snapshot = await service.snapshot();
    expect(snapshot.actionCenter.activeCount).toBe(1);
    expect(snapshot.liveActivity).toMatchObject({
      activeCount: 0,
      needsAttentionCount: 2,
    });
    await service.flush();
    expect(send.mock.calls[0]![0].payload.aps).toMatchObject({
      event: "end",
      "content-state": { activeCount: 0, needsAttentionCount: 2 },
    });
  });

  test("recovers durable registrations at startup and coalesces sidebar events", async () => {
    const { service, send, counts } = harness();
    service.startRuntime();
    for (let index = 0; index < 5; index++)
      agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      headers: {
        "apns-push-type": "widgets",
        "apns-topic": `${input.topic}.push-type.widgets`,
        "apns-priority": "5",
      },
      payload: { aps: { "content-changed": true } },
    });
    counts.sessions = 2;
    agentEventBus.publish(SIDEBAR_STATUS_CHANGED_TOPIC, {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("an earlier activity completion is not delayed by a widget's five-minute cooldown", async () => {
    const widget = registration({ lastAttemptAt: new Date() });
    const activity = registration({
      id: "activity-1",
      kind: "LIVE_ACTIVITY",
      lastAttemptAt: new Date(),
    });
    const { service, counts, send } = harness([widget, activity]);
    counts.sessions = 0;
    await service.flush();
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      headers: {
        "apns-push-type": "liveactivity",
        "apns-topic": `${input.topic}.push-type.liveactivity`,
        "apns-expiration": String(
          Math.floor(activity.expiresAt.getTime() / 1_000),
        ),
      },
      payload: {
        aps: {
          event: "end",
          "content-state": {
            activeCount: 0,
            needsAttentionCount: 2,
            summary: "Work finished",
          },
          "dismissal-date": expect.any(Number),
        },
      },
    });
    expect(activity.status).toBe("ENDED");
  });

  test("caps terminal notification expiration at session expiry", async () => {
    const sessionExpiresAt = new Date(Date.now() + 10 * 60_000);
    const activity = registration({
      kind: "LIVE_ACTIVITY",
      session: { expiresAt: sessionExpiresAt },
    });
    const { service, counts, send } = harness([activity]);
    counts.sessions = 0;
    await service.flush();
    expect(send.mock.calls[0]![0]).toMatchObject({
      headers: {
        "apns-expiration": String(
          Math.floor(sessionExpiresAt.getTime() / 1_000),
        ),
      },
      payload: { aps: { event: "end" } },
    });
  });

  test("sets update expiration when the recipient's batch sends", async () => {
    const activity = registration({ id: "activity-1", kind: "LIVE_ACTIVITY" });
    const widgets = Array.from({ length: 10 }, (_, index) =>
      registration({ id: `widget-${index}` }),
    );
    const { service, send } = harness([...widgets, activity]);
    const delayedBatchTime = new Date(Date.now() + 2 * 60_000);
    send.mockImplementationOnce(async () => {
      vi.setSystemTime(delayedBatchTime);
      return { status: 200, reason: null };
    });

    await service.flush();

    expect(send).toHaveBeenCalledTimes(11);
    expect(send.mock.calls[10]![0]).toMatchObject({
      headers: {
        "apns-expiration": String(
          Math.floor(delayedBatchTime.getTime() / 1_000) + 60,
        ),
      },
      payload: { aps: { event: "update" } },
    });
  });

  test("refreshes unchanged ongoing work before its stale date", async () => {
    const activity = registration({ kind: "LIVE_ACTIVITY" });
    const { service, send } = harness([activity]);
    await service.flush();
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.now() + 4 * 60_000));
    await service.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].payload.aps).toMatchObject({
      event: "update",
      "stale-date": expect.any(Number),
    });
  });

  test("keeps transient errors retryable within the budget and invalidates dead tokens", async () => {
    const { service, send, records } = harness();
    send.mockResolvedValueOnce({ status: 503, reason: "ServiceUnavailable" });
    await service.flush();
    expect(records[0]).toMatchObject({
      status: "ACTIVE",
      lastFailureReason: "ServiceUnavailable",
      lastPayloadHash: null,
    });
    await service.flush();
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValueOnce({ status: 410, reason: "Unregistered" });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(records[0]?.status).toBe("INVALID");
  });

  test("ignores a rejection from a previous APNs destination", async () => {
    const { service, send, records } = harness();
    send.mockImplementationOnce(async () => {
      await service.register(principal, {
        ...input,
        environment: "PRODUCTION",
      });
      return { status: 410, reason: "Unregistered" };
    });

    await service.flush();

    expect(records[0]).toMatchObject({
      environment: "PRODUCTION",
      status: "ACTIVE",
      lastFailureReason: null,
    });
    await service.flush();
    expect(send.mock.calls[1]![0].environment).toBe("PRODUCTION");
  });

  test("limits recipients to active unexpired sessions and non-banned users", async () => {
    const { service, database } = harness([]);
    await service.flush();
    expect(database.findMany).toHaveBeenCalledWith({
      include: { session: { select: { expiresAt: true } } },
      where: {
        status: "ACTIVE",
        expiresAt: { gt: expect.any(Date) },
        session: { expiresAt: { gt: expect.any(Date) } },
        user: { OR: [{ banned: false }, { banned: null }] },
      },
    });
  });

  test("requires no status reads or APNs connection without credentials", async () => {
    const { service, credentials, status, send } = harness();
    vi.mocked(credentials.getText).mockResolvedValue(null);
    await service.flush();
    expect(status).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
