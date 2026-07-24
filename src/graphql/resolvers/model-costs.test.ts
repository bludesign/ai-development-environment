import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ModelCostsService } from "@/services/model-costs";

import { createModelCostResolvers } from "./model-costs";

function context(agentId: string | null): GraphQLContext {
  return { agentId, ipAddress: "127.0.0.1" } as GraphQLContext;
}

describe("model cost resolvers", () => {
  test("waits for catalog freshness before returning metadata", async () => {
    let finishRefresh!: () => void;
    const service = {
      ensureFresh: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRefresh = resolve;
          }),
      ),
      getCatalog: vi.fn(() => "catalog"),
    } as unknown as ModelCostsService;
    const resolvers = createModelCostResolvers(service);

    const result = resolvers.Query.modelCostCatalog({}, {}, context(null));
    expect(service.getCatalog).not.toHaveBeenCalled();

    finishRefresh();
    await expect(result).resolves.toBe("catalog");
    expect(service.ensureFresh).toHaveBeenCalledOnce();
    expect(service.getCatalog).toHaveBeenCalledOnce();
  });
});
