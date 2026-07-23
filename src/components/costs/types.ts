export const MODEL_COST_ENTRY_FIELDS = `
  model provider mode
  inputCostPerToken outputCostPerToken
  cacheReadCostPerToken cacheWriteCostPerToken
  maxInputTokens maxOutputTokens updatedAt
`;

export const MODEL_COST_CATALOG_FIELDS = `
  url defaultUrl customUrl fetchedAt entryCount error stale
`;

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

export type ModelCostCatalogView = {
  url: string;
  defaultUrl: string;
  customUrl: string | null;
  fetchedAt: string | null;
  entryCount: number;
  error: string | null;
  stale: boolean;
};

/**
 * Catalogs quote per token; people read per million. The conversion lives here
 * rather than in the store so the number kept is the one upstream published.
 */
export function perMillion(costPerToken: number): number {
  return costPerToken * 1_000_000;
}
