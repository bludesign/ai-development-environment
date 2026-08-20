import type {
  CcusageModelBreakdown,
  CcusageReport,
  CcusageTokenTotals,
} from "@ai-development-environment/agent-contract";

export type UsageReportSource = {
  agent: {
    id: string;
    name: string;
    hostname: string;
  };
  report: CcusageReport;
};

export type UsageMetrics = CcusageTokenTotals;

export type UsageAgentRow = UsageMetrics & {
  agentId: string;
  agentName: string;
  hostname: string;
  sources: string[];
};

export type UsageModelRow = UsageMetrics & {
  modelName: string;
  agents: UsageAgentRow[];
  unattributed?: boolean;
};

export type UsageDayRow = UsageMetrics & {
  period: string;
  sources: string[];
  models: UsageModelRow[];
};

export type AggregatedUsage = {
  days: UsageDayRow[];
  totals: UsageMetrics;
};

export type UsageSpendWindow = {
  startDate: string;
  endDate: string;
  totalCost: number;
};

export type UsageSpendPeaks = {
  last7Days: UsageSpendWindow | null;
  last30Days: UsageSpendWindow | null;
};

export type UsageRangeDays = 7 | 30 | null;

type MutableAgentRow = UsageAgentRow & { sourceSet: Set<string> };
type MutableModelRow = Omit<UsageModelRow, "agents"> & {
  agents: Map<string, MutableAgentRow>;
};
type MutableDayRow = Omit<UsageDayRow, "models" | "sources"> & {
  models: Map<string | symbol, MutableModelRow>;
  sourceSet: Set<string>;
};

const UNATTRIBUTED_MODEL_KEY = Symbol("unattributed");

export function emptyUsageMetrics(): UsageMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

function addMetrics(target: UsageMetrics, source: UsageMetrics): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
}

function modelMetrics(model: CcusageModelBreakdown): UsageMetrics {
  return {
    inputTokens: model.inputTokens,
    outputTokens: model.outputTokens,
    cacheCreationTokens: model.cacheCreationTokens,
    cacheReadTokens: model.cacheReadTokens,
    totalTokens:
      model.inputTokens +
      model.outputTokens +
      model.cacheCreationTokens +
      model.cacheReadTokens,
    totalCost: model.cost,
  };
}

function addUnattributedTokens(
  day: MutableDayRow,
  agent: UsageReportSource["agent"],
  sources: string[],
  totalTokens: number,
): void {
  if (totalTokens <= 0) return;

  let model = day.models.get(UNATTRIBUTED_MODEL_KEY);
  if (!model) {
    model = {
      ...emptyUsageMetrics(),
      modelName: "Unattributed tokens",
      agents: new Map(),
      unattributed: true,
    };
    day.models.set(UNATTRIBUTED_MODEL_KEY, model);
  }
  model.totalTokens += totalTokens;

  let agentRow = model.agents.get(agent.id);
  if (!agentRow) {
    agentRow = {
      ...emptyUsageMetrics(),
      agentId: agent.id,
      agentName: agent.name,
      hostname: agent.hostname,
      sources: [],
      sourceSet: new Set(),
    };
    model.agents.set(agent.id, agentRow);
  }
  agentRow.totalTokens += totalTokens;
  sources.forEach((source) => agentRow.sourceSet.add(source));
}

function byUsage(
  first: UsageMetrics & { modelName?: string; agentName?: string },
  second: UsageMetrics & { modelName?: string; agentName?: string },
): number {
  return (
    second.totalCost - first.totalCost ||
    second.totalTokens - first.totalTokens ||
    (first.modelName ?? first.agentName ?? "").localeCompare(
      second.modelName ?? second.agentName ?? "",
    )
  );
}

