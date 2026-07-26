import * as z from "zod/v4";

import type { CcusageService } from "@/services/ccusage";
import type { ModelCostsService } from "@/services/model-costs";

import {
  READ_ONLY_EXTERNAL_ANNOTATIONS,
  WRITE_ANNOTATIONS,
  WRITE_EXTERNAL_ANNOTATIONS,
  type BuiltInToolGroup,
} from "../builtin-tools";
import { serviceTool } from "./service-tool";

export function createUsageCostToolGroup(
  ccusage: CcusageService,
  modelCosts: ModelCostsService,
): BuiltInToolGroup {
  return {
    id: "builtin:usage-costs",
    name: "Usage and Costs",
    children: [],
    tools: [
      serviceTool({
        name: "collect_ccusage",
        title: "Collect ccusage",
        description:
          "Collect current local AI-provider usage from enrolled agents.",
        inputSchema: z.object({ requestId: z.string().nullable().optional() }),
        service: ccusage,
        method: "collect",
        arguments: ({ requestId }) => [requestId],
        resultKey: "collection",
        annotations: WRITE_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_ccusage_collection",
        title: "Get ccusage collection",
        description: "Get a usage collection and aggregated model usage.",
        inputSchema: z.object({ id: z.string().min(1) }),
        service: ccusage,
        method: "getCollection",
        arguments: ({ id }) => [id],
        resultKey: "collection",
      }),
      serviceTool({
        name: "get_model_cost_catalog",
        title: "Get model cost catalog",
        description:
          "Get the active model-pricing catalog and refresh metadata.",
        inputSchema: z.object({}),
        service: modelCosts,
        method: "getCatalog",
        arguments: () => [],
        resultKey: "catalog",
        annotations: READ_ONLY_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "get_model_cost_entries",
        title: "Get model cost entries",
        description: "List model-pricing entries with search and pagination.",
        inputSchema: z.object({
          search: z.string().nullable().optional(),
          first: z.number().int().min(1).max(500).default(100),
          offset: z.number().int().min(0).default(0),
          sortKey: z
            .enum(["MODEL", "PROVIDER", "INPUT", "OUTPUT", "UPDATED_AT"])
            .default("MODEL"),
          direction: z.enum(["ASC", "DESC"]).default("ASC"),
        }),
        service: modelCosts,
        method: "listEntries",
        resultKey: "page",
      }),
      serviceTool({
        name: "refresh_model_costs",
        title: "Refresh model costs",
        description:
          "Refresh the model-pricing catalog from its configured URL.",
        inputSchema: z.object({}),
        service: modelCosts,
        method: "refresh",
        arguments: () => [],
        resultKey: "catalog",
        annotations: WRITE_EXTERNAL_ANNOTATIONS,
      }),
      serviceTool({
        name: "estimate_model_cost",
        title: "Estimate model cost",
        description:
          "Estimate cost for token usage using the current model-pricing catalog.",
        inputSchema: z.object({
          model: z.string().min(1),
          inputTokens: z.number().int().min(0).default(0),
          outputTokens: z.number().int().min(0).default(0),
          cacheCreationInputTokens: z.number().int().min(0).default(0),
          cacheReadInputTokens: z.number().int().min(0).default(0),
        }),
        service: {
          estimate: async (input: Record<string, unknown>) => {
            await modelCosts.ensureFresh();
            const prices = await modelCosts.lookup([String(input.model)]);
            return modelCosts.estimate(prices.get(String(input.model)), {
              inputTokens: Number(input.inputTokens),
              outputTokens: Number(input.outputTokens),
              cacheWriteTokens: Number(input.cacheCreationInputTokens),
              cacheReadTokens: Number(input.cacheReadInputTokens),
            });
          },
        },
        method: "estimate",
        resultKey: "estimate",
      }),
    ],
  };
}
