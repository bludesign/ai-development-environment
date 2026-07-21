export const CACHE_SERVER_SETTINGS_FIELDS =
  "configured baseUrl apiKeyConfigured headers { name value } updatedAt";
export const CACHE_ENTRY_FIELDS =
  "id key version scope repoId updatedAt locationId";
export const STORAGE_LOCATION_FIELDS =
  "id folderName partCount mergeStartedAt mergedAt partsDeletedAt lastDownloadedAt sizeBytes";

export type CacheServerHeaderView = {
  name: string;
  value: string;
};

export type CacheServerSettingsView = {
  configured: boolean;
  baseUrl: string | null;
  apiKeyConfigured: boolean;
  headers: CacheServerHeaderView[];
  updatedAt: string;
};

export type CacheEntryView = {
  id: string;
  key: string;
  version: string;
  scope: string;
  repoId: string;
  updatedAt: number;
  locationId: string;
};

export type CacheEntryPageView = {
  total: number;
  items: CacheEntryView[];
};

export type StorageLocationView = {
  id: string;
  folderName: string;
  partCount: number;
  mergeStartedAt: number | null;
  mergedAt: number | null;
  partsDeletedAt: number | null;
  lastDownloadedAt: number | null;
  sizeBytes: number | null;
};

export type CacheEntryDetailView = {
  entry: CacheEntryView;
  location: StorageLocationView | null;
};

export type CacheEntryMatchType =
  "EXACT_PRIMARY" | "PREFIXED_PRIMARY" | "EXACT_RESTORE" | "PREFIXED_RESTORE";

export type CacheEntryMatchView = {
  match: CacheEntryView;
  type: CacheEntryMatchType;
};

export type SaveCacheServerSettingsInput = {
  baseUrl: string;
  apiKey?: string | null;
  headers?: CacheServerHeaderView[] | null;
};

export type CacheEntryFilters = {
  key?: string | null;
  version?: string | null;
  scope?: string | null;
  repoId?: string | null;
};

export type ListCacheEntriesArgs = CacheEntryFilters & {
  itemsPerPage?: number | null;
  page?: number | null;
};

export type MatchCacheEntryArgs = {
  primaryKey: string;
  restoreKeys?: string[] | null;
  scopes: string[];
  repoId: string;
  version: string;
};
