import { describe, expect, test } from "vitest";

import type { UsageDayRow, UsageModelRow } from "./aggregate-usage";
import {
  buildUsageCostChartData,
  totalUsageCostForChartRow,
} from "./usage-cost-chart";

function model(modelName: string, totalCost: number): UsageModelRow {
  return {
    modelName,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost,
    agents: [],
  };
}

function day(period: string, models: UsageModelRow[]): UsageDayRow {
  return {
    period,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: models.reduce((total, item) => total + item.totalCost, 0),
    sources: [],
    models,
  };
}

describe("buildUsageCostChartData", () => {
  test("builds chronological stacked series ordered by model cost", () => {
    const result = buildUsageCostChartData([
      day("2026-07-16", [model("gpt-5", 2), model("claude", 1)]),
      day("2026-07-15", [model("gpt-5", 3)]),
    ]);

    expect(result.series).toEqual([
      { key: "model0", modelName: "gpt-5", totalCost: 5 },
      { key: "model1", modelName: "claude", totalCost: 1 },
    ]);
    expect(result.data).toEqual([
      { period: "2026-07-15", model0: 3, model1: 0 },
      { period: "2026-07-16", model0: 2, model1: 1 },
    ]);
    expect(totalUsageCostForChartRow(result.data[1], result.series)).toBe(3);
  });
});
