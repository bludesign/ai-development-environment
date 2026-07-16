import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ToolsService } from "@/services/tools";

import { createToolsResolvers } from "./tools";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

describe("tools resolvers", () => {
  test("forwards external server CRUD for control-plane callers", async () => {
    const service = {
      externalServers: vi.fn().mockResolvedValue([]),
      createExternalServer: vi.fn().mockResolvedValue({ id: "server-1" }),
      updateExternalServer: vi.fn().mockResolvedValue({ id: "server-1" }),
      deleteExternalServer: vi.fn().mockResolvedValue({ id: "server-1" }),
    } as unknown as ToolsService;
    const resolvers = createToolsResolvers(service);
    const input = {
      name: "Example",
      url: "https://example.com/mcp",
      transport: "STREAMABLE_HTTP" as const,
      toolNamePrefix: "example_",
      headers: [],
    };

    await resolvers.Query.externalMcpServers({}, {}, context(null));
    await resolvers.Mutation.createExternalMcpServer(
      {},
      { input },
      context(null),
    );
    await resolvers.Mutation.updateExternalMcpServer(
      {},
      { id: "server-1", input },
      context(null),
    );
    await resolvers.Mutation.deleteExternalMcpServer(
      {},
      { id: "server-1" },
      context(null),
    );

    expect(service.createExternalServer).toHaveBeenCalledWith(input);
    expect(service.updateExternalServer).toHaveBeenCalledWith(
      "server-1",
      input,
    );
    expect(service.deleteExternalServer).toHaveBeenCalledWith("server-1");
  });

  test("rejects agent credentials", async () => {
    const service = { externalServers: vi.fn() } as unknown as ToolsService;
    const resolvers = createToolsResolvers(service);

    expect(() =>
      resolvers.Query.externalMcpServers({}, {}, context("agent-1")),
    ).toThrow(/cannot perform control-plane operations/);
  });
});
