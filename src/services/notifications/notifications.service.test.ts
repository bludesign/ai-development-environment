import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());
const generateVAPIDKeys = vi.hoisted(() => vi.fn());
const setVapidDetails = vi.hoisted(() => vi.fn());
const sendNotification = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
vi.mock("web-push", () => ({
  default: { generateVAPIDKeys, setVapidDetails, sendNotification },
}));

import { agentEventBus } from "@/services/agent-control";
import type { CredentialService } from "@/services/credentials";

import { NotificationsService } from "./notifications.service";

function credentials(overrides: Partial<CredentialService> = {}) {
  return {
    getText: vi.fn().mockResolvedValue("private-key"),
    isConfigured: vi.fn().mockResolvedValue(true),
    setText: vi.fn(),
    ...overrides,
  } as unknown as CredentialService;
}

describe("NotificationsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateVAPIDKeys.mockReturnValue({
      publicKey: "public-key",
      privateKey: "private-key",
    });
  });

  test("records registry defaults and snapshots the requested channels", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      ...data,
      sidebarDismissedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const transaction = {
      notificationPreference: { findUnique: vi.fn().mockResolvedValue(null) },
      appNotification: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
      },
    };
    const service = new NotificationsService(credentials());

    const result = await service.recordInTransaction(transaction as never, {
      dedupeKey: "ios-build:build-1:SUCCEEDED",
      typeKey: "IOS_BUILD_SUCCEEDED",
      title: "iOS build succeeded",
      body: "Repository · Debug · main",
      href: "/builds/build-1",
      resourceKind: "BUILD",
      resourceId: "build-1",
      worktreeId: "worktree-1",
      highlightColor: "blue",
    });

    expect(result).toMatchObject({
      sidebarRequested: true,
      browserRequested: true,
      webPushRequested: false,
      highlightColor: "blue",
    });
    expect(create).toHaveBeenCalledOnce();
  });

  test("does not create an event when every channel is disabled", async () => {
    const create = vi.fn();
    const service = new NotificationsService(credentials());
    const result = await service.recordInTransaction(
      {
        notificationPreference: {
          findUnique: vi.fn().mockResolvedValue({
            sidebarEnabled: false,
            browserEnabled: false,
            webPushEnabled: false,
          }),
        },
        appNotification: { findUnique: vi.fn(), create },
      } as never,
      {
        dedupeKey: "ios-build:build-1:FAILED",
        typeKey: "IOS_BUILD_FAILED",
        title: "iOS build failed",
        body: "Repository · Debug · main",
        href: "/builds/build-1",
        resourceKind: "BUILD",
        resourceId: "build-1",
      },
    );

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test("dismisses sidebar notifications without deleting history", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const deleteMany = vi.fn();
    getPrismaClient.mockResolvedValue({
      appNotification: { updateMany, deleteMany },
    });
    const publish = vi.spyOn(agentEventBus, "publish");
    const service = new NotificationsService(credentials());

    await expect(service.dismiss("notification-1")).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "notification-1" }),
      }),
    );
    expect(deleteMany).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      "app-notifications.changed",
      expect.objectContaining({
        notificationsChanged: expect.objectContaining({ kind: "DISMISSED" }),
      }),
    );
  });

  test("generates VAPID keys once through the credential transaction", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({
      webPushSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    const setText = vi.fn(async (_descriptor, _value, mutation) => {
      await mutation({ webPushSettings: { upsert } });
    });
    const service = new NotificationsService(credentials({ setText } as never));

    await expect(service.prepareWebPush()).resolves.toEqual({
      publicKey: "public-key",
    });

    expect(generateVAPIDKeys).toHaveBeenCalledOnce();
    expect(setText).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web-push-vapid-private-key" }),
      "private-key",
      expect.any(Function),
    );
    expect(upsert).toHaveBeenCalledOnce();
  });

  test("removes permanently expired push subscriptions", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      webPushSettings: {
        findUnique: vi.fn().mockResolvedValue({ vapidPublicKey: "public-key" }),
      },
      webPushSubscription: {
        findMany: vi.fn().mockResolvedValue([
          {
            endpoint: "https://push.example/subscription",
            expirationTime: null,
            p256dh: "p256dh",
            auth: "auth",
          },
        ]),
        deleteMany,
      },
    });
    sendNotification.mockRejectedValue({ statusCode: 410 });
    const service = new NotificationsService(credentials());

    await service.deliverWebPush({
      id: "notification-1",
      dedupeKey: "dedupe",
      typeKey: "IOS_BUILD_FAILED",
      title: "iOS build failed",
      body: "Repository · Debug · main",
      href: "/builds/build-1",
      resourceKind: "BUILD",
      resourceId: "build-1",
      worktreeId: "worktree-1",
      highlightColor: null,
      sidebarRequested: true,
      browserRequested: true,
      webPushRequested: true,
      sidebarDismissedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    expect(setVapidDetails).toHaveBeenCalledOnce();
    expect(deleteMany).toHaveBeenCalledWith({
      where: { endpoint: "https://push.example/subscription" },
    });
  });

  test("sends a test notification to one subscribed browser", async () => {
    getPrismaClient.mockResolvedValue({
      webPushSettings: {
        findUnique: vi.fn().mockResolvedValue({ vapidPublicKey: "public-key" }),
      },
      webPushSubscription: {
        findUnique: vi.fn().mockResolvedValue({
          id: "subscription-1",
          endpoint: "https://push.example/subscription",
          expirationTime: null,
          p256dh: "p256dh",
          auth: "auth",
        }),
        deleteMany: vi.fn(),
      },
    });
    sendNotification.mockResolvedValue({ statusCode: 201 });
    const service = new NotificationsService(credentials());

    await expect(
      service.testWebPushSubscription("subscription-1"),
    ).resolves.toBe(true);

    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://push.example/subscription",
      }),
      expect.stringContaining('"title":"Test notification"'),
      expect.objectContaining({ TTL: 60 }),
    );
  });
});
