import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrismaClient: vi.fn() }));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: mocks.getPrismaClient,
}));

import { JIRA_WEBHOOK_PATH, JiraWebhookService } from "./jira-webhook.service";

const SECRET = "jira-webhook-secret";

type DeliveryRow = {
  deliveryId: string;
  event: string;
  issueKey: string | null;
  projectKey: string | null;
  changelogJson: string | null;
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
    changelog: {
      id: "10124",
      items: [
        {
          field: "status",
          fieldtype: "jira",
          fieldId: "status",
          from: "10000",
          fromString: "To Do",
          to: "3",
          toString: "In Review",
        },
      ],
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
        changelogJson: null,
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
    expect(jira.refreshCachedTicket).toHaveBeenCalledWith("AIDE-42", {
      id: "10124",
      items: [
        {
          field: "status",
          fieldId: "status",
          fieldType: "jira",
          from: "10000",
          fromString: "To Do",
          to: "3",
          toString: "In Review",
        },
      ],
    });
    expect(deliveries.get("delivery-1")).toMatchObject({
      outcome: "PROCESSED",
      event: "jira:issue_updated",
      issueKey: "AIDE-42",
      projectKey: "AIDE",
    });
    await expect(service().deliveries()).resolves.toMatchObject({
      items: [
        {
          changelog: {
            id: "10124",
            items: [
              {
                field: "status",
                fromString: "To Do",
                toString: "In Review",
              },
            ],
          },
        },
      ],
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

describe("Jira webhook registration", () => {
  let settingsRow: Record<string, unknown>;
  let upsert: ReturnType<typeof vi.fn>;
  let credentials: {
    isConfigured: ReturnType<typeof vi.fn>;
    setText: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let jira: { webhookApiRequest: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    settingsRow = {
      webhookEnabled: false,
      webhookConfiguredAt: null,
      webhookId: null,
      webhookUrl: null,
      webhookJql: null,
    };
    upsert = vi.fn(async ({ update }: { update: Record<string, unknown> }) => {
      Object.assign(settingsRow, update);
      return settingsRow;
    });
    mocks.getPrismaClient.mockResolvedValue({
      jiraSettings: {
        findUnique: vi.fn(async () => settingsRow),
        upsert,
      },
      jiraWebhookDelivery: { findFirst: vi.fn(async () => null) },
    });
    credentials = {
      isConfigured: vi.fn(async () => true),
      setText: vi.fn(
        async (
          _descriptor: unknown,
          _value: string,
          mutation: (transaction: unknown) => Promise<void>,
        ) => {
          await mutation({ jiraSettings: { upsert } });
        },
      ),
      delete: vi.fn(
        async (
          _descriptor: unknown,
          mutation: (transaction: unknown) => Promise<void>,
        ) => {
          await mutation({ jiraSettings: { upsert } });
        },
      ),
    };
    jira = {
      webhookApiRequest: vi.fn(async () => ({
        self: "https://team.atlassian.net/rest/webhooks/1.0/webhook/72",
      })),
    };
  });

  const service = () =>
    new JiraWebhookService(jira as never, credentials as never);

  test("creates the webhook in Jira and stores the matching secret", async () => {
    const result = await service().registerWebhook({
      url: "https://aide.example.com",
      jql: "project in (AIDE)",
    });

    expect(jira.webhookApiRequest).toHaveBeenCalledWith(
      "POST",
      "/rest/webhooks/1.0/webhook",
      expect.objectContaining({
        url: "https://aide.example.com/api/public/jira/webhook",
        // Jira keeps the old secret when a request omits it, and the delivery
        // handler needs the body, so both have to be sent every time.
        secret: result.secret,
        excludeBody: false,
        filters: { "issue-related-events-section": "project in (AIDE)" },
      }),
    );
    expect(settingsRow).toMatchObject({
      webhookEnabled: true,
      webhookId: "72",
      webhookUrl: "https://aide.example.com/api/public/jira/webhook",
      webhookJql: "project in (AIDE)",
    });
    expect(result.settings).toMatchObject({
      registered: true,
      registrationId: "72",
    });
  });

  test("updates the existing registration instead of creating a second one", async () => {
    settingsRow.webhookId = "72";
    jira.webhookApiRequest.mockResolvedValue(null);

    await service().registerWebhook({ url: "https://aide.example.com" });

    expect(jira.webhookApiRequest).toHaveBeenCalledWith(
      "PUT",
      "/rest/webhooks/1.0/webhook/72",
      expect.not.objectContaining({ filters: expect.anything() }),
    );
    expect(settingsRow.webhookId).toBe("72");
  });

  test("recreates a registration Jira no longer knows about", async () => {
    settingsRow.webhookId = "70";
    jira.webhookApiRequest
      .mockRejectedValueOnce(
        Object.assign(new Error("Jira rejected the webhook request with 404"), {
          status: 404,
        }),
      )
      .mockResolvedValueOnce({
        self: "https://team.atlassian.net/rest/webhooks/1.0/webhook/73",
      });

    await service().registerWebhook({ url: "https://aide.example.com" });

    expect(jira.webhookApiRequest.mock.calls.map(([method]) => method)).toEqual(
      ["PUT", "POST"],
    );
    expect(settingsRow.webhookId).toBe("73");
  });

  test("keeps the stored configuration when Jira rejects the registration", async () => {
    jira.webhookApiRequest.mockRejectedValue(
      Object.assign(
        new Error("Jira rejected the webhook request with 403: forbidden"),
        { status: 403 },
      ),
    );

    await expect(
      service().registerWebhook({ url: "https://aide.example.com" }),
    ).rejects.toThrow("403");
    expect(credentials.setText).not.toHaveBeenCalled();
    expect(settingsRow.webhookEnabled).toBe(false);
  });

  test("rotates the secret in Jira when the webhook is registered", async () => {
    settingsRow.webhookId = "72";
    settingsRow.webhookUrl = "https://aide.example.com/api/public/jira/webhook";
    settingsRow.webhookJql = "project in (AIDE)";
    jira.webhookApiRequest.mockResolvedValue(null);

    const result = await service().rotateSecret();

    expect(jira.webhookApiRequest).toHaveBeenCalledWith(
      "PUT",
      "/rest/webhooks/1.0/webhook/72",
      expect.objectContaining({ secret: result.secret }),
    );
  });

  test("removes the webhook from Jira when disabling", async () => {
    settingsRow.webhookId = "72";
    jira.webhookApiRequest.mockResolvedValue(null);

    await service().disableWebhook();

    expect(jira.webhookApiRequest).toHaveBeenCalledWith(
      "DELETE",
      "/rest/webhooks/1.0/webhook/72",
    );
    expect(settingsRow).toMatchObject({
      webhookEnabled: false,
      webhookId: null,
      webhookUrl: null,
    });
  });

  test("treats a webhook already deleted in Jira as disabled", async () => {
    settingsRow.webhookId = "72";
    jira.webhookApiRequest.mockRejectedValue(
      Object.assign(new Error("gone"), { status: 404 }),
    );

    await expect(service().disableWebhook()).resolves.toMatchObject({
      registered: false,
    });
  });

  test("refuses an address Jira could never deliver to", async () => {
    await expect(
      service().registerWebhook({ url: "http://localhost:3000" }),
    ).rejects.toThrow("cannot reach");
    await expect(
      service().registerWebhook({ url: "https://aide.example.com/elsewhere" }),
    ).rejects.toThrow(JIRA_WEBHOOK_PATH);
    expect(jira.webhookApiRequest).not.toHaveBeenCalled();
  });
});
