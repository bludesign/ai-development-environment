import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: {
    id: "default",
    siteUrl: null as string | null,
    email: null as string | null,
    webhookEnabled: false,
    webhookConfiguredAt: null as Date | null,
    webhookId: null as string | null,
    webhookUrl: null as string | null,
    webhookJql: null as string | null,
    cacheTtlSeconds: 300,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
}));

const transaction = vi.hoisted(() => ({
  jiraProject: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  jiraCacheEntry: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  jiraCachedTicket: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  jiraWebhookDelivery: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  jiraSettings: {
    upsert: vi.fn(
      async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        Object.assign(
          state.settings,
          state.settings.createdAt ? update : create,
          { updatedAt: new Date() },
        );
        return state.settings;
      },
    ),
  },
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    ...transaction,
    jiraSettings: {
      ...transaction.jiraSettings,
      findUnique: async () => state.settings,
    },
    $transaction: async (callback: (value: unknown) => Promise<unknown>) =>
      callback(transaction),
  }),
}));

import { JiraService } from "./jira.service";

describe("Jira credential integration", () => {
  let token: string | null;
  let connection: { siteUrl: string; email: string } | null;
  let credentials: {
    isConfigured: ReturnType<typeof vi.fn>;
    getText: ReturnType<typeof vi.fn>;
    getJson: ReturnType<typeof vi.fn>;
    setMany: ReturnType<typeof vi.fn>;
    setAndDeleteMany: ReturnType<typeof vi.fn>;
    setText: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    token = null;
    connection = null;
    state.settings.siteUrl = null;
    state.settings.email = null;
    state.settings.webhookEnabled = false;
    state.settings.webhookConfiguredAt = null;
    state.settings.webhookId = null;
    state.settings.webhookUrl = null;
    state.settings.webhookJql = null;
    credentials = {
      isConfigured: vi.fn(async () => Boolean(token)),
      getText: vi.fn(async () => token),
      getJson: vi.fn(async (descriptor: { id: string }) =>
        descriptor.id.endsWith("/connection-settings") ? connection : null,
      ),
      setMany: vi.fn(
        async (
          entries: Array<{ descriptor: { id: string }; value: Uint8Array }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          for (const entry of entries) {
            if (entry.descriptor.id.endsWith("/connection-settings")) {
              connection = JSON.parse(
                Buffer.from(entry.value).toString("utf8"),
              ).value;
            } else if (entry.descriptor.id.endsWith("/api-token")) {
              token = Buffer.from(entry.value).toString("utf8");
            }
          }
          await mutation?.(transaction);
        },
      ),
      setAndDeleteMany: vi.fn(
        async (
          entries: Array<{
            descriptor: { id: string };
            value: Uint8Array;
          }>,
          _descriptors: Array<{ id: string }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          for (const entry of entries) {
            if (entry.descriptor.id.endsWith("/connection-settings")) {
              connection = JSON.parse(
                Buffer.from(entry.value).toString("utf8"),
              ).value;
            } else if (entry.descriptor.id.endsWith("/api-token")) {
              token = Buffer.from(entry.value).toString("utf8");
            }
          }
          await mutation?.(transaction);
        },
      ),
      setText: vi.fn(
        async (
          _descriptor: unknown,
          value: string,
          mutation: (value: unknown) => Promise<void>,
        ) => {
          token = value;
          await mutation(transaction);
        },
      ),
      delete: vi.fn(
        async (
          _descriptor: unknown,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          await mutation?.(transaction);
        },
      ),
      deleteMany: vi.fn(
        async (
          descriptors: Array<{ id: string }>,
          mutation?: (value: unknown) => Promise<void>,
        ) => {
          if (descriptors.some(({ id }) => id.endsWith("/api-token"))) {
            token = null;
          }
          if (
            descriptors.some(({ id }) => id.endsWith("/connection-settings"))
          ) {
            connection = null;
          }
          await mutation?.(transaction);
        },
      ),
    };
  });

  test("writes, reads, and deletes the token only through CredentialService", async () => {
    const service = new JiraService(credentials as never);
    await expect(
      service.saveSettings({
        siteUrl: "https://example.atlassian.net",
        email: "user@example.com",
        apiToken: "jira-secret",
      }),
    ).resolves.toMatchObject({ tokenConfigured: true });
    expect(credentials.setMany).toHaveBeenCalledOnce();
    expect(token).toBe("jira-secret");
    expect(state.settings).not.toHaveProperty("apiToken");

    const loaded = await (
      service as unknown as {
        requireCredentials(): Promise<{ apiToken: string }>;
      }
    ).requireCredentials();
    expect(loaded.apiToken).toBe("jira-secret");
    expect(credentials.getText).toHaveBeenCalled();

    await expect(service.clearCredentials()).resolves.toMatchObject({
      tokenConfigured: false,
    });
    // Clearing Jira credentials drops the API token and the webhook secret
    // together, so it goes through deleteMany rather than delete.
    expect(credentials.deleteMany).toHaveBeenCalledOnce();
    expect(credentials.delete).not.toHaveBeenCalled();
    expect(token).toBeNull();
    expect(connection).toBeNull();
  });

  test("clears registration metadata when changing Jira sites", async () => {
    const service = new JiraService(credentials as never);
    await service.saveSettings({
      siteUrl: "https://old.atlassian.net",
      email: "user@example.com",
      apiToken: "jira-secret",
    });
    Object.assign(state.settings, {
      webhookEnabled: true,
      webhookConfiguredAt: new Date(),
      webhookId: "72",
      webhookUrl: "https://aide.example.com/api/public/jira/webhook",
      webhookJql: "project = OLD",
    });

    await service.saveSettings({
      siteUrl: "https://new.atlassian.net",
      email: "user@example.com",
      resetSite: true,
    });

    expect(state.settings).toMatchObject({
      webhookEnabled: false,
      webhookConfiguredAt: null,
      webhookId: null,
    });
  });

  test("unregisters a Jira webhook before deleting its credentials", async () => {
    const service = new JiraService(credentials as never);
    await service.saveSettings({
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "jira-secret",
    });
    Object.assign(state.settings, {
      webhookEnabled: true,
      webhookConfiguredAt: new Date(),
      webhookId: "72",
      webhookUrl: "https://aide.example.com/api/public/jira/webhook",
      webhookJql: "project = AIDE",
    });
    const unregister = vi
      .spyOn(service, "webhookApiRequest")
      .mockResolvedValue(null);

    await service.clearCredentials();

    expect(unregister).toHaveBeenCalledWith(
      "DELETE",
      "/rest/webhooks/1.0/webhook/72",
    );
    expect(unregister.mock.invocationCallOrder[0]).toBeLessThan(
      credentials.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(state.settings).toMatchObject({
      webhookEnabled: false,
      webhookConfiguredAt: null,
      webhookId: null,
    });
  });

  test("preserves credentials when webhook cleanup fails", async () => {
    const service = new JiraService(credentials as never);
    await service.saveSettings({
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "jira-secret",
    });
    state.settings.webhookId = "72";
    vi.spyOn(service, "webhookApiRequest").mockRejectedValue(
      Object.assign(new Error("Jira unavailable"), { status: 503 }),
    );

    await expect(service.clearCredentials()).rejects.toThrow(
      "Jira unavailable",
    );
    expect(credentials.deleteMany).not.toHaveBeenCalled();
    expect(token).toBe("jira-secret");
  });
});
