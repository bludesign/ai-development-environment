import {
  parseCcusageReport,
  type CcusageDailyEntry,
  type CcusageModelBreakdown,
  type CcusageReport,
  type CcusageTokenTotals,
} from "@ai-development-environment/agent-contract";

type NumericMetric = keyof CcusageTokenTotals;
type ModelMetric = Exclude<NumericMetric, "totalTokens" | "totalCost"> | "cost";

const NUMERIC_METRICS: NumericMetric[] = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "totalTokens",
  "totalCost",
];
const MODEL_METRICS: ModelMetric[] = [
  "inputTokens",
  "outputTokens",
  "cacheCreationTokens",
  "cacheReadTokens",
  "cost",
];

export type UsageHistoryReports = {
  archived: CcusageReport;
  live: CcusageReport;
  combined: CcusageReport;
};

export type UsageObservationCursor = {
  lastJobId: string;
  lastObservedAt: Date;
};

export function shouldApplyUsageObservation(
  current: UsageObservationCursor | null,
  next: { jobId: string; observedAt: Date },
): boolean {
  return (
    current === null ||
    (current.lastJobId !== next.jobId &&
      current.lastObservedAt <= next.observedAt)
  );
}

export function emptyCcusageReport(): CcusageReport {
  return {
    daily: [],
    totals: emptyMetrics(),
  };
}

function emptyMetrics(): CcusageTokenTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

