import { describe, expect, test, vi } from "vitest";

import {
  emptyUsageMetrics,
  type AggregatedUsage,
} from "@/components/usage/aggregate-usage";
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
  liveAggregate: { days: [], totals: emptyUsageMetrics() },
  hasStoredHistory: false,
};

function usage(
  entries: Array<{
    period: string;
    cost: number;
    agentId?: string;
    modelName?: string;
  }>,
): AggregatedUsage {
  const metrics = (cost: number) => ({
    ...emptyUsageMetrics(),
    totalTokens: 1,
    totalCost: cost,
  });
  return {
    days: entries.map(
      ({ period, cost, agentId = "agent-a", modelName = "gpt-5" }) => ({
        period,
        sources: ["codex"],
        ...metrics(cost),
        models: [
          {
            modelName,
            ...metrics(cost),
            agents: [
              {
                agentId,
                agentName: agentId,
                hostname: `${agentId}.local`,
                sources: ["codex"],
                ...metrics(cost),
              },
            ],
          },
        ],
      }),
    ),
    totals: entries.reduce((totals, entry) => {
      totals.totalTokens += 1;
      totals.totalCost += entry.cost;
      return totals;
    }, emptyUsageMetrics()),
  };
}

describe("ccusage resolvers", () => {
  test("keeps collection creation in the mutation and the query read-only", async () => {
    const service = {
      initialize: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(snapshot),
      clearHistory: vi.fn().mockResolvedValue(0),
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
    expect(service.start).not.toHaveBeenCalled();

    await expect(
      resolvers.Mutation.collectCcusage(
        {},
        { requestId: "collection-1" },
        context(null),
      ),
    ).resolves.toBe(snapshot);
    expect(service.start).toHaveBeenCalledWith("collection-1");
  });

  test("resolves bare collection snapshots from the progress subscription", () => {
    const resolvers = createCcusageResolvers({} as CcusageService);

    expect(
      resolvers.Subscription.ccusageCollectionChanged.resolve(snapshot),
    ).toBe(snapshot);
  });

  test("selects historical or live aggregate and clears history", async () => {
    const historical = {
      days: [],
      totals: { ...emptyUsageMetrics(), totalCost: 4 },
    };
    const live = {
      days: [],
      totals: { ...emptyUsageMetrics(), totalCost: 1 },
    };
    const collection = {
      ...snapshot,
      aggregate: historical,
      liveAggregate: live,
    };
    const service = {
      initialize: vi.fn().mockResolvedValue(undefined),
      clearHistory: vi.fn().mockResolvedValue(2),
    } as unknown as CcusageService;
    const resolvers = createCcusageResolvers(service);

    expect(
      resolvers.CcusageCollection.aggregate(collection, {
        range: "ALL",
        includeHistory: true,
      }).totals.totalCost,
    ).toBe(4);
    expect(
      resolvers.CcusageCollection.aggregate(collection, {
        range: "ALL",
        includeHistory: false,
      }).totals.totalCost,
    ).toBe(1);
    await expect(
      resolvers.Mutation.clearCcusageHistory({}, {}, context(null)),
    ).resolves.toBe(2);
  });

  test("defaults to ALL and applies inclusive end-date windows only to bounded ranges", () => {
    const historical = usage([
      { period: "2026-01-01", cost: 1 },
      { period: "2026-01-07", cost: 2 },
      { period: "2026-01-08", cost: 4 },
    ]);
    const collection = { ...snapshot, aggregate: historical };
    const resolvers = createCcusageResolvers({} as CcusageService);

    expect(
      resolvers.CcusageCollection.aggregate(collection, {}).days.map(
        (day) => day.period,
      ),
    ).toEqual(["2026-01-01", "2026-01-07", "2026-01-08"]);
    expect(
      resolvers.CcusageCollection.aggregate(collection, {
        range: "LAST_7_DAYS",
        endDate: "2026-01-07",
      }).days.map((day) => day.period),
    ).toEqual(["2026-01-01", "2026-01-07"]);
    expect(() =>
      resolvers.CcusageCollection.aggregate(collection, {
        range: "LAST_7_DAYS",
        endDate: "2026-02-30",
      }),
    ).toThrow("valid date in YYYY-MM-DD format");
    expect(() =>
      resolvers.CcusageCollection.aggregate(collection, {
        range: "ALL",
        endDate: "ignored",
      }),
    ).not.toThrow();
  });

  test("returns spend peaks from all dates while honoring history, agent, and model filters", () => {
    const historical = usage([
      { period: "2026-01-01", cost: 3, agentId: "agent-a" },
      { period: "2026-01-07", cost: 4, agentId: "agent-a" },
      {
        period: "2026-02-01",
        cost: 20,
        agentId: "agent-b",
        modelName: "claude",
      },
    ]);
    const live = usage([{ period: "2026-03-01", cost: 2, agentId: "agent-a" }]);
    const collection = {
      ...snapshot,
      aggregate: historical,
      liveAggregate: live,
    };
    const resolvers = createCcusageResolvers({} as CcusageService);

    expect(
      resolvers.CcusageCollection.spendPeaks(collection, {
        includeHistory: true,
        agentId: "agent-a",
        modelName: "gpt-5",
      }).last7Days,
    ).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      totalCost: 7,
    });
    expect(
      resolvers.CcusageCollection.spendPeaks(collection, {
        includeHistory: false,
        agentId: "agent-a",
        modelName: "gpt-5",
      }).last7Days?.totalCost,
    ).toBe(2);
    expect(
      resolvers.CcusageCollection.spendPeaks(collection, {
        includeHistory: true,
        agentId: "missing",
      }),
    ).toEqual({ last7Days: null, last30Days: null });
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
      resolvers.Mutation.clearCcusageHistory({}, {}, agentContext),
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
