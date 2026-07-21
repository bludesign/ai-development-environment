// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest";

const getPrismaClient = vi.hoisted(() => vi.fn());

vi.mock("@/data/prisma-client", () => ({ getPrismaClient }));

import { PushNotificationsService } from "./push-notifications.service";

const liveActivityEditor = {
  pushType: "liveactivity",
  headers: {
    topic: "com.example.app.push-type.liveactivity",
    priority: 10,
  },
  aps: {},
  custom: {},
  liveActivity: {
    timestamp: 1_784_500_000,
    event: "update",
    "content-state": { score: 2 },
  },
  credentialId: null,
};

describe("PushNotificationsService direct delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("keeps a one-off Live Activity token outside the history payload", async () => {
    const create = vi.fn().mockImplementation(({ data }) => ({
      id: data.id,
      ...data,
      deliveries: [],
    }));
    getPrismaClient.mockResolvedValue({
      pushNotificationBatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    });
    const service = new PushNotificationsService();
    const token = "ab".repeat(32);

    await service.send({
      requestId: "request-1",
      editor: liveActivityEditor,
      targetMode: "DIRECT",
      directToken: token,
      directTokenEncoding: "HEX",
      directEnvironment: "PRODUCTION",
    });

    const data = create.mock.calls[0]?.[0].data;
    expect(data.targetMode).toBe("DIRECT");
    expect(data.editorJson).not.toContain(token);
    expect(data.payloadJson).not.toContain(token);
    expect(data.headersJson).not.toContain(token);
    expect(data.deliveries.create[0]).toMatchObject({
      environment: "PRODUCTION",
      topic: "com.example.app.push-type.liveactivity",
      recipientSecret: { create: { token: token.toUpperCase() } },
    });
    expect(data.deliveries.create[0].tokenHash).not.toBe(token.toUpperCase());
  });

  test("rejects direct-token delivery for non-Live Activity payloads", async () => {
    getPrismaClient.mockResolvedValue({
      pushNotificationBatch: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new PushNotificationsService();

    await expect(
      service.send({
        requestId: "request-2",
        editor: {
          ...liveActivityEditor,
          pushType: "alert",
          headers: { topic: "com.example.app", priority: 10 },
          aps: { alert: { title: "Hello" } },
        },
        targetMode: "DIRECT",
        directToken: "ab".repeat(32),
      }),
    ).rejects.toThrow("only for Live Activities");
  });

  test("rejects an unknown target mode before selecting registrations", async () => {
    const findMany = vi.fn();
    getPrismaClient.mockResolvedValue({
      pushNotificationBatch: { findMany: vi.fn().mockResolvedValue([]) },
      apnsRegistration: { findMany },
    });
    const service = new PushNotificationsService();

    await expect(
      service.send({
        requestId: "request-3",
        editor: liveActivityEditor,
        targetMode: "DEVCIES",
      }),
    ).rejects.toThrow("Unsupported push target mode: DEVCIES");
    expect(findMany).not.toHaveBeenCalled();
  });

  test("rejects deletion while a batch is queued or sending", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    getPrismaClient.mockResolvedValue({
      pushNotificationBatch: {
        deleteMany,
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ status: "SENDING" }),
      },
    });
    const service = new PushNotificationsService();

    await expect(service.deleteHistory("batch-1")).rejects.toThrow(
      "cannot be deleted",
    );
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "batch-1",
        status: { notIn: ["QUEUED", "SENDING"] },
      },
    });
  });

  test("loads individual presets and history batches for tool callers", async () => {
    const preset = { id: "preset-1", editorJson: "{}" };
    const batch = { id: "batch-1", deliveries: [] };
    const presetFindUnique = vi.fn().mockResolvedValue(preset);
    const batchFindUnique = vi.fn().mockResolvedValue(batch);
    getPrismaClient.mockResolvedValue({
      pushNotificationPreset: { findUnique: presetFindUnique },
      pushNotificationBatch: {
        findUnique: batchFindUnique,
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new PushNotificationsService();

    await expect(service.preset("preset-1")).resolves.toBe(preset);
    await expect(service.historyItem("batch-1")).resolves.toBe(batch);
    expect(presetFindUnique).toHaveBeenCalledWith({
      where: { id: "preset-1" },
    });
    expect(batchFindUnique).toHaveBeenCalledWith({
      where: { id: "batch-1" },
      include: { deliveries: { orderBy: { createdAt: "asc" } } },
    });
  });

  test("records token-auth success without a stored registration", async () => {
    const settingsUpdate = vi.fn().mockResolvedValue({ count: 1 });
    getPrismaClient.mockResolvedValue({
      pushNotificationBatch: { findMany: vi.fn().mockResolvedValue([]) },
      pushNotificationDelivery: { update: vi.fn().mockResolvedValue({}) },
      pushNotificationSettings: { updateMany: settingsUpdate },
    });
    const service = new PushNotificationsService();

    await (
      service as unknown as {
        recordResponse: (
          deliveryId: string,
          registration: null,
          response: {
            status: number;
            reason: string | null;
            timestamp: Date | null;
            apnsId: string | null;
            attempts: number;
            durationMs: number;
          },
          tokenAuthentication: boolean,
        ) => Promise<void>;
      }
    ).recordResponse(
      "delivery-1",
      null,
      {
        status: 200,
        reason: null,
        timestamp: null,
        apnsId: "apns-1",
        attempts: 1,
        durationMs: 12,
      },
      true,
    );

    expect(settingsUpdate).toHaveBeenCalledWith({
      where: { id: "default" },
      data: {
        tokenLastUsedAt: expect.any(Date),
        tokenLastError: null,
      },
    });
  });

  test("drains recovery pages and loads only queued deliveries", async () => {
    const batchFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "batch-1",
          status: "QUEUED",
          createdAt: new Date(),
        },
      ])
      .mockResolvedValueOnce([]);
    const batchFindUnique = vi.fn().mockResolvedValue({
      id: "batch-1",
      status: "SENDING",
      editorJson: JSON.stringify(liveActivityEditor),
      payloadJson: "{}",
      headersJson: "{}",
      channelId: null,
      deliveries: [],
    });
    getPrismaClient.mockResolvedValue({
      pushNotificationBatch: {
        findMany: batchFindMany,
        findUnique: batchFindUnique,
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      pushNotificationDelivery: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    });
    const service = new PushNotificationsService();

    await service.recover();

    expect(batchFindMany).toHaveBeenCalledTimes(2);
    expect(batchFindUnique).toHaveBeenCalledWith({
      where: { id: "batch-1" },
      include: { deliveries: { where: { status: "QUEUED" } } },
    });
  });
});
