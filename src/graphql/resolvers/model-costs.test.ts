import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { ModelCostsService } from "@/services/model-costs";

import { createModelCostResolvers } from "./model-costs";

function context(agentId: string | null): GraphQLContext {
  return { agentId, ipAddress: "127.0.0.1" } as GraphQLContext;
}

describe("model cost resolvers", () => {
  test("does not price imported sessions without recorded usage as zero", async () => {
    const service = { ensureFresh: vi.fn() } as unknown as ModelCostsService;
    await expect(
      createModelCostResolvers(service).AgentRun.catalogCost({
        origin: "IMPORTED",
        model: "model-a",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).resolves.toBeNull();
    expect(service.ensureFresh).not.toHaveBeenCalled();
  });

  test("prices model breakdowns and withholds incomplete estimates", async () => {
    const service = {
      ensureFresh: vi.fn(),
      lookup: vi.fn().mockResolvedValue(new Map()),
      estimate: vi
        .fn()
        .mockReturnValueOnce(0.25)
        .mockReturnValueOnce(0.5)
        .mockReturnValueOnce(0.25)
        .mockReturnValueOnce(null),
    } as unknown as ModelCostsService;
    const row = {
      model: "model-a",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    };
    const run = {
      ...row,
      origin: "IMPORTED",
      modelUsage: [row, { ...row, model: "model-b" }],
    };
    const resolver = createModelCostResolvers(service).AgentRun.catalogCost;
    await expect(resolver(run)).resolves.toBe(0.75);
    await expect(resolver(run)).resolves.toBeNull();
  });

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
