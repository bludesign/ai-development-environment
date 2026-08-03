import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: vi.fn(),
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

import type { CredentialService } from "@/services/credentials";
import type { ApnsClient } from "@/services/push-notifications/apns-client";

import { parseNotificationDeviceInput } from "./notification-devices";
import { NotificationsService } from "./notifications.service";

const TOKEN = "A".repeat(64);

function credentials(overrides: Partial<CredentialService> = {}) {
  return {
    getText: vi.fn().mockResolvedValue("private-key"),
    isConfigured: vi.fn().mockResolvedValue(true),
    getValidatedJsonWithMetadata: vi.fn().mockResolvedValue({
      value: { teamId: "TEAM123456", keyId: "KEY1234567" },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }),
    ...overrides,
  } as unknown as CredentialService;
}

function apnsClient(send: ReturnType<typeof vi.fn>) {
  return { send } as unknown as ApnsClient;
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    id: "device-1",
    token: TOKEN,
    topic: "com.example.app",
    environment: "PRODUCTION",
    displayName: "iPhone",
    status: "ACTIVE",
    ...overrides,
  };
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: "notification-1",
    dedupeKey: "run:run-1:COMPLETED",
    typeKey: "RUN_COMPLETED",
    title: "Plan or session completed",
    body: "Session #923 completed",
    href: "/runs/run-1",
    resourceKind: "RUN",
    resourceId: "run-1",
    worktreeId: null,
    highlightColor: null,
    sidebarRequested: true,
    browserRequested: true,
    webPushRequested: false,
    apnsRequested: true,
    sidebarDismissedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe("parseNotificationDeviceInput", () => {
  const valid = {
    clientRegistrationId: "ios-app-1",
    token: TOKEN,
    tokenEncoding: "HEX",
    topic: "com.example.app",
    environment: "PRODUCTION",
    displayName: "iPhone",
  };

  test("normalizes the token and defaults the encoding to hex", () => {
    const { tokenEncoding: _encoding, ...withoutEncoding } = valid;
    expect(parseNotificationDeviceInput(withoutEncoding)).toMatchObject({
      token: TOKEN,
      topic: "com.example.app",
      environment: "PRODUCTION",
      deviceModel: null,
      locale: null,
    });
  });

  test("rejects a token that is not 32 bytes", () => {
    expect(() =>
      parseNotificationDeviceInput({ ...valid, token: "AABB" }),
    ).toThrow(/32 bytes/);
  });

  test("rejects an unknown environment and unsupported fields", () => {
    expect(() =>
      parseNotificationDeviceInput({ ...valid, environment: "STAGING" }),
    ).toThrow(/SANDBOX or PRODUCTION/);
    expect(() =>
      parseNotificationDeviceInput({ ...valid, pushMagic: "magic" }),
    ).toThrow(/unsupported fields/);
  });
});

