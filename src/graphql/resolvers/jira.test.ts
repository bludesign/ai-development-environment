import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { JiraService } from "@/services/jira";

import { createJiraResolvers } from "./jira";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("Jira resolvers", () => {
  test("rejects agent credentials from Jira configuration and data", () => {
    const service = {
      getSettings: vi.fn(),
      ticketBoard: vi.fn(),
    } as unknown as JiraService;
    const resolvers = createJiraResolvers(service);

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
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.ticketBoard).not.toHaveBeenCalled();
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
    const mutation = createJiraResolvers(service).Mutation.saveJiraSettings;
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
