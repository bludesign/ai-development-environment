import { describe, expect, test, vi } from "vitest";

import type { AppsService } from "@/services/apps";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createAppResolvers } from "./apps";

describe("app resolvers", () => {
  test("routes control-plane CRUD calls to the service", async () => {
    const created = {
      id: "app-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const service = {
      list: vi.fn().mockResolvedValue([created]),
      create: vi.fn().mockResolvedValue(created),
    } as unknown as AppsService;
    const resolvers = createAppResolvers(service);
    const context = { agentId: null } as GraphQLContext;
    const input = { name: "Console", repositoryIds: ["repository-1"] };

    await expect(resolvers.Query.apps({}, {}, context)).resolves.toEqual([
      created,
    ]);
    await expect(
      resolvers.Mutation.createApp({}, { input }, context),
    ).resolves.toBe(created);
    expect(service.create).toHaveBeenCalledWith(input);
    expect(resolvers.App.createdAt(created)).toBe(
      created.createdAt.toISOString(),
    );
  });

  test("rejects app management calls authenticated as an agent", () => {
    const service = { list: vi.fn() } as unknown as AppsService;
    const resolvers = createAppResolvers(service);
    expect(() =>
      resolvers.Query.apps({}, {}, { agentId: "agent-1" } as GraphQLContext),
    ).toThrow("Agent credentials cannot perform control-plane operations");
  });
});
