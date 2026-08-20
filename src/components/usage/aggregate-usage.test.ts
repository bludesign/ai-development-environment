import type {
  CcusageDailyEntry,
  CcusageReport,
} from "@ai-development-environment/agent-contract";
import { describe, expect, test } from "vitest";

import {
  aggregateUsage,
  emptyUsageMetrics,
  filterUsageByAgent,
  filterUsageByDays,
  filterUsageByModel,
  highestUsageSpendWindow,
  totalsForModel,
  usagePeriodToDate,
  usageSpendPeaks,
  type UsageDayRow,
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

  test("filters inclusive rolling ranges with upper bounds and recalculates visible totals", () => {
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
          daily("2026-07-17", "gpt-5", {
            input: 1_000,
            output: 2_000,
            creation: 3_000,
            read: 4_000,
            cost: 100,
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

  test("handles exact month and year transitions", () => {
    const usage = aggregateUsage([
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([
          daily("2026-01-02", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 1,
          }),
          daily("2025-12-27", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 2,
          }),
          daily("2025-12-26", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 4,
          }),
        ]),
      },
    ]);

    expect(
      filterUsageByDays(usage, 7, "2026-01-02").days.map((day) => day.period),
    ).toEqual(["2026-01-02", "2025-12-27"]);
  });

  test("rejects malformed and impossible dates but ALL ignores the end date", () => {
    expect(() => usagePeriodToDate("2026-02-29")).toThrow(
      "valid date in YYYY-MM-DD format",
    );
    expect(() => usagePeriodToDate("2026-2-09")).toThrow(
      "valid date in YYYY-MM-DD format",
    );
    const empty = aggregateUsage([]);
    expect(() => filterUsageByDays(empty, 7, "not-a-date")).toThrow(
      "valid date in YYYY-MM-DD format",
    );
    expect(filterUsageByDays(empty, null, "not-a-date")).toBe(empty);
  });
});

describe("totalsForModel", () => {
  test("sums one model across days and leaves unattributed tokens out", () => {
    const metrics = (input: number, cost: number) => ({
      inputTokens: input,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: input,
      totalCost: cost,
    });
    const days: UsageDayRow[] = [
      {
        period: "2026-07-16",
        sources: ["codex"],
        ...metrics(30, 3),
        models: [
          { modelName: "gpt-5", agents: [], ...metrics(10, 1) },
          { modelName: "claude", agents: [], ...metrics(15, 2) },
          {
            modelName: "Unattributed tokens",
            agents: [],
            unattributed: true,
            ...metrics(5, 0),
          },
        ],
      },
      {
        period: "2026-07-15",
        sources: ["codex"],
        ...metrics(7, 0.5),
        models: [{ modelName: "gpt-5", agents: [], ...metrics(7, 0.5) }],
      },
    ];

    expect(totalsForModel(days, "gpt-5")).toEqual({
      inputTokens: 17,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 17,
      totalCost: 1.5,
    });
    expect(totalsForModel(days, "Unattributed tokens")).toEqual(
      emptyUsageMetrics(),
    );
    expect(totalsForModel(days, "missing-model")).toEqual(emptyUsageMetrics());
  });
});

describe("filterUsageByAgent", () => {
  test("keeps one agent's models, days, sources, and recalculated totals", () => {
    const usage = aggregateUsage([
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([
          daily("2026-07-16", "gpt-5", {
            input: 10,
            output: 20,
            creation: 30,
            read: 40,
            cost: 1,
          }),
          daily("2026-07-15", "small-model", {
            input: 1,
            output: 2,
            creation: 3,
            read: 4,
            cost: 0.1,
          }),
        ]),
      },
      {
        agent: { id: "agent-b", name: "Beta", hostname: "beta.local" },
        report: report([
          daily(
            "2026-07-16",
            "claude",
            { input: 5, output: 10, creation: 15, read: 20, cost: 0.5 },
            "claude-code",
          ),
        ]),
      },
    ]);

    const filtered = filterUsageByAgent(usage, "agent-b");

    expect(filtered.totals).toEqual({
      inputTokens: 5,
      outputTokens: 10,
      cacheCreationTokens: 15,
      cacheReadTokens: 20,
      totalTokens: 50,
      totalCost: 0.5,
    });
    expect(filtered.days).toHaveLength(1);
    expect(filtered.days[0]).toMatchObject({
      period: "2026-07-16",
      sources: ["claude-code"],
      models: [
        {
          modelName: "claude",
          agents: [
            expect.objectContaining({
              agentId: "agent-b",
              agentName: "Beta",
            }),
          ],
        },
      ],
    });
    expect(filterUsageByAgent(usage, "missing-agent")).toEqual({
      days: [],
      totals: emptyUsageMetrics(),
    });
  });
});

describe("spend records", () => {
  const spendUsage = () =>
    aggregateUsage([
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([
          daily("2026-01-01", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 5,
          }),
          daily("2026-01-07", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 5,
          }),
          daily("2026-02-01", "claude", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 10,
          }),
        ]),
      },
      {
        agent: { id: "agent-b", name: "Beta", hostname: "beta.local" },
        report: report([
          daily("2026-03-01", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 10,
          }),
        ]),
      },
    ]);

  test("treats missing days as zero and chooses the latest window on a tie", () => {
    expect(highestUsageSpendWindow(spendUsage(), 7)).toEqual({
      startDate: "2026-02-23",
      endDate: "2026-03-01",
      totalCost: 10,
    });
    expect(highestUsageSpendWindow(spendUsage(), 30)).toEqual({
      startDate: "2026-01-31",
      endDate: "2026-03-01",
      totalCost: 20,
    });
  });

  test("considers missing calendar dates as possible latest peak endings", () => {
    const usage = aggregateUsage([
      {
        agent: { id: "agent-a", name: "Alpha", hostname: "alpha.local" },
        report: report([
          daily("2026-01-01", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 10,
          }),
          daily("2026-01-20", "gpt-5", {
            input: 1,
            output: 0,
            creation: 0,
            read: 0,
            cost: 1,
          }),
        ]),
      },
    ]);

    expect(highestUsageSpendWindow(usage, 7)).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-01-07",
      totalCost: 10,
    });
  });

  test("returns null for empty filtered data and honors combined agent/model filters", () => {
    expect(usageSpendPeaks(spendUsage(), "missing", "gpt-5")).toEqual({
      last7Days: null,
      last30Days: null,
    });
    expect(usageSpendPeaks(spendUsage(), "agent-a", "gpt-5")).toEqual({
      last7Days: {
        startDate: "2026-01-01",
        endDate: "2026-01-07",
        totalCost: 10,
      },
      last30Days: {
        startDate: "2025-12-09",
        endDate: "2026-01-07",
        totalCost: 10,
      },
    });
    expect(filterUsageByModel(spendUsage(), "missing").days).toEqual([]);
  });
});
