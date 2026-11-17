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

function registration(
  overrides: Partial<IosStatusSubscription> = {},
): IosStatusSubscription {
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
    ...overrides,
  };
}

const services: IosStatusService[] = [];

function harness(records: IosStatusSubscription[] = [registration()]) {
  const counts = {
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
  const status = vi.fn(async () => ({
    usageToday: { totalCost: 12.5, collectedAt: "2026-11-17T12:00:00Z" },
    activity: { ...counts },
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
  const database = {
    findUnique: vi.fn(async () => null as IosStatusSubscription | null),
    count: vi.fn(async () => records.length),
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: IosStatusSubscription;
        update: Partial<IosStatusSubscription>;
      }) => ({ ...create, ...update }),
    ),
    findMany: vi.fn(async () =>
      records.filter((record) => record.status === "ACTIVE"),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<IosStatusSubscription>;
      }) => {
        const matching = records.filter((row) =>
          Object.entries(where).every(([key, value]) => {
            const actual = row[key as keyof IosStatusSubscription];
            return actual instanceof Date && value instanceof Date
              ? actual.getTime() === value.getTime()
              : actual === value;
          }),
        );
        for (const row of matching) Object.assign(row, data);
        return { count: matching.length };
      },
    ),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
  getPrismaClient.mockResolvedValue({ iosStatusSubscription: database });
  const send = vi.fn().mockResolvedValue({ status: 200, reason: null });
  const credentials = {
    getText: vi.fn().mockResolvedValue("private-key"),
    getValidatedJsonWithMetadata: vi
      .fn()
      .mockResolvedValue({
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
  return { service, send, database, status, counts, records, credentials };
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
    const { service, database } = harness();
    const expiresAt = new Date(Date.now() + 60_000);
    database.findUnique.mockResolvedValue(
      registration({ kind: "LIVE_ACTIVITY", expiresAt }),
    );
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

  test("limits recipients to active unexpired sessions and non-banned users", async () => {
    const { service, database } = harness([]);
    await service.flush();
    expect(database.findMany).toHaveBeenCalledWith({
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
