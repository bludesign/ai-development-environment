import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { JiraService, JiraWebhookService } from "@/services/jira";

import { createJiraResolvers } from "./jira";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("Jira resolvers", () => {
  test("forwards project search pages with defaults and rejects agent credentials", async () => {
    const service = {
      availableProjectsPage: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as JiraService;
    const resolvers = createJiraResolvers(service, {} as JiraWebhookService);

    expect(() =>
      resolvers.Query.jiraAvailableProjectPage({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(service.availableProjectsPage).not.toHaveBeenCalled();

    await resolvers.Query.jiraAvailableProjectPage({}, {}, context(null));
    expect(service.availableProjectsPage).toHaveBeenLastCalledWith(
      undefined,
      0,
      25,
    );
    await resolvers.Query.jiraAvailableProjectPage(
      {},
      { search: "OPS", startAt: 50, maxResults: 25 },
      context(null),
    );
    expect(service.availableProjectsPage).toHaveBeenLastCalledWith(
      "OPS",
      50,
      25,
    );
    await resolvers.Query.jiraAvailableProjectPage(
      {},
      { search: null, startAt: null, maxResults: null },
      context(null),
    );
    expect(service.availableProjectsPage).toHaveBeenLastCalledWith(null, 0, 25);
  });

  test("forwards explicit status overrides for All and individual sources", async () => {
    const service = {
      allTickets: vi.fn(),
      ticketBoard: vi.fn(),
    } as unknown as JiraService;
    const resolvers = createJiraResolvers(service, {} as JiraWebhookService);
    await resolvers.Query.jiraAllTickets({}, { status: "Done" }, context(null));
    expect(service.allTickets).toHaveBeenLastCalledWith(false, "Done");
    await resolvers.Mutation.refreshAllJiraTickets(
      {},
      { status: "Done" },
      context(null),
    );
    expect(service.allTickets).toHaveBeenLastCalledWith(true, "Done");
    await resolvers.Query.jiraTicketBoard(
      {},
      { sourceId: "s", status: "Done" },
      context(null),
    );
    expect(service.ticketBoard).toHaveBeenLastCalledWith("s", false, "Done");
    await resolvers.Mutation.refreshJiraSource(
      {},
      { sourceId: "s", status: "Done" },
      context(null),
    );
    expect(service.ticketBoard).toHaveBeenLastCalledWith("s", true, "Done");
  });
  test("guards aggregate operations and forwards forced refresh", async () => {
    const service = {
      allTickets: vi.fn().mockResolvedValue({ tickets: [] }),
    } as unknown as JiraService;
    const resolvers = createJiraResolvers(service, {} as JiraWebhookService);
    expect(() =>
      resolvers.Query.jiraAllTickets({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Mutation.refreshAllJiraTickets({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(service.allTickets).not.toHaveBeenCalled();
    await resolvers.Query.jiraAllTickets({}, {}, context(null));
    expect(service.allTickets).toHaveBeenLastCalledWith();
    await resolvers.Mutation.refreshAllJiraTickets({}, {}, context(null));
    expect(service.allTickets).toHaveBeenLastCalledWith(true);
  });
  test("rejects agent credentials from Jira configuration and data", () => {
    const service = {
      getSettings: vi.fn(),
      ticketBoard: vi.fn(),
      clearApiCalls: vi.fn(),
    } as unknown as JiraService;
    const webhooks = {
      getWebhookSettings: vi.fn(),
      clearDeliveries: vi.fn(),
    } as unknown as JiraWebhookService;
    const resolvers = createJiraResolvers(service, webhooks);

    expect(() =>
      resolvers.Query.jiraSettings({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.jiraTicketBoard(
        {},
        { sourceId: "source-1" },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Mutation.clearJiraApiCalls({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.jiraWebhookSettings({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Mutation.clearJiraWebhookDeliveries({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.ticketBoard).not.toHaveBeenCalled();
    expect(service.clearApiCalls).not.toHaveBeenCalled();
    expect(webhooks.getWebhookSettings).not.toHaveBeenCalled();
    expect(webhooks.clearDeliveries).not.toHaveBeenCalled();
  });

  test("passes write-only credential input to the server service", async () => {
    const safeSettings = {
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      tokenConfigured: true,
      cacheTtlSeconds: 300,
      updatedAt: new Date(0).toISOString(),
    };
    const service = {
      saveSettings: vi.fn().mockResolvedValue(safeSettings),
    } as unknown as JiraService;
    const mutation = createJiraResolvers(
      service,
      {} as unknown as JiraWebhookService,
    ).Mutation.saveJiraSettings;
    const input = {
      siteUrl: safeSettings.siteUrl,
      email: safeSettings.email,
      apiToken: "secret-token",
    };

    await expect(mutation({}, { input }, context(null))).resolves.toEqual(
      safeSettings,
    );
    expect(service.saveSettings).toHaveBeenCalledWith(input);
    expect(safeSettings).not.toHaveProperty("apiToken");
  });
});