export function aggregateUsage(reports: UsageReportSource[]): AggregatedUsage {
  const days = new Map<string, MutableDayRow>();
  const totals = emptyUsageMetrics();

  for (const { agent, report } of reports) {
    addMetrics(totals, report.totals);
    for (const entry of report.daily) {
      let day = days.get(entry.period);
      if (!day) {
        day = {
          ...emptyUsageMetrics(),
          period: entry.period,
          models: new Map(),
          sourceSet: new Set(),
        };
        days.set(entry.period, day);
      }
      addMetrics(day, entry);
      entry.metadata.agents.forEach((source) => day.sourceSet.add(source));

      let attributedTotalTokens = 0;
      for (const breakdown of entry.modelBreakdowns) {
        const metrics = modelMetrics(breakdown);
        attributedTotalTokens += metrics.totalTokens;
        let model = day.models.get(breakdown.modelName);
        if (!model) {
          model = {
            ...emptyUsageMetrics(),
            modelName: breakdown.modelName,
            agents: new Map(),
          };
          day.models.set(breakdown.modelName, model);
        }
        addMetrics(model, metrics);

        let agentRow = model.agents.get(agent.id);
        if (!agentRow) {
          agentRow = {
            ...emptyUsageMetrics(),
            agentId: agent.id,
            agentName: agent.name,
            hostname: agent.hostname,
            sources: [],
            sourceSet: new Set(),
          };
          model.agents.set(agent.id, agentRow);
        }
        addMetrics(agentRow, metrics);
        entry.metadata.agents.forEach((source) =>
          agentRow.sourceSet.add(source),
        );
      }
      addUnattributedTokens(
        day,
        agent,
        entry.metadata.agents,
        entry.totalTokens - attributedTotalTokens,
      );
    }
  }

  return {
    totals,
    days: [...days.values()]
      .sort((first, second) => second.period.localeCompare(first.period))
      .map((day) => ({
        inputTokens: day.inputTokens,
        outputTokens: day.outputTokens,
        cacheCreationTokens: day.cacheCreationTokens,
        cacheReadTokens: day.cacheReadTokens,
        totalTokens: day.totalTokens,
        totalCost: day.totalCost,
        period: day.period,
        sources: [...day.sourceSet].sort(),
        models: [...day.models.values()].sort(byUsage).map((model) => ({
          inputTokens: model.inputTokens,
          outputTokens: model.outputTokens,
          cacheCreationTokens: model.cacheCreationTokens,
          cacheReadTokens: model.cacheReadTokens,
          totalTokens: model.totalTokens,
          totalCost: model.totalCost,
          modelName: model.modelName,
          ...(model.unattributed ? { unattributed: true } : {}),
          agents: [...model.agents.values()].sort(byUsage).map((agent) => ({
            inputTokens: agent.inputTokens,
            outputTokens: agent.outputTokens,
            cacheCreationTokens: agent.cacheCreationTokens,
            cacheReadTokens: agent.cacheReadTokens,
            totalTokens: agent.totalTokens,
            totalCost: agent.totalCost,
            agentId: agent.agentId,
            agentName: agent.agentName,
            hostname: agent.hostname,
            sources: [...agent.sourceSet].sort(),
          })),
        })),
      })),
  };
}

export function usagePeriodForDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function usagePeriodToDate(period: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (!match) {
    throw new Error("Usage date must be a valid date in YYYY-MM-DD format");
  }

  const [, yearString, monthString, dayString] = match;
  const year = Number(yearString);
  const month = Number(monthString);
  const day = Number(dayString);
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error("Usage date must be a valid date in YYYY-MM-DD format");
  }
  return date;
}

/**
 * Totals for a single model, so a view filtered to one model can summarize the
 * same rows it is showing. Unattributed tokens belong to no model and are left
 * out, which is the split the cost chart already draws.
 */
export function totalsForModel(
  days: UsageDayRow[],
  modelName: string,
): UsageMetrics {
  const totals = emptyUsageMetrics();
  days.forEach((day) =>
    day.models.forEach((model) => {
      if (model.unattributed || model.modelName !== modelName) return;
      addMetrics(totals, model);
    }),
  );
  return totals;
}

export function filterUsageByAgent(
  usage: AggregatedUsage,
  agentId: string,
): AggregatedUsage {
  const totals = emptyUsageMetrics();
  const days = usage.days.flatMap((day) => {
    const sourceSet = new Set<string>();
    const models = day.models.flatMap((model) => {
      const agents = model.agents.filter((agent) => agent.agentId === agentId);
      if (agents.length === 0) return [];

      const metrics = emptyUsageMetrics();
      agents.forEach((agent) => {
        addMetrics(metrics, agent);
        agent.sources.forEach((source) => sourceSet.add(source));
      });
      return [
        {
          ...metrics,
          modelName: model.modelName,
          agents,
          ...(model.unattributed ? { unattributed: true } : {}),
        },
      ];
    });
    if (models.length === 0) return [];

    const metrics = emptyUsageMetrics();
    models.forEach((model) => addMetrics(metrics, model));
    addMetrics(totals, metrics);
    return [
      {
        ...metrics,
        period: day.period,
        sources: [...sourceSet].sort(),
        models,
      },
    ];
  });

  return { days, totals };
}

