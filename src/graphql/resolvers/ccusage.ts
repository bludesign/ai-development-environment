import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import {
  CcusageService,
  type CcusageCollectionSnapshot,
} from "@/services/ccusage";
import {
  filterUsageByDays,
  type UsageRangeDays,
} from "@/components/usage/aggregate-usage";

type CcusageRange = "ALL" | "LAST_7_DAYS" | "LAST_30_DAYS";

const RANGE_DAYS: Record<CcusageRange, UsageRangeDays> = {
  ALL: null,
  LAST_7_DAYS: 7,
  LAST_30_DAYS: 30,
};

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createCcusageResolvers = (ccusageService: CcusageService) => ({
  CcusageCollection: {
    aggregate: (
      collection: CcusageCollectionSnapshot,
      { range = "ALL" }: { range?: CcusageRange },
    ) => filterUsageByDays(collection.aggregate, RANGE_DAYS[range]),
  },
  CcusageModelUsage: {
    unattributed: (model: { unattributed?: boolean }) =>
      model.unattributed ?? false,
  },
  Query: {
    ccusageCollection: async (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      await ccusageService.initialize();
      return ccusageService.getCollection(id);
    },
  },
  Mutation: {
    collectCcusage: async (
      _root: unknown,
      { requestId }: { requestId?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      await ccusageService.initialize();
      return ccusageService.collect(requestId);
    },
  },
  Subscription: {
    ccusageCollectionChanged: {
      subscribe: async (
        _root: unknown,
        { id }: { id: string },
        context: GraphQLContext,
      ) => {
        requireControlPlane(context);
        await ccusageService.initialize();
        return ccusageService.subscribe(id);
      },
      resolve: (snapshot: CcusageCollectionSnapshot) => snapshot,
    },
  },
});
