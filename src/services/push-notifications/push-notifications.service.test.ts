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
});
