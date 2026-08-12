import type { CcusageReport } from "@ai-development-environment/agent-contract";
import { describe, expect, test } from "vitest";

import {
  emptyCcusageReport,
  mergeCcusageHistory,
  shouldApplyUsageObservation,
} from "./usage-history";

function report(
  inputTokens: number,
  options: { period?: string; model?: string; cost?: number } = {},
): CcusageReport {
  const period = options.period ?? "2026-08-12";
  const modelName = options.model ?? "claude-sonnet";
  const totalCost = options.cost ?? inputTokens / 100;
  return {
    daily: [
      {
        agent: "claude-code",
        period,
        inputTokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: inputTokens,
        totalCost,
        metadata: { agents: ["claude-code"] },
        modelBreakdowns: [
          {
            modelName,
            inputTokens,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            cost: totalCost,
          },
        ],
        modelsUsed: [modelName],
      },
    ],
    totals: {
      inputTokens,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: inputTokens,
      totalCost,
    },
  };
}

function multiModelReport(
  models: Array<{ name: string; inputTokens: number }>,
  unattributedInputTokens = 0,
): CcusageReport {
  const modelInputTokens = models.reduce(
    (total, model) => total + model.inputTokens,
    0,
  );
  const inputTokens = modelInputTokens + unattributedInputTokens;
  return {
    daily: [
      {
        agent: "claude-code",
        period: "2026-08-12",
        inputTokens,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalTokens: inputTokens,
        totalCost: inputTokens / 100,
        metadata: { agents: ["claude-code"] },
        modelBreakdowns: models.map((model) => ({
          modelName: model.name,
          inputTokens: model.inputTokens,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          cost: model.inputTokens / 100,
        })),
        modelsUsed: models.map((model) => model.name),
      },
    ],
    totals: {
      inputTokens,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: inputTokens,
      totalCost: inputTokens / 100,
    },
  };
}

describe("usage history merging", () => {
  test("ignores duplicate jobs and out-of-order observations", () => {
    const current = {
      lastJobId: "job-current",
      lastObservedAt: new Date("2026-08-12T12:00:00Z"),
    };

    expect(
      shouldApplyUsageObservation(current, {
        jobId: "job-current",
        observedAt: new Date("2026-08-12T12:01:00Z"),
      }),
    ).toBe(false);
    expect(
      shouldApplyUsageObservation(current, {
        jobId: "job-older",
        observedAt: new Date("2026-08-12T11:59:59Z"),
      }),
    ).toBe(false);
    expect(
      shouldApplyUsageObservation(current, {
        jobId: "job-next",
        observedAt: new Date("2026-08-12T12:00:01Z"),
      }),
    ).toBe(true);
  });

  test("uses the first live report as the baseline", () => {
    const next = report(100);
    const merged = mergeCcusageHistory(
      emptyCcusageReport(),
      emptyCcusageReport(),
      next,
    );

    expect(merged.archived.daily).toEqual([]);
    expect(merged.combined.totals.inputTokens).toBe(100);
  });

  test("does not double count monotonic cumulative reports", () => {
    const merged = mergeCcusageHistory(
      emptyCcusageReport(),
      report(100),
      report(150),
    );

    expect(merged.archived.daily).toEqual([]);
    expect(merged.combined.totals.inputTokens).toBe(150);
  });

  test("adds a reset report as a new usage epoch", () => {
    const merged = mergeCcusageHistory(
      emptyCcusageReport(),
      report(100),
      report(20),
    );

    expect(merged.archived.totals.inputTokens).toBe(100);
    expect(merged.combined.totals.inputTokens).toBe(120);
    expect(merged.combined.totals.totalCost).toBeCloseTo(1.2);
  });

  test("archives missing days and adds them again if they reappear", () => {
    const missing = mergeCcusageHistory(
      emptyCcusageReport(),
      report(100),
      emptyCcusageReport(),
    );
    const reappeared = mergeCcusageHistory(
      missing.archived,
      missing.live,
      report(25),
    );

    expect(missing.combined.totals.inputTokens).toBe(100);
    expect(reappeared.combined.totals.inputTokens).toBe(125);
  });

  test("tracks model resets independently", () => {
    const first = report(100, { model: "claude-sonnet" });
    const second = report(100, { model: "claude-opus" });
    const merged = mergeCcusageHistory(emptyCcusageReport(), first, second);

    expect(merged.combined.daily[0]?.modelBreakdowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelName: "claude-sonnet",
          inputTokens: 100,
        }),
        expect.objectContaining({ modelName: "claude-opus", inputTokens: 100 }),
      ]),
    );
  });

  test("keeps day totals aligned when one model resets and another grows", () => {
    const previous = multiModelReport([
      { name: "claude-sonnet", inputTokens: 100 },
      { name: "claude-opus", inputTokens: 50 },
    ]);
    const next = multiModelReport([
      { name: "claude-sonnet", inputTokens: 20 },
      { name: "claude-opus", inputTokens: 200 },
    ]);

    const merged = mergeCcusageHistory(emptyCcusageReport(), previous, next);

    expect(merged.archived.totals.inputTokens).toBe(100);
    expect(merged.combined.totals.inputTokens).toBe(320);
    expect(
      merged.combined.daily[0]?.modelBreakdowns.reduce(
        (total, model) => total + model.inputTokens,
        0,
      ),
    ).toBe(320);
  });

  test("tracks resets in unattributed usage", () => {
    const previous = multiModelReport(
      [{ name: "claude-sonnet", inputTokens: 50 }],
      100,
    );
    const next = multiModelReport(
      [{ name: "claude-sonnet", inputTokens: 75 }],
      20,
    );

    const merged = mergeCcusageHistory(emptyCcusageReport(), previous, next);

    expect(merged.archived.totals.inputTokens).toBe(100);
    expect(merged.combined.totals.inputTokens).toBe(195);
    expect(merged.combined.daily[0]?.modelBreakdowns[0]?.inputTokens).toBe(75);
  });
});
