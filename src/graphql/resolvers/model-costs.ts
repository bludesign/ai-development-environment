import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  ModelCostSortDirection,
  ModelCostSortKey,
  ModelCostsService,
} from "@/services/model-costs";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error("Agent credentials cannot read the model cost catalog");
  }
}

type UsageRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type RunRow = UsageRow & { modelUsage?: UsageRow[] };

export const createModelCostResolvers = (service: ModelCostsService) => ({
  AgentRun: {
    /**
     * Per-model rows are the accurate basis when the run has them — a run that
     * switched models mid-way is priced at each model's own rate. A run with no
     * breakdown falls back to its own model and totals, which is what an
     * imported run without usage rows carries.
     */
    catalogCost: async (value: RunRow) => {
      await service.ensureFresh();
      const rows = value.modelUsage?.length ? value.modelUsage : [value];
      const prices = await service.lookup(rows.map(({ model }) => model));
      let total = 0;
      let priced = false;
      for (const row of rows) {
        const cost = service.estimate(prices.get(row.model), row);
        if (cost === null) continue;
        total += cost;
        priced = true;
      }
      return priced ? total : null;
    },
  },
  RunModelUsage: {
    catalogCost: async (value: UsageRow) => {
      await service.ensureFresh();
      const prices = await service.lookup([value.model]);
      return service.estimate(prices.get(value.model), value);
    },
  },
  Query: {
    modelCostCatalog: async (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      await service.ensureFresh();
      return service.getCatalog();
    },
    modelCostEntries: (
      _root: unknown,
      args: {
        search?: string | null;
        first?: number | null;
        offset?: number | null;
        sortKey?: ModelCostSortKey | null;
        direction?: ModelCostSortDirection | null;
      },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.listEntries(args);
    },
  },
  Mutation: {
    saveModelCostSettings: (
      _root: unknown,
      { catalogUrl }: { catalogUrl?: string | null },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.saveSettings(catalogUrl ?? null);
    },
    refreshModelCosts: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return service.refresh();
    },
  },
});
