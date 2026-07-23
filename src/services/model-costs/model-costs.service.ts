import "server-only";

import { getPrismaClient } from "@/data/prisma-client";

import type {
  ModelCostCatalogView,
  ModelCostEntryPageView,
  ModelCostEntryView,
  ModelCostUsage,
} from "./types";

const SETTINGS_ID = "default";

/**
 * LiteLLM publishes the one catalog that covers every provider this app drives,
 * so it is the default rather than a suggestion the reader has to go find.
 */
export const DEFAULT_MODEL_COST_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json";

/** Published prices move on the order of weeks, so a daily fetch is generous. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_ENTRIES = 20_000;
const WRITE_CHUNK = 500;

/** The upstream file carries a documentation stub alongside the real models. */
const SPEC_KEYS = new Set(["sample_spec"]);

type RawEntry = Record<string, unknown>;

type ParsedEntry = {
  model: string;
  provider: string | null;
  mode: string | null;
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  cacheReadCostPerToken: number | null;
  cacheWriteCostPerToken: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
};

type StoredEntry = ParsedEntry & { updatedAt: Date };

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = number(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The catalog is a flat map of model id to a loosely-typed record; only the
 * fields this app prices from are lifted out, and a record missing both token
 * prices is dropped rather than stored as a row that can never price anything.
 */
function parseCatalog(payload: unknown): ParsedEntry[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("The model cost catalog is not a JSON object");
  }
  const entries: ParsedEntry[] = [];
  for (const [model, raw] of Object.entries(payload as RawEntry)) {
    if (SPEC_KEYS.has(model)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as RawEntry;
    const inputCostPerToken = number(record.input_cost_per_token);
    const outputCostPerToken = number(record.output_cost_per_token);
    if (inputCostPerToken === null && outputCostPerToken === null) continue;
    entries.push({
      model,
      provider: text(record.litellm_provider),
      mode: text(record.mode),
      inputCostPerToken,
      outputCostPerToken,
      cacheReadCostPerToken: number(record.cache_read_input_token_cost),
      cacheWriteCostPerToken: number(record.cache_creation_input_token_cost),
      maxInputTokens: integer(record.max_input_tokens),
      maxOutputTokens: integer(record.max_output_tokens),
    });
    if (entries.length >= MAX_ENTRIES) break;
  }
  if (!entries.length) {
    throw new Error("The model cost catalog contained no priced models");
  }
  return entries;
}

/**
 * Run records name a model the way their provider does — `claude-sonnet-4-5`,
 * `openai/gpt-5`, `anthropic/claude-opus-4-1` — while the catalog keys mix bare
 * ids and provider-prefixed ones. Matching therefore tries the name as given,
 * the name without its prefix, and finally any key that ends in that bare name.
 */
function bareModel(model: string): string {
  const index = model.lastIndexOf("/");
  return index < 0 ? model : model.slice(index + 1);
}

function toView(entry: StoredEntry): ModelCostEntryView {
  return {
    model: entry.model,
    provider: entry.provider,
    mode: entry.mode,
    inputCostPerToken: entry.inputCostPerToken,
    outputCostPerToken: entry.outputCostPerToken,
    cacheReadCostPerToken: entry.cacheReadCostPerToken,
    cacheWriteCostPerToken: entry.cacheWriteCostPerToken,
    maxInputTokens: entry.maxInputTokens,
    maxOutputTokens: entry.maxOutputTokens,
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export class ModelCostsService {
  /**
   * A refresh already in flight, so a page load that finds the catalog stale
   * does not start a second fetch of the same file behind the first.
   */
  private refreshing: Promise<ModelCostCatalogView> | null = null;

  /**
   * `ensureFresh` sits on read paths that run several times per page — once per
   * priced model — and reading the settings row costs a write, since it upserts.
   * Remembering when the staleness question was last asked keeps that off the
   * hot path without letting the answer go stale by more than this window.
   */
  private checkedAt = 0;

  async getCatalog(): Promise<ModelCostCatalogView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.modelCostSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    return {
      url: settings.catalogUrl ?? DEFAULT_MODEL_COST_URL,
      defaultUrl: DEFAULT_MODEL_COST_URL,
      customUrl: settings.catalogUrl,
      fetchedAt: settings.fetchedAt?.toISOString() ?? null,
      entryCount: settings.entryCount,
      error: settings.error,
      stale: this.isStale(settings.fetchedAt),
    };
  }

  private isStale(fetchedAt: Date | null): boolean {
    return (
      !fetchedAt || Date.now() - fetchedAt.getTime() >= REFRESH_INTERVAL_MS
    );
  }

  /**
   * An empty or default-valued URL clears the override rather than storing the
   * default as a custom value, so a later change to the default is picked up.
   */
  async saveSettings(catalogUrl: string | null): Promise<ModelCostCatalogView> {
    const trimmed = catalogUrl?.trim() ?? "";
    const custom =
      !trimmed || trimmed === DEFAULT_MODEL_COST_URL ? null : trimmed;
    if (custom) {
      let parsed: URL;
      try {
        parsed = new URL(custom);
      } catch {
        throw new Error("The model cost URL must be a valid URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("The model cost URL must be an http or https URL");
      }
    }
    const prisma = await getPrismaClient();
    await prisma.modelCostSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, catalogUrl: custom },
      update: { catalogUrl: custom },
    });
    return this.getCatalog();
  }

  /**
   * Fetches the catalog and replaces the stored table with it. A failure is
   * recorded on the settings row rather than thrown away, so the page can say
   * why the prices it is showing are the ones from last time.
   */
  async refresh(): Promise<ModelCostCatalogView> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(): Promise<ModelCostCatalogView> {
    const prisma = await getPrismaClient();
    const current = await this.getCatalog();
    try {
      const response = await fetch(current.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(
          `The model cost catalog request failed with ${response.status}`,
        );
      }
      const entries = parseCatalog(await response.json());
      await prisma.$transaction(async (transaction) => {
        await transaction.modelCostEntry.deleteMany({});
        for (let index = 0; index < entries.length; index += WRITE_CHUNK) {
          await transaction.modelCostEntry.createMany({
            data: entries.slice(index, index + WRITE_CHUNK),
          });
        }
        await transaction.modelCostSettings.update({
          where: { id: SETTINGS_ID },
          data: {
            fetchedAt: new Date(),
            sourceUrl: current.url,
            entryCount: entries.length,
            error: null,
          },
        });
      });
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      await prisma.modelCostSettings.update({
        where: { id: SETTINGS_ID },
        data: { error: message.slice(0, 2_000) },
      });
    }
    return this.getCatalog();
  }

  /**
   * Refreshes on read when the catalog has gone a day stale, which is what
   * makes "fetch once per day" happen without a scheduler. Read paths never
   * fail on it — `refresh` records its own errors and returns the last state.
   */
  async ensureFresh(): Promise<void> {
    if (Date.now() - this.checkedAt < CHECK_INTERVAL_MS) return;
    this.checkedAt = Date.now();
    const catalog = await this.getCatalog();
    if (!catalog.stale) return;
    await this.refresh();
  }

  async listEntries({
    search,
    first = 100,
    offset = 0,
  }: {
    search?: string | null;
    first?: number | null;
    offset?: number | null;
  }): Promise<ModelCostEntryPageView> {
    await this.ensureFresh();
    const prisma = await getPrismaClient();
    const term = search?.trim();
    const where = term
      ? {
          OR: [{ model: { contains: term } }, { provider: { contains: term } }],
        }
      : {};
    const take = Math.min(Math.max(first ?? 100, 1), 500);
    const skip = Math.max(offset ?? 0, 0);
    const [items, totalCount] = await Promise.all([
      prisma.modelCostEntry.findMany({
        where,
        orderBy: { model: "asc" },
        skip,
        take,
      }),
      prisma.modelCostEntry.count({ where }),
    ]);
    return { items: items.map(toView), totalCount };
  }

  /**
   * Resolves each requested model to its catalog row, keyed by the name the
   * caller asked for. One round trip covers the exact and bare-name matches;
   * only names still unresolved after that pay for the suffix search.
   */
  async lookup(models: string[]): Promise<Map<string, ModelCostEntryView>> {
    const wanted = [...new Set(models.filter(Boolean))];
    const resolved = new Map<string, ModelCostEntryView>();
    if (!wanted.length) return resolved;
    const prisma = await getPrismaClient();
    const candidates = [
      ...new Set(wanted.flatMap((model) => [model, bareModel(model)])),
    ];
    const rows = await prisma.modelCostEntry.findMany({
      where: { model: { in: candidates } },
    });
    const byModel = new Map(rows.map((row) => [row.model, row]));
    const unresolved: string[] = [];
    for (const model of wanted) {
      const row = byModel.get(model) ?? byModel.get(bareModel(model));
      if (row) resolved.set(model, toView(row));
      else unresolved.push(model);
    }
    if (!unresolved.length) return resolved;
    const suffixed = await prisma.modelCostEntry.findMany({
      where: {
        OR: unresolved.map((model) => ({
          model: { endsWith: `/${bareModel(model)}` },
        })),
      },
    });
    for (const model of unresolved) {
      const bare = bareModel(model).toLowerCase();
      const row = suffixed.find(
        (entry) => bareModel(entry.model).toLowerCase() === bare,
      );
      if (row) resolved.set(model, toView(row));
    }
    return resolved;
  }

  /**
   * Cache tokens are priced at the input rate when the catalog states no cache
   * price of its own. Inventing the usual read/write multipliers would dress a
   * guess up as a quote; charging them as ordinary input tokens is the same
   * assumption the reader can make from the numbers on the page.
   */
  estimate(
    entry: ModelCostEntryView | undefined,
    usage: ModelCostUsage,
  ): number | null {
    if (!entry) return null;
    const input = entry.inputCostPerToken;
    const output = entry.outputCostPerToken;
    if (input === null && output === null) return null;
    const cacheRead = entry.cacheReadCostPerToken ?? input ?? 0;
    const cacheWrite = entry.cacheWriteCostPerToken ?? input ?? 0;
    return (
      usage.inputTokens * (input ?? 0) +
      usage.outputTokens * (output ?? 0) +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite
    );
  }
}