describe("APNs notification delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("sends one alert per active device and records the delivery", async () => {
    const send = vi.fn().mockResolvedValue({ status: 200, reason: null });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      notificationDevice: {
        findMany: vi
          .fn()
          .mockResolvedValue([device(), device({ id: "device-2" })]),
        updateMany,
      },
    });
    const service = new NotificationsService(credentials(), apnsClient(send));

    await service.deliverApns(notification());

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toMatchObject({
      deviceToken: TOKEN,
      environment: "PRODUCTION",
      authentication: { kind: "TOKEN", teamId: "TEAM123456" },
      headers: expect.objectContaining({
        "apns-topic": "com.example.app",
        "apns-push-type": "alert",
        "apns-collapse-id": "run:run-1:COMPLETED",
      }),
      payload: expect.objectContaining({
        aps: expect.objectContaining({
          alert: {
            title: "Plan or session completed",
            body: "Session #923 completed",
          },
        }),
        href: "/runs/run-1",
      }),
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastFailureReason: null }),
      }),
    );
  });

  test("deactivates a device whose token APNs no longer recognizes", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ status: 410, reason: "Unregistered" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      notificationDevice: {
        findMany: vi.fn().mockResolvedValue([device()]),
        updateMany,
      },
    });
    const service = new NotificationsService(credentials(), apnsClient(send));

    await service.deliverApns(notification());

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "device-1" },
      data: expect.objectContaining({
        status: "INACTIVE",
        lastFailureReason: "Unregistered",
      }),
    });
  });

  test("keeps a device active when APNs reports a transient failure", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ status: 503, reason: "ServiceUnavailable" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      notificationDevice: {
        findMany: vi.fn().mockResolvedValue([device()]),
        updateMany,
      },
    });
    const service = new NotificationsService(credentials(), apnsClient(send));

    await service.deliverApns(notification());

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "device-1" },
      data: expect.not.objectContaining({ status: "INACTIVE" }),
    });
  });

  test("skips notifications that did not request the channel", async () => {
    const send = vi.fn();
    const findMany = vi.fn();
    getPrismaClient.mockResolvedValue({
      notificationDevice: { findMany, updateMany: vi.fn() },
    });
    const service = new NotificationsService(credentials(), apnsClient(send));

    await service.deliverApns(notification({ apnsRequested: false }));

    expect(findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("does not send when the provider key is missing", async () => {
    const send = vi.fn();
    getPrismaClient.mockResolvedValue({
      notificationDevice: {
        findMany: vi.fn().mockResolvedValue([device()]),
        updateMany: vi.fn(),
      },
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new NotificationsService(
      credentials({ getText: vi.fn().mockResolvedValue(null) } as never),
      apnsClient(send),
    );

    await service.deliverApns(notification());

    expect(send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  test("leaves a stored APNs choice alone when a client omits the field", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    getPrismaClient.mockResolvedValue({
      notificationPreference: {
        findUnique: vi.fn().mockResolvedValue({ apnsEnabled: false }),
        upsert,
      },
    });
    const service = new NotificationsService(
      credentials(),
      apnsClient(vi.fn()),
    );

    await service.savePreference({
      typeKey: "RUN_COMPLETED",
      sidebarEnabled: true,
      browserEnabled: true,
      webPushEnabled: false,
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ apnsEnabled: false }),
      }),
    );
  });

  test("surfaces the APNs reason when a test notification is rejected", async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ status: 400, reason: "BadDeviceToken" });
    getPrismaClient.mockResolvedValue({
      notificationDevice: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(device())
          .mockResolvedValueOnce(
            device({ lastFailureReason: "BadDeviceToken" }),
          ),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const service = new NotificationsService(credentials(), apnsClient(send));

    await expect(service.testNotificationDevice("device-1")).rejects.toThrow(
      /BadDeviceToken/,
    );
  });

  test("replaces the previous holder when APNs reissues a device token", async () => {
    const deleteDevice = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockImplementation(({ data }) => data);
    const transaction = {
      notificationDevice: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "stale-device" }),
        delete: deleteDevice,
        create,
        update: vi.fn(),
      },
    };
    getPrismaClient.mockResolvedValue({
      $transaction: (run: (tx: unknown) => unknown) => run(transaction),
    });
    const service = new NotificationsService(
      credentials(),
      apnsClient(vi.fn()),
    );

    const result = await service.registerDevice(
      {
        clientRegistrationId: "ios-app-1",
        token: TOKEN,
        tokenEncoding: "HEX",
        topic: "com.example.app",
        environment: "PRODUCTION",
        displayName: "iPhone",
      },
      "127.0.0.1",
    );

    expect(deleteDevice).toHaveBeenCalledWith({
      where: { id: "stale-device" },
    });
    expect(result.created).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientRegistrationId: "ios-app-1",
          status: "ACTIVE",
          lastIpAddress: "127.0.0.1",
        }),
      }),
    );
  });
});
