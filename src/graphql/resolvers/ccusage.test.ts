import { describe, expect, test, vi } from "vitest";

import { emptyUsageMetrics } from "@/components/usage/aggregate-usage";
import type { CcusageService } from "@/services/ccusage";
import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";

import { createCcusageResolvers } from "./ccusage";

function context(agentId: string | null): GraphQLContext {
  return { agentId } as GraphQLContext;
}

const snapshot = {
  id: "collection-1",
  status: "COMPLETED" as const,
  createdAt: new Date(0).toISOString(),
  deadlineAt: new Date(1).toISOString(),
  finishedAt: new Date(1).toISOString(),
  progress: {
    eligibleCount: 0,
    finishedCount: 0,
    successfulCount: 0,
    agents: [],
  },
  aggregate: { days: [], totals: emptyUsageMetrics() },
};

describe("ccusage resolvers", () => {
  test("keeps collection creation in the mutation and the query read-only", async () => {
    const service = {
      initialize: vi.fn().mockResolvedValue(undefined),
      collect: vi.fn().mockResolvedValue(snapshot),
      getCollection: vi.fn().mockResolvedValue(snapshot),
      subscribe: vi.fn(),
    } as unknown as CcusageService;
    const resolvers = createCcusageResolvers(service);

    await expect(
      resolvers.Query.ccusageCollection(
        {},
        { id: "collection-1" },
        context(null),
      ),
    ).resolves.toBe(snapshot);
    expect(service.collect).not.toHaveBeenCalled();

    await expect(
      resolvers.Mutation.collectCcusage(
        {},
        { requestId: "collection-1" },
        context(null),
      ),
    ).resolves.toBe(snapshot);
    expect(service.collect).toHaveBeenCalledWith("collection-1");
  });

  test("rejects agent credentials for query, mutation, and subscription", async () => {
    const service = {} as CcusageService;
    const resolvers = createCcusageResolvers(service);
    const agentContext = context("agent-1");

    await expect(
      resolvers.Query.ccusageCollection(
        {},
        { id: "collection-1" },
        agentContext,
      ),
    ).rejects.toThrow(
      "Agent credentials cannot perform control-plane operations",
    );
    await expect(
      resolvers.Mutation.collectCcusage({}, { requestId: null }, agentContext),
    ).rejects.toThrow(
      "Agent credentials cannot perform control-plane operations",
    );
    await expect(
      resolvers.Subscription.ccusageCollectionChanged.subscribe(
        {},
        { id: "collection-1" },
        agentContext,
      ),
    ).rejects.toThrow(
      "Agent credentials cannot perform control-plane operations",
    );
  });
});
