import type {
  CcusageDailyEntry,
  CcusageReport,
} from "@ai-development-environment/agent-contract";
import { describe, expect, test } from "vitest";

import {
  aggregateUsage,
  filterUsageByDays,
  type UsageReportSource,
} from "./aggregate-usage";

function daily(
  period: string,
  modelName: string,
  values: {
    input: number;
    output: number;
    creation: number;
    read: number;
    cost: number;
  },
  source = "codex",
): CcusageDailyEntry {
  const totalTokens =
    values.input + values.output + values.creation + values.read;
  return {
    agent: "all",
    period,
    inputTokens: values.input,
    outputTokens: values.output,
    cacheCreationTokens: values.creation,
    cacheReadTokens: values.read,
    totalTokens,
    totalCost: values.cost,
    metadata: { agents: [source] },
    modelsUsed: [modelName],
    modelBreakdowns: [
      {
        modelName,
        inputTokens: values.input,
        outputTokens: values.output,
        cacheCreationTokens: values.creation,
        cacheReadTokens: values.read,
        cost: values.cost,
      },
    ],
  };
}

function report(entries: CcusageDailyEntry[]): CcusageReport {
  return {
    daily: entries,
    totals: entries.reduce(
      (total, entry) => ({
        inputTokens: total.inputTokens + entry.inputTokens,
        outputTokens: total.outputTokens + entry.outputTokens,
        cacheCreationTokens:
          total.cacheCreationTokens + entry.cacheCreationTokens,
        cacheReadTokens: total.cacheReadTokens + entry.cacheReadTokens,
        totalTokens: total.totalTokens + entry.totalTokens,
        totalCost: total.totalCost + entry.totalCost,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      },
    ),
  };
}

describe("aggregateUsage", () => {
  test("merges dates and models while retaining per-Mac totals and ordering", () => {
    const reports: UsageReportSource[] = [
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([
          daily("2026-07-15", "small-model", {
            input: 1,
            output: 2,
            creation: 3,
            read: 4,
            cost: 0.1,
          }),
          daily("2026-07-16", "gpt-5", {
            input: 10,
            output: 20,
            creation: 30,
            read: 40,
            cost: 1,
          }),
        ]),
      },
      {
        agent: { id: "agent-b", name: "Beta", hostname: "beta.local" },
        report: report([
          daily(
            "2026-07-16",
            "gpt-5",
            { input: 5, output: 10, creation: 15, read: 20, cost: 0.5 },
            "claude",
          ),
        ]),
      },
    ];

    const usage = aggregateUsage(reports);

    expect(usage.days.map((day) => day.period)).toEqual([
      "2026-07-16",
      "2026-07-15",
    ]);
    expect(usage.days[0]).toMatchObject({
      inputTokens: 15,
      outputTokens: 30,
      cacheCreationTokens: 45,
      cacheReadTokens: 60,
      totalTokens: 150,
      totalCost: 1.5,
      sources: ["claude", "codex"],
    });
    expect(usage.days[0]?.models[0]).toMatchObject({
      modelName: "gpt-5",
      totalTokens: 150,
      totalCost: 1.5,
    });
    expect(usage.days[0]?.models[0]?.agents).toEqual([
      expect.objectContaining({
        agentId: "agent-a",
        agentName: "Alpha",
        totalTokens: 100,
      }),
      expect.objectContaining({
        agentId: "agent-b",
        agentName: "Beta",
        totalTokens: 50,
      }),
    ]);
    expect(usage.totals).toEqual({
      inputTokens: 16,
      outputTokens: 32,
      cacheCreationTokens: 48,
      cacheReadTokens: 64,
      totalTokens: 160,
      totalCost: 1.6,
    });
  });

  test("returns zero totals and no rows for empty reports", () => {
    expect(aggregateUsage([])).toEqual({
      days: [],
      totals: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      },
    });
  });

  test("preserves daily tokens omitted from model breakdowns as unattributed", () => {
    const entry = daily("2026-07-16", "gpt-5", {
      input: 10,
      output: 20,
      creation: 30,
      read: 40,
      cost: 1,
    });
    entry.totalTokens = 125;

    const usage = aggregateUsage([
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([entry]),
      },
    ]);

    expect(usage.days[0]?.totalTokens).toBe(125);
    expect(usage.totals.totalTokens).toBe(125);
    expect(
      usage.days[0]?.models.reduce(
        (total, model) => total + model.totalTokens,
        0,
      ),
    ).toBe(125);
    expect(usage.days[0]?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          unattributed: true,
          totalTokens: 25,
          agents: [
            expect.objectContaining({
              agentId: "agent-a",
              totalTokens: 25,
            }),
          ],
        }),
      ]),
    );
  });

  test("filters inclusive rolling ranges and recalculates visible totals", () => {
    const usage = aggregateUsage([
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([
          daily("2026-07-10", "gpt-5", {
            input: 1,
            output: 2,
            creation: 3,
            read: 4,
            cost: 0.1,
          }),
          daily("2026-07-09", "gpt-5", {
            input: 10,
            output: 20,
            creation: 30,
            read: 40,
            cost: 1,
          }),
          daily("2026-06-16", "gpt-5", {
            input: 100,
            output: 200,
            creation: 300,
            read: 400,
            cost: 10,
          }),
        ]),
      },
    ]);

    const sevenDays = filterUsageByDays(usage, 7, new Date(2026, 6, 16));
    expect(sevenDays.days.map((day) => day.period)).toEqual(["2026-07-10"]);
    expect(sevenDays.totals).toMatchObject({ totalTokens: 10, totalCost: 0.1 });

    const thirtyDays = filterUsageByDays(usage, 30, new Date(2026, 6, 16));
    expect(thirtyDays.days.map((day) => day.period)).toEqual([
      "2026-07-10",
      "2026-07-09",
    ]);
    expect(thirtyDays.totals).toMatchObject({
      totalTokens: 110,
      totalCost: 1.1,
    });
    expect(filterUsageByDays(usage, null)).toBe(usage);
  });
});