export function filterUsageByModel(
  usage: AggregatedUsage,
  modelName: string,
): AggregatedUsage {
  const totals = emptyUsageMetrics();
  const days = usage.days.flatMap((day) => {
    const models = day.models.filter(
      (model) => !model.unattributed && model.modelName === modelName,
    );
    if (models.length === 0) return [];

    const metrics = emptyUsageMetrics();
    const sourceSet = new Set<string>();
    models.forEach((model) => {
      addMetrics(metrics, model);
      model.agents.forEach((agent) =>
        agent.sources.forEach((source) => sourceSet.add(source)),
      );
    });
    addMetrics(totals, metrics);
    return [
      {
        ...metrics,
        period: day.period,
        sources: [...sourceSet].sort(),
        models,
      },
    ];
  });

  return { days, totals };
}

export function filterUsageByDays(
  usage: AggregatedUsage,
  days: UsageRangeDays,
  endDate: Date | string = new Date(),
): AggregatedUsage {
  if (days === null) return usage;
  const finalDate =
    typeof endDate === "string"
      ? usagePeriodToDate(endDate)
      : new Date(endDate);
  finalDate.setHours(0, 0, 0, 0);
  const cutoffDate = new Date(finalDate);
  cutoffDate.setDate(cutoffDate.getDate() - (days - 1));
  const cutoff = usagePeriodForDate(cutoffDate);
  const upperBound = usagePeriodForDate(finalDate);
  const filteredDays = usage.days.filter(
    (day) => day.period >= cutoff && day.period <= upperBound,
  );
  const totals = emptyUsageMetrics();
  filteredDays.forEach((day) => addMetrics(totals, day));
  return { days: filteredDays, totals };
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function periodOrdinal(period: string): number {
  const date = usagePeriodToDate(period);
  const utcDate = new Date(0);
  utcDate.setUTCHours(0, 0, 0, 0);
  utcDate.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(utcDate.getTime() / DAY_IN_MILLISECONDS);
}

function periodForOrdinal(ordinal: number): string {
  const date = new Date(ordinal * DAY_IN_MILLISECONDS);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function highestUsageSpendWindow(
  usage: AggregatedUsage,
  days: 7 | 30,
): UsageSpendWindow | null {
  if (usage.days.length === 0) return null;

  const entries = usage.days
    .map((day) => ({
      ordinal: periodOrdinal(day.period),
      totalCost: day.totalCost,
    }))
    .sort((first, second) => first.ordinal - second.ordinal);
  const costByOrdinal = new Map(
    entries.map((entry) => [entry.ordinal, entry.totalCost]),
  );
  const firstOrdinal = entries[0]!.ordinal;
  const lastOrdinal = entries.at(-1)!.ordinal;
  let rollingCost = 0;
  let bestEndOrdinal = firstOrdinal;
  let bestCost = Number.NEGATIVE_INFINITY;

  for (
    let endOrdinal = firstOrdinal;
    endOrdinal <= lastOrdinal;
    endOrdinal += 1
  ) {
    rollingCost += costByOrdinal.get(endOrdinal) ?? 0;
    rollingCost -= costByOrdinal.get(endOrdinal - days) ?? 0;
    if (
      rollingCost > bestCost ||
      (rollingCost === bestCost && endOrdinal > bestEndOrdinal)
    ) {
      bestCost = rollingCost;
      bestEndOrdinal = endOrdinal;
    }
  }

  return {
    startDate: periodForOrdinal(bestEndOrdinal - (days - 1)),
    endDate: periodForOrdinal(bestEndOrdinal),
    totalCost: bestCost,
  };
}

export function usageSpendPeaks(
  usage: AggregatedUsage,
  agentId?: string | null,
  modelName?: string | null,
): UsageSpendPeaks {
  const agentUsage = agentId ? filterUsageByAgent(usage, agentId) : usage;
  const filteredUsage = modelName
    ? filterUsageByModel(agentUsage, modelName)
    : agentUsage;
  return {
    last7Days: highestUsageSpendWindow(filteredUsage, 7),
    last30Days: highestUsageSpendWindow(filteredUsage, 30),
  };
}
