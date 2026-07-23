export type ModelCostEntryView = {
  model: string;
  provider: string | null;
  mode: string | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  cacheReadCostPerToken: number | null;
  cacheWriteCostPerToken: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  updatedAt: string;
};

export type ModelCostEntryPageView = {
  items: ModelCostEntryView[];
  totalCount: number;
};

export type ModelCostCatalogView = {
  /** The URL a refresh would fetch: the custom one when set, otherwise the default. */
  url: string;
  defaultUrl: string;
  /** Null while the default is in use, so the UI can show the field as unset. */
  customUrl: string | null;
  fetchedAt: string | null;
  entryCount: number;
  error: string | null;
  /** True when the catalog is missing or older than the daily refresh interval. */
  stale: boolean;
};

/** Token counts a run reports, in the shape the pricing math needs. */
export type ModelCostUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};
