export const TUNNEL_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]{0,127}";
export const TUNNEL_NAME_REGEX = new RegExp(`^${TUNNEL_NAME_PATTERN}$`);

export const CCUSAGE_REPORT_JOB_KIND = "ccusage.report";

export type CcusageTokenTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
};

export type CcusageModelBreakdown = {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
};

export type CcusageDailyEntry = CcusageTokenTotals & {
  agent: string;
  period: string;
  metadata: {
    agents: string[];
  };
  modelBreakdowns: CcusageModelBreakdown[];
  modelsUsed: string[];
};

export type CcusageReport = {
  daily: CcusageDailyEntry[];
  totals: CcusageTokenTotals;
};

export type CcusageJobResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  report: CcusageReport;
};

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function numericValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => stringValue(item, `${name}[${index}]`));
}

function tokenTotals(value: JsonObject, name: string): CcusageTokenTotals {
  return {
    inputTokens: numericValue(value.inputTokens, `${name}.inputTokens`),
    outputTokens: numericValue(value.outputTokens, `${name}.outputTokens`),
    cacheCreationTokens: numericValue(
      value.cacheCreationTokens,
      `${name}.cacheCreationTokens`,
    ),
    cacheReadTokens: numericValue(
      value.cacheReadTokens,
      `${name}.cacheReadTokens`,
    ),
    totalTokens: numericValue(value.totalTokens, `${name}.totalTokens`),
    totalCost: numericValue(value.totalCost, `${name}.totalCost`),
  };
}

function modelBreakdown(value: unknown, name: string): CcusageModelBreakdown {
  const model = objectValue(value, name);
  return {
    modelName: stringValue(model.modelName, `${name}.modelName`),
    inputTokens: numericValue(model.inputTokens, `${name}.inputTokens`),
    outputTokens: numericValue(model.outputTokens, `${name}.outputTokens`),
    cacheCreationTokens: numericValue(
      model.cacheCreationTokens,
      `${name}.cacheCreationTokens`,
    ),
    cacheReadTokens: numericValue(
      model.cacheReadTokens,
      `${name}.cacheReadTokens`,
    ),
    cost: numericValue(model.cost, `${name}.cost`),
  };
}

function dailyEntry(value: unknown, index: number): CcusageDailyEntry {
  const name = `ccusage.daily[${index}]`;
  const entry = objectValue(value, name);
  const metadata = objectValue(entry.metadata, `${name}.metadata`);
  if (!Array.isArray(entry.modelBreakdowns)) {
    throw new Error(`${name}.modelBreakdowns must be an array`);
  }
  const period = stringValue(entry.period, `${name}.period`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    throw new Error(`${name}.period must use YYYY-MM-DD`);
  }
  return {
    ...tokenTotals(entry, name),
    agent: stringValue(entry.agent, `${name}.agent`),
    period,
    metadata: {
      agents: stringArray(metadata.agents, `${name}.metadata.agents`),
    },
    modelBreakdowns: entry.modelBreakdowns.map((model, modelIndex) =>
      modelBreakdown(model, `${name}.modelBreakdowns[${modelIndex}]`),
    ),
    modelsUsed: stringArray(entry.modelsUsed, `${name}.modelsUsed`),
  };
}

export function parseCcusageReport(value: unknown): CcusageReport {
  const report = objectValue(value, "ccusage report");
  if (!Array.isArray(report.daily)) {
    throw new Error("ccusage.daily must be an array");
  }
  return {
    daily: report.daily.map((entry, index) => dailyEntry(entry, index)),
    totals: tokenTotals(
      objectValue(report.totals, "ccusage.totals"),
      "ccusage.totals",
    ),
  };
}

export function parseCcusageJobResult(value: unknown): CcusageJobResult {
  const result = objectValue(value, "ccusage job result");
  if (
    result.exitCode !== null &&
    (typeof result.exitCode !== "number" || !Number.isInteger(result.exitCode))
  ) {
    throw new Error("ccusage job result.exitCode must be an integer or null");
  }
  if (result.signal !== null && typeof result.signal !== "string") {
    throw new Error("ccusage job result.signal must be a string or null");
  }
  if (typeof result.timedOut !== "boolean") {
    throw new Error("ccusage job result.timedOut must be a boolean");
  }
  if (typeof result.cancelled !== "boolean") {
    throw new Error("ccusage job result.cancelled must be a boolean");
  }
  return {
    exitCode: result.exitCode as number | null,
    signal: result.signal as string | null,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    report: parseCcusageReport(result.report),
  };
}
