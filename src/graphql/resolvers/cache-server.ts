import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type {
  CacheEntryFilters,
  CacheServerService,
  ListCacheEntriesArgs,
  MatchCacheEntryArgs,
  SaveCacheServerSettingsInput,
} from "@/services/cache-server";

function requireControlPlane(context: GraphQLContext): void {
  if (context.agentId) {
    throw new Error(
      "Agent credentials cannot perform control-plane operations",
    );
  }
}

export const createCacheServerResolvers = (
  cacheServerService: CacheServerService,
) => ({
  Query: {
    cacheServerSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.getSettings();
    },
    cacheEntries: (
      _root: unknown,
      args: ListCacheEntriesArgs,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.listCacheEntries(args);
    },
    cacheEntryDetail: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.getCacheEntryDetail(id);
    },
    cacheStorageLocation: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.getStorageLocation(id);
    },
    cacheEntryMatch: (
      _root: unknown,
      args: MatchCacheEntryArgs,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.matchCacheEntry(args);
    },
  },
  Mutation: {
    saveCacheServerSettings: (
      _root: unknown,
      { input }: { input: SaveCacheServerSettingsInput },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.saveSettings(input);
    },
    testCacheServerConnection: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.testConnection();
    },
    clearCacheServerSettings: (
      _root: unknown,
      _args: unknown,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.clearSettings();
    },
    deleteCacheEntry: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.deleteCacheEntry(id);
    },
    deleteCacheEntriesByIds: (
      _root: unknown,
      { ids }: { ids: string[] },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.deleteCacheEntriesByIds(ids);
    },
    deleteCacheEntries: (
      _root: unknown,
      filters: CacheEntryFilters,
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.deleteCacheEntries(filters);
    },
    deleteCacheStorageLocation: (
      _root: unknown,
      { id }: { id: string },
      context: GraphQLContext,
    ) => {
      requireControlPlane(context);
      return cacheServerService.deleteStorageLocation(id);
    },
  },
});
