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

function localPeriod(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function filterUsageByDays(
  usage: AggregatedUsage,
  days: UsageRangeDays,
  today = new Date(),
): AggregatedUsage {
  if (days === null) return usage;
  const cutoffDate = new Date(today);
  cutoffDate.setHours(0, 0, 0, 0);
  cutoffDate.setDate(cutoffDate.getDate() - (days - 1));
  const cutoff = localPeriod(cutoffDate);
  const filteredDays = usage.days.filter((day) => day.period >= cutoff);
  const totals = emptyUsageMetrics();
  filteredDays.forEach((day) => addMetrics(totals, day));
  return { days: filteredDays, totals };
}
