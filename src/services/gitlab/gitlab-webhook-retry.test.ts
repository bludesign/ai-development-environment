import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, test, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(),
  gitLabProject: { updateMany: vi.fn() },
  gitLabRestCacheEntry: { deleteMany: vi.fn() },
  gitLabWebhookDelivery: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: vi.fn(async () => prisma),
}));

import { GitLabService } from "./gitlab.service";

describe("GitLab webhook retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (operations: unknown[]) =>
      Promise.all(operations),
    );
    prisma.gitLabProject.updateMany.mockResolvedValue({ count: 1 });
    prisma.gitLabRestCacheEntry.deleteMany.mockResolvedValue({ count: 0 });
  });

  test("retries a delivery whose downstream handler previously failed", async () => {
    let outcome: string | null = null;
    prisma.gitLabWebhookDelivery.create.mockImplementation(
      async ({ data }: { data: { outcome: string } }) => {
        if (outcome)
          throw Object.assign(new Error("duplicate"), { code: "P2002" });
        outcome = data.outcome;
        return data;
      },
    );
    prisma.gitLabWebhookDelivery.updateMany.mockImplementation(
      async ({ data }: { data: { outcome: string } }) => {
        if (outcome !== "ERROR") return { count: 0 };
        outcome = data.outcome;
        return { count: 1 };
      },
    );
    prisma.gitLabWebhookDelivery.update.mockImplementation(
      async ({ data }: { data: { outcome: string } }) => {
        outcome = data.outcome;
        return data;
      },
    );

    const key = Buffer.alloc(32, 7);
    const signingToken = `whsec_${key.toString("base64")}`;
    const credentials = {
      getJson: vi.fn().mockResolvedValue({ "42": signingToken }),
    };
    const workflowEvents = {
      record: vi
        .fn()
        .mockRejectedValueOnce(new Error("workflow storage unavailable"))
        .mockResolvedValue(undefined),
    };
    const service = new GitLabService(
      credentials as never,
      workflowEvents as never,
    );
    const rawBody = JSON.stringify({
      object_kind: "merge_request",
      project: { id: 42, name: "widgets" },
      object_attributes: { id: 10, iid: 3, action: "open" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const webhookId = "delivery-1";
    const headers = new Headers({
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${createHmac("sha256", key)
        .update(`${webhookId}.${timestamp}.${rawBody}`)
        .digest("base64")}`,
      "x-gitlab-event": "Merge Request Hook",
    });

    await expect(service.handleWebhook({ rawBody, headers })).rejects.toThrow(
      "workflow storage unavailable",
    );
    expect(outcome).toBe("ERROR");

    await expect(service.handleWebhook({ rawBody, headers })).resolves.toEqual({
      duplicate: false,
    });
    expect(outcome).toBe("PROCESSED");

    await expect(service.handleWebhook({ rawBody, headers })).resolves.toEqual({
      duplicate: true,
    });
    expect(workflowEvents.record).toHaveBeenCalledTimes(2);
  });
});