function emptyModel(modelName: string): CcusageModelBreakdown {
  return {
    modelName,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    cost: 0,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sumReportTotals(daily: CcusageDailyEntry[]): CcusageTokenTotals {
  const totals = emptyMetrics();
  for (const entry of daily) {
    for (const metric of NUMERIC_METRICS) totals[metric] += entry[metric];
  }
  return totals;
}

function reportFromDays(days: Map<string, CcusageDailyEntry>): CcusageReport {
  const daily = [...days.values()].sort((first, second) =>
    first.period.localeCompare(second.period),
  );
  return { daily, totals: sumReportTotals(daily) };
}

function dayMap(report: CcusageReport): Map<string, CcusageDailyEntry> {
  return new Map(report.daily.map((day) => [day.period, day]));
}

function modelMap(
  day: CcusageDailyEntry | undefined,
): Map<string, CcusageModelBreakdown> {
  return new Map(
    (day?.modelBreakdowns ?? []).map((model) => [model.modelName, model]),
  );
}

function archivedMetric(
  previous: number,
  archived: number,
  next?: number,
): number {
  if (next === undefined) return archived + previous;
  return next < previous ? archived + previous : archived;
}

function mergeArchivedModel(
  archived: CcusageModelBreakdown | undefined,
  previous: CcusageModelBreakdown | undefined,
  next: CcusageModelBreakdown | undefined,
  modelName: string,
): CcusageModelBreakdown | null {
  const result = emptyModel(modelName);
  for (const metric of MODEL_METRICS) {
    result[metric] = archivedMetric(
      previous?.[metric] ?? 0,
      archived?.[metric] ?? 0,
      next?.[metric],
    );
  }
  return MODEL_METRICS.some((metric) => result[metric] > 0) ? result : null;
}

function modelValueForMetric(
  model: CcusageModelBreakdown,
  metric: NumericMetric,
): number {
  switch (metric) {
    case "totalCost":
      return model.cost;
    case "totalTokens":
      return (
        model.inputTokens +
        model.outputTokens +
        model.cacheCreationTokens +
        model.cacheReadTokens
      );
    default:
      return model[metric];
  }
}

function modelTotalForMetric(
  models: Iterable<CcusageModelBreakdown>,
  metric: NumericMetric,
): number {
  let result = 0;
  for (const model of models) result += modelValueForMetric(model, metric);
  return result;
}

function unattributedMetric(
  day: CcusageDailyEntry | undefined,
  metric: NumericMetric,
): number | undefined {
  if (!day) return undefined;
  return Math.max(
    0,
    day[metric] - modelTotalForMetric(day.modelBreakdowns, metric),
  );
}

function mergeArchivedDay(
  archived: CcusageDailyEntry | undefined,
  previous: CcusageDailyEntry | undefined,
  next: CcusageDailyEntry | undefined,
  period: string,
): CcusageDailyEntry | null {
  const archivedModels = modelMap(archived);
  const previousModels = modelMap(previous);
  const nextModels = modelMap(next);
  const modelNames = unique([
    ...archivedModels.keys(),
    ...previousModels.keys(),
    ...nextModels.keys(),
  ]);
  const modelBreakdowns = modelNames.flatMap((modelName) => {
    const model = mergeArchivedModel(
      archivedModels.get(modelName),
      previousModels.get(modelName),
      nextModels.get(modelName),
      modelName,
    );
    return model ? [model] : [];
  });
  const metrics = emptyMetrics();
  for (const metric of NUMERIC_METRICS) {
    const archivedUnattributed = unattributedMetric(archived, metric) ?? 0;
    const previousUnattributed = unattributedMetric(previous, metric) ?? 0;
    const nextUnattributed = unattributedMetric(next, metric);
    metrics[metric] =
      modelTotalForMetric(modelBreakdowns, metric) +
      archivedMetric(
        previousUnattributed,
        archivedUnattributed,
        nextUnattributed,
      );
  }
  if (
    !NUMERIC_METRICS.some((metric) => metrics[metric] > 0) &&
    modelBreakdowns.length === 0
  ) {
    return null;
  }

  return {
    ...metrics,
    agent: next?.agent ?? previous?.agent ?? archived?.agent ?? "all",
    period,
    metadata: {
      agents: unique([
        ...(archived?.metadata.agents ?? []),
        ...(previous?.metadata.agents ?? []),
        ...(next?.metadata.agents ?? []),
      ]),
    },
    modelBreakdowns,
    modelsUsed: unique([
      ...(archived?.modelsUsed ?? []),
      ...(previous?.modelsUsed ?? []),
      ...(next?.modelsUsed ?? []),
    ]),
  };
}

export function addCcusageReports(
  first: CcusageReport,
  second: CcusageReport,
): CcusageReport {
  const firstDays = dayMap(first);
  const secondDays = dayMap(second);
  const periods = unique([...firstDays.keys(), ...secondDays.keys()]);
  const days = new Map<string, CcusageDailyEntry>();

  for (const period of periods) {
    const left = firstDays.get(period);
    const right = secondDays.get(period);
    const metrics = emptyMetrics();
    for (const metric of NUMERIC_METRICS) {
      metrics[metric] = (left?.[metric] ?? 0) + (right?.[metric] ?? 0);
    }
    const leftModels = modelMap(left);
    const rightModels = modelMap(right);
    const modelNames = unique([...leftModels.keys(), ...rightModels.keys()]);
    days.set(period, {
      ...metrics,
      agent: right?.agent ?? left?.agent ?? "all",
      period,
      metadata: {
        agents: unique([
          ...(left?.metadata.agents ?? []),
          ...(right?.metadata.agents ?? []),
        ]),
      },
      modelsUsed: unique([
        ...(left?.modelsUsed ?? []),
        ...(right?.modelsUsed ?? []),
      ]),
      modelBreakdowns: modelNames.map((modelName) => {
        const leftModel = leftModels.get(modelName);
        const rightModel = rightModels.get(modelName);
        const model = emptyModel(modelName);
        for (const metric of MODEL_METRICS) {
          model[metric] =
            (leftModel?.[metric] ?? 0) + (rightModel?.[metric] ?? 0);
        }
        return model;
      }),
    });
  }
  return reportFromDays(days);
}

export function mergeCcusageHistory(
  archivedReport: CcusageReport,
  previousLiveReport: CcusageReport,
  nextLiveReport: CcusageReport,
): UsageHistoryReports {
  const archivedDays = dayMap(archivedReport);
  const previousDays = dayMap(previousLiveReport);
  const nextDays = dayMap(nextLiveReport);
  const periods = unique([
    ...archivedDays.keys(),
    ...previousDays.keys(),
    ...nextDays.keys(),
  ]);
  const days = new Map<string, CcusageDailyEntry>();
  for (const period of periods) {
    const day = mergeArchivedDay(
      archivedDays.get(period),
      previousDays.get(period),
      nextDays.get(period),
      period,
    );
    if (day) days.set(period, day);
  }
  const archived = reportFromDays(days);
  return {
    archived,
    live: nextLiveReport,
    combined: addCcusageReports(archived, nextLiveReport),
  };
}

export function parseStoredCcusageReport(value: string): CcusageReport {
  return parseCcusageReport(JSON.parse(value));
}
