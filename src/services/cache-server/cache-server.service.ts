import "server-only";

import { getPrismaClient } from "@/data/prisma-client";

import type {
  CacheEntryDetailView,
  CacheEntryFilters,
  CacheEntryMatchType,
  CacheEntryMatchView,
  CacheEntryPageView,
  CacheEntryView,
  CacheServerHeaderView,
  CacheServerSettingsView,
  ListCacheEntriesArgs,
  MatchCacheEntryArgs,
  SaveCacheServerSettingsInput,
  StorageLocationView,
} from "./types";

const SETTINGS_ID = "default";
const API_KEY_HEADER = "x-api-key";

type CacheServerConfig = {
  baseUrl: string;
  apiKey: string;
  headers: CacheServerHeaderView[];
};

type RawCacheEntry = {
  id: string;
  key: string;
  version: string;
  scope: string;
  repoId: string;
  updatedAt: number;
  locationId: string;
};

type RawStorageLocation = {
  id: string;
  folderName: string;
  partCount: number;
  mergeStartedAt: number | null;
  mergedAt: number | null;
  partsDeletedAt: number | null;
  lastDownloadedAt: number | null;
  sizeBytes: number | null;
};

type RawCacheEntryPage = {
  total: number;
  items: RawCacheEntry[];
};

type RawMatch = {
  match: RawCacheEntry;
  type: string;
};

type QueryValue = string | number | string[] | null | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  allowNotFound?: boolean;
};

const MATCH_TYPE_MAP: Record<string, CacheEntryMatchType> = {
  "exact-primary": "EXACT_PRIMARY",
  "prefixed-primary": "PREFIXED_PRIMARY",
  "exact-restore": "EXACT_RESTORE",
  "prefixed-restore": "PREFIXED_RESTORE",
};

function sanitizeError(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("[REDACTED]");
}

function parseHeaders(headersJson: string): CacheServerHeaderView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(headersJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (item): item is CacheServerHeaderView =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string",
    )
    .map((item) => ({ name: item.name, value: item.value }));
}

function normalizeHeaders(
  headers: CacheServerHeaderView[] | null | undefined,
): CacheServerHeaderView[] {
  if (!headers) return [];
  const seen = new Set<string>();
  const result: CacheServerHeaderView[] = [];
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, value: header.value });
  }
  return result;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("A cache server base URL is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("The cache server base URL is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The cache server base URL must use http or https");
  }
  return trimmed;
}

function cacheEntryView(entry: RawCacheEntry): CacheEntryView {
  return {
    id: entry.id,
    key: entry.key,
    version: entry.version,
    scope: entry.scope,
    repoId: entry.repoId,
    updatedAt: entry.updatedAt,
    locationId: entry.locationId,
  };
}

function storageLocationView(
  location: RawStorageLocation,
): StorageLocationView {
  return {
    id: location.id,
    folderName: location.folderName,
    partCount: location.partCount,
    mergeStartedAt: location.mergeStartedAt ?? null,
    mergedAt: location.mergedAt ?? null,
    partsDeletedAt: location.partsDeletedAt ?? null,
    lastDownloadedAt: location.lastDownloadedAt ?? null,
    sizeBytes: location.sizeBytes ?? null,
  };
}

