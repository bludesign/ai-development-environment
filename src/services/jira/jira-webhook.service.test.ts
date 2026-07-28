import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { JiraWebhookService } from "./jira-webhook.service";

const SECRET = "jira-webhook-secret";

type DeliveryRow = {
  deliveryId: string;
  event: string;
  issueKey: string | null;
  projectKey: string | null;
  retryCount: number | null;
  outcome: string;
  error: string | null;
  receivedAt: Date;
  processedAt: Date | null;
};

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    webhookEvent: "jira:issue_updated",
    user: { accountId: "account-1", displayName: "Ada" },
    issue: {
      id: "10001",
      key: "AIDE-42",
      fields: {
        summary: "Add Jira webhooks",
        project: { key: "AIDE" },
        status: {
          id: "3",
          name: "In Review",
          statusCategory: { key: "indeterminate" },
        },
        issuetype: { name: "Task" },
        assignee: { accountId: "account-2", displayName: "Grace" },
        labels: ["urgent"],
      },
    },
    ...overrides,
  };
}

function signed(payload: unknown, secret = SECRET) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  return {
    body,
    signature: `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  };
}

describe("Jira webhook ingestion", () => {
  let deliveries: Map<string, DeliveryRow>;
  let credentials: {
    getText: ReturnType<typeof vi.fn>;
    isConfigured: ReturnType<typeof vi.fn>;
    setText: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let jira: {
    refreshCachedTicket: ReturnType<typeof vi.fn>;
    deleteCachedTicket: ReturnType<typeof vi.fn>;
  };
  let workflowEvents: { record: ReturnType<typeof vi.fn> };
  let create: ReturnType<typeof vi.fn>;
  let updateMany: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deliveries = new Map();
    create = vi.fn(async ({ data }: { data: Partial<DeliveryRow> }) => {
      if (deliveries.has(data.deliveryId!)) {
        throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      }
      const row: DeliveryRow = {
        deliveryId: data.deliveryId!,
        event: data.event ?? "unknown",
        issueKey: null,
        projectKey: null,
        retryCount: data.retryCount ?? null,
        outcome: data.outcome!,
        error: null,
        receivedAt: new Date(),
        processedAt: null,
      };
      deliveries.set(row.deliveryId, row);
      return row;
    });
    updateMany = vi.fn(
      async ({
        where,
        data,
      }: {
        where: { deliveryId: string; outcome: { notIn: string[] } };
        data: Partial<DeliveryRow>;
      }) => {
        const row = deliveries.get(where.deliveryId);
        if (!row || where.outcome.notIn.includes(row.outcome)) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    );

    mocks.getPrismaClient.mockResolvedValue({
      jiraWebhookDelivery: {
        create,
        updateMany,
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { deliveryId: string };
            data: Partial<DeliveryRow>;
          }) => {
            const row = deliveries.get(where.deliveryId)!;
            Object.assign(row, data);
            return row;
          },
        ),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => [...deliveries.values()]),
        count: vi.fn(async () => deliveries.size),
      },
      jiraSettings: {
        findUnique: vi.fn(async () => ({ webhookEnabled: true })),
        upsert: vi.fn(async () => ({
          webhookEnabled: true,
          webhookConfiguredAt: new Date(0),
        })),
      },
    });

    credentials = {
      getText: vi.fn(async () => SECRET),
      isConfigured: vi.fn(async () => true),
      setText: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    jira = {
      refreshCachedTicket: vi.fn(async () => ({ key: "AIDE-42" })),
      deleteCachedTicket: vi.fn(async () => true),
    };
    workflowEvents = { record: vi.fn(async () => ({ id: "event-1" })) };
  });

  const service = () =>
    new JiraWebhookService(
      jira as never,
      credentials as never,
      workflowEvents as never,
    );

  test("refreshes the ticket for an issue-mutating delivery", async () => {
    const { body, signature } = signed(issuePayload());

    await expect(
      service().handleWebhook({
        body,
        signature,
        deliveryId: "delivery-1",
        retryCount: "0",
      }),
    ).resolves.toMatchObject({
      outcome: "PROCESSED",
      event: "jira:issue_updated",
      issueKey: "AIDE-42",
    });

    // The refresh is what makes JiraService emit the pre-existing JIRA_*
    // cursor triggers, so it has to happen for every mutating event.
    expect(jira.refreshCachedTicket).toHaveBeenCalledWith("AIDE-42");
    expect(deliveries.get("delivery-1")).toMatchObject({
      outcome: "PROCESSED",
      event: "jira:issue_updated",
      issueKey: "AIDE-42",
      projectKey: "AIDE",
    });
  });

  test("rejects an invalid signature before recording the delivery", async () => {
    const { body } = signed(issuePayload());

    await expect(
      service().handleWebhook({
        body,
        signature: `sha256=${"0".repeat(64)}`,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).rejects.toThrow("signature is invalid");

    expect(create).not.toHaveBeenCalled();
    expect(jira.refreshCachedTicket).not.toHaveBeenCalled();
  });

  test("reports a missing secret as unconfigured rather than unauthorized", async () => {
    credentials.getText.mockResolvedValue(null);
    const { body, signature } = signed(issuePayload());

    await expect(
      service().handleWebhook({
        body,
        signature,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).rejects.toThrow("not configured");
  });

  test("treats a replay of a finished delivery as a duplicate", async () => {
    const input = signed(issuePayload());
    const first = await service().handleWebhook({
      ...input,
      deliveryId: "delivery-1",
      retryCount: null,
    });
    expect(first.outcome).toBe("PROCESSED");

    const replay = await service().handleWebhook({
      ...input,
      deliveryId: "delivery-1",
      retryCount: "1",
    });

    expect(replay.outcome).toBe("DUPLICATE");
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deliveryId: "delivery-1",
          outcome: { notIn: ["PROCESSED", "IGNORED"] },
        },
      }),
    );
    expect(jira.refreshCachedTicket).toHaveBeenCalledTimes(1);
  });

  test("reprocesses a delivery that previously failed", async () => {
    jira.refreshCachedTicket.mockRejectedValueOnce(new Error("Jira is down"));
    const input = signed(issuePayload());

    await expect(
      service().handleWebhook({
        ...input,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).rejects.toThrow("Jira is down");
    expect(deliveries.get("delivery-1")).toMatchObject({ outcome: "ERROR" });

    // Jira's own retry has to be able to redo work that never completed.
    await expect(
      service().handleWebhook({
        ...input,
        deliveryId: "delivery-1",
        retryCount: "1",
      }),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });
  });

  test("ignores events it does not map and records why", async () => {
    const { body, signature } = signed(
      issuePayload({ webhookEvent: "project_updated" }),
    );

    await expect(
      service().handleWebhook({
        body,
        signature,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).resolves.toMatchObject({ outcome: "IGNORED" });

    expect(deliveries.get("delivery-1")).toMatchObject({
      outcome: "IGNORED",
      error: "Unhandled Jira event project_updated",
    });
    expect(jira.refreshCachedTicket).not.toHaveBeenCalled();
  });

  test("deletes the cached ticket instead of refetching a deleted issue", async () => {
    const { body, signature } = signed(
      issuePayload({ webhookEvent: "jira:issue_deleted" }),
    );

    await expect(
      service().handleWebhook({
        body,
        signature,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).resolves.toMatchObject({ outcome: "PROCESSED" });

    expect(jira.deleteCachedTicket).toHaveBeenCalledWith("AIDE-42");
    expect(jira.refreshCachedTicket).not.toHaveBeenCalled();
    expect(workflowEvents.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "JIRA_ISSUE_DELETED",
        subjectKey: "AIDE-42",
        dedupeKey: "jira-webhook-trigger:delivery-1:JIRA_ISSUE_DELETED",
      }),
    );
  });

  test("records a comment as a command trigger with the author account ID", async () => {
    const { body, signature } = signed(
      issuePayload({
        webhookEvent: "comment_created",
        comment: {
          id: "20001",
          body: "/deploy",
          author: { accountId: "account-9", displayName: "Alan" },
        },
      }),
    );

    await expect(
      service().handleWebhook({
        body,
        signature,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).resolves.toMatchObject({ outcome: "PROCESSED", triggersRecorded: 1 });

    const [recorded] = workflowEvents.record.mock.calls[0]!;
    expect(recorded).toMatchObject({ kind: "JIRA_ISSUE_COMMAND" });
    // The allow-list in triggerMatches is keyed on accountId, so it has to
    // survive into the session payload.
    expect(recorded.payload.sessionData.comment).toMatchObject({
      id: "20001",
      body: "/deploy",
      author: { accountId: "account-9", displayName: "Alan" },
    });
    expect(recorded.payload.webhook).toMatchObject({
      event: "comment_created",
      deliveryId: "delivery-1",
    });
  });

  test("seeds attachment and link paths for their own trigger kinds", async () => {
    const attachment = signed(
      issuePayload({
        webhookEvent: "attachment_created",
        attachment: {
          id: "30001",
          filename: "crash.log",
          mimeType: "text/plain",
          author: { accountId: "account-9", displayName: "Alan" },
        },
      }),
    );
    await service().handleWebhook({
      ...attachment,
      deliveryId: "delivery-1",
      retryCount: null,
    });
    expect(workflowEvents.record.mock.calls[0]![0]).toMatchObject({
      kind: "JIRA_ATTACHMENT_ADDED",
      payload: {
        sessionData: {
          attachment: { filename: "crash.log", mimeType: "text/plain" },
        },
      },
    });

    workflowEvents.record.mockClear();
    const link = signed(
      issuePayload({
        webhookEvent: "issuelink_created",
        issueLink: {
          id: "40001",
          sourceIssueId: "10001",
          destinationIssueId: "10002",
          issueLinkType: { name: "Blocks" },
        },
      }),
    );
    await service().handleWebhook({
      ...link,
      deliveryId: "delivery-2",
      retryCount: null,
    });
    expect(workflowEvents.record.mock.calls[0]![0]).toMatchObject({
      kind: "JIRA_ISSUE_LINKED",
      payload: { sessionData: { link: { type: "Blocks" } } },
    });
  });

  test("ignores a payload with no issue key", async () => {
    const { body, signature } = signed({
      webhookEvent: "jira:issue_updated",
      issue: { key: "not-a-key" },
    });

    await expect(
      service().handleWebhook({
        body,
        signature,
        deliveryId: "delivery-1",
        retryCount: null,
      }),
    ).resolves.toMatchObject({ outcome: "IGNORED" });
    expect(deliveries.get("delivery-1")?.error).toBe(
      "Payload has no issue key",
    );
  });
});

describe("Jira webhook configuration", () => {
  test("returns a generated secret exactly once and marks the webhook enabled", async () => {
    mocks.getPrismaClient.mockResolvedValue({
      jiraSettings: {
        findUnique: vi.fn(async () => ({ webhookEnabled: true })),
        upsert: vi.fn(async () => ({
          webhookEnabled: true,
          webhookConfiguredAt: new Date(0),
        })),
      },
      jiraWebhookDelivery: { findFirst: vi.fn(async () => null) },
    });
    const stored: string[] = [];
    const upsert = vi.fn(async () => ({}));
    const credentials = {
      isConfigured: vi.fn(async () => true),
      setText: vi.fn(
        async (
          _descriptor: unknown,
          value: string,
          mutation: (transaction: unknown) => Promise<void>,
        ) => {
          stored.push(value);
          // The secret write and the settings write share one transaction.
          await mutation({ jiraSettings: { upsert } });
        },
      ),
    };

    const result = await new JiraWebhookService(
      {} as never,
      credentials as never,
    ).enableWebhook();

    expect(result.secret).toHaveLength(43);
    expect(stored).toEqual([result.secret]);
    expect(result.settings).toMatchObject({
      enabled: true,
      secretConfigured: true,
    });
    expect(upsert).toHaveBeenCalledOnce();
  });

  test("rejects an out-of-range delivery page", async () => {
    const service = new JiraWebhookService({} as never, {} as never);
    await expect(service.deliveries(0)).rejects.toThrow("1 to 100");
    await expect(service.deliveries(50, -1)).rejects.toThrow("non-negative");
  });
});
