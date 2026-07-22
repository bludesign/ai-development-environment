import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: {
    id: "default",
    siteUrl: null as string | null,
    email: null as string | null,
    cacheTtlSeconds: 300,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  },
}));

const transaction = vi.hoisted(() => ({
  jiraProject: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  jiraCacheEntry: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  jiraCachedTicket: { deleteMany: vi.fn(async () => ({ count: 0 })) },
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
  let credentials: {
    isConfigured: ReturnType<typeof vi.fn>;
    getText: ReturnType<typeof vi.fn>;
    setText: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    token = null;
    state.settings.siteUrl = null;
    state.settings.email = null;
    credentials = {
      isConfigured: vi.fn(async () => Boolean(token)),
      getText: vi.fn(async () => token),
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
          mutation: (value: unknown) => Promise<void>,
        ) => {
          token = null;
          await mutation(transaction);
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
    expect(credentials.setText).toHaveBeenCalledOnce();
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
    expect(credentials.delete).toHaveBeenCalledOnce();
    expect(token).toBeNull();
    expect(state.settings.email).toBeNull();
  });
});