// Owns the cache server connection settings and proxies the management API. Settings are a
// singleton row (id "default"); the API key is sent on every request as the x-api-key header
// alongside any operator-configured custom headers.
export class CacheServerService {
  async getSettings(): Promise<CacheServerSettingsView> {
    const prisma = await getPrismaClient();
    const settings = await prisma.cacheServerSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: {},
    });
    return this.settingsView(settings);
  }

  private settingsView(settings: {
    baseUrl: string | null;
    apiKey: string | null;
    headersJson: string;
    updatedAt: Date;
  }): CacheServerSettingsView {
    return {
      configured: Boolean(settings.baseUrl && settings.apiKey),
      baseUrl: settings.baseUrl,
      apiKeyConfigured: Boolean(settings.apiKey),
      headers: parseHeaders(settings.headersJson),
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  async saveSettings(
    input: SaveCacheServerSettingsInput,
  ): Promise<CacheServerSettingsView> {
    const prisma = await getPrismaClient();
    const existing = await prisma.cacheServerSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const nextApiKey = input.apiKey?.trim() || existing?.apiKey || null;
    if (!nextApiKey) {
      throw new Error("A cache server API key is required");
    }
    const headersJson = JSON.stringify(normalizeHeaders(input.headers));
    await prisma.cacheServerSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, baseUrl, apiKey: nextApiKey, headersJson },
      update: { baseUrl, apiKey: nextApiKey, headersJson },
    });
    return this.getSettings();
  }

  async clearSettings(): Promise<CacheServerSettingsView> {
    const prisma = await getPrismaClient();
    await prisma.cacheServerSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
      update: { baseUrl: null, apiKey: null, headersJson: "[]" },
    });
    return this.getSettings();
  }

  async testConnection(): Promise<CacheServerSettingsView> {
    // No dedicated health endpoint exists, so a cheap single-item listing verifies that the
    // base URL is reachable and the API key is accepted.
    await this.request<RawCacheEntryPage>("GET", "/cache-entries", {
      query: { itemsPerPage: 1, page: 1 },
    });
    return this.getSettings();
  }

  async listCacheEntries(
    args: ListCacheEntriesArgs,
  ): Promise<CacheEntryPageView> {
    const page = await this.request<RawCacheEntryPage>(
      "GET",
      "/cache-entries",
      {
        query: {
          key: args.key?.trim() || undefined,
          version: args.version?.trim() || undefined,
          scope: args.scope?.trim() || undefined,
          repoId: args.repoId?.trim() || undefined,
          itemsPerPage: args.itemsPerPage ?? 20,
          page: args.page ?? 1,
        },
      },
    );
    return {
      total: page?.total ?? 0,
      items: (page?.items ?? []).map(cacheEntryView),
    };
  }

  async getCacheEntry(id: string): Promise<CacheEntryView | null> {
    const entry = await this.request<RawCacheEntry>(
      "GET",
      `/cache-entries/${encodeURIComponent(id)}`,
      { allowNotFound: true },
    );
    return entry ? cacheEntryView(entry) : null;
  }

  async getCacheEntryDetail(id: string): Promise<CacheEntryDetailView | null> {
    const entry = await this.getCacheEntry(id);
    if (!entry) return null;
    const location = entry.locationId
      ? await this.getStorageLocation(entry.locationId)
      : null;
    return { entry, location };
  }

  async getStorageLocation(id: string): Promise<StorageLocationView | null> {
    const location = await this.request<RawStorageLocation>(
      "GET",
      `/storage-locations/${encodeURIComponent(id)}`,
      { allowNotFound: true },
    );
    return location ? storageLocationView(location) : null;
  }

  async matchCacheEntry(
    args: MatchCacheEntryArgs,
  ): Promise<CacheEntryMatchView | null> {
    const restoreKeys = (args.restoreKeys ?? [])
      .map((key) => key.trim())
      .filter(Boolean);
    const scopes = args.scopes.map((scope) => scope.trim()).filter(Boolean);
    const result = await this.request<RawMatch | null>(
      "GET",
      "/cache-entries/match",
      {
        query: {
          primaryKey: args.primaryKey,
          restoreKeys: restoreKeys.length > 0 ? restoreKeys : undefined,
          scopes,
          repoId: args.repoId,
          version: args.version,
        },
      },
    );
    if (!result) return null;
    const type = MATCH_TYPE_MAP[result.type];
    if (!type) {
      throw new Error(`Cache server returned an unknown match type`);
    }
    return { match: cacheEntryView(result.match), type };
  }

  async deleteCacheEntry(id: string): Promise<boolean> {
    await this.request("DELETE", `/cache-entries/${encodeURIComponent(id)}`, {
      allowNotFound: true,
    });
    return true;
  }

  async deleteCacheEntriesByIds(ids: string[]): Promise<boolean> {
    for (const id of ids) {
      await this.deleteCacheEntry(id);
    }
    return true;
  }

  async deleteCacheEntries(filters: CacheEntryFilters): Promise<boolean> {
    const body: Record<string, string> = {};
    if (filters.key?.trim()) body.key = filters.key.trim();
    if (filters.version?.trim()) body.version = filters.version.trim();
    if (filters.scope?.trim()) body.scope = filters.scope.trim();
    if (filters.repoId?.trim()) body.repoId = filters.repoId.trim();
    await this.request("DELETE", "/cache-entries", { body });
    return true;
  }

  async deleteStorageLocation(id: string): Promise<boolean> {
    await this.request(
      "DELETE",
      `/storage-locations/${encodeURIComponent(id)}`,
      { allowNotFound: true },
    );
    return true;
  }

  private async requireConfig(): Promise<CacheServerConfig> {
    const prisma = await getPrismaClient();
    const settings = await prisma.cacheServerSettings.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (!settings?.baseUrl || !settings.apiKey) {
      throw new Error("The cache server is not configured");
    }
    return {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      headers: parseHeaders(settings.headersJson),
    };
  }

  private buildUrl(
    baseUrl: string,
    path: string,
    query?: Record<string, QueryValue>,
  ): string {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(name, item);
        } else {
          url.searchParams.append(name, String(value));
        }
      }
    }
    return url.toString();
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T | null> {
    const config = await this.requireConfig();
    const url = this.buildUrl(config.baseUrl, path, options.query);
    const headers: Record<string, string> = { accept: "application/json" };
    for (const header of config.headers) headers[header.name] = header.value;
    headers[API_KEY_HEADER] = config.apiKey;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body:
          options.body !== undefined ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
      });
    } catch (error) {
      throw new Error(
        sanitizeError(
          error instanceof Error ? error.message : String(error),
          config.apiKey,
        ),
      );
    }

    if (options.allowNotFound && response.status === 404) {
      return null;
    }

    const text = await response.text();
    let body: unknown;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new Error(`Cache server returned HTTP ${response.status}`);
        }
        body = undefined;
      }
    }

    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "message" in body &&
        typeof (body as { message: unknown }).message === "string"
          ? (body as { message: string }).message
          : `Cache server returned HTTP ${response.status}`;
      throw new Error(sanitizeError(message, config.apiKey));
    }

    return (body ?? null) as T | null;
  }
}
