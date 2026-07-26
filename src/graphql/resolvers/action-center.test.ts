import { describe, expect, test, vi } from "vitest";

import type { ActionCenterService } from "@/services/action-center";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createActionCenterResolvers } from "./action-center";

function context(agentId: string | null): GraphQLContext {
  return {
    agentId,
    ipAddress: null,
    requestOrigin: null,
    prismaService: {} as GraphQLContext["prismaService"],
    agentControlService: {} as GraphQLContext["agentControlService"],
  };
}

describe("Action Center resolvers", () => {
  test("delegates control-plane queries and acknowledgements", async () => {
    const list = vi.fn().mockResolvedValue({ items: [], totalCount: 0 });
    const acknowledge = vi.fn().mockResolvedValue(true);
    const service = { list, acknowledge } as unknown as ActionCenterService;
    const resolvers = createActionCenterResolvers(service);

    await expect(
      resolvers.Query.actionCenter({}, { first: 25 }, context(null)),
    ).resolves.toMatchObject({ totalCount: 0 });
    await expect(
      resolvers.Mutation.acknowledgeActionCenterItem(
        {},
        {
          input: {
            resourceKind: "BUILD",
            resourceId: "build-1",
            failureFingerprint: "fingerprint",
          },
        },
        context(null),
      ),
    ).resolves.toBe(true);
    expect(list).toHaveBeenCalledWith({ first: 25 });
    expect(acknowledge).toHaveBeenCalledWith({
      resourceKind: "BUILD",
      resourceId: "build-1",
      failureFingerprint: "fingerprint",
    });
  });

  test("rejects agent credentials", async () => {
    const service = {
      list: vi.fn(),
      acknowledge: vi.fn(),
    } as unknown as ActionCenterService;
    const resolvers = createActionCenterResolvers(service);

    expect(() =>
      resolvers.Query.actionCenter({}, {}, context("agent-1")),
    ).toThrow("Agent credentials");
    expect(() =>
      resolvers.Mutation.acknowledgeActionCenterItem(
        {},
        {
          input: {
            resourceKind: "BUILD",
            resourceId: "build-1",
            failureFingerprint: "fingerprint",
          },
        },
        context("agent-1"),
      ),
    ).toThrow("Agent credentials");
  });
});
