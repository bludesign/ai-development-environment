import { describe, expect, test, vi } from "vitest";

import type { GraphQLContext } from "@/services/graphql-server/graphql-server.service";
import type { CacheServerService } from "@/services/cache-server";

import { createCacheServerResolvers } from "./cache-server";

function context(agentId: string | null): GraphQLContext {
  return { agentId, ipAddress: "127.0.0.1" } as GraphQLContext;
}

describe("cache server resolvers", () => {
  test("rejects agent credentials from every operation", () => {
    const service = {
      getSettings: vi.fn(),
      listCacheEntries: vi.fn(),
      deleteCacheEntry: vi.fn(),
    } as unknown as CacheServerService;
    const resolvers = createCacheServerResolvers(service);

    expect(() =>
      resolvers.Query.cacheServerSettings({}, {}, context("agent-1")),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Query.cacheEntries(
        {},
        { itemsPerPage: 20, page: 1 },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(() =>
      resolvers.Mutation.deleteCacheEntry(
        {},
        { id: "entry-1" },
        context("agent-1"),
      ),
    ).toThrow("control-plane");
    expect(service.getSettings).not.toHaveBeenCalled();
    expect(service.listCacheEntries).not.toHaveBeenCalled();
    expect(service.deleteCacheEntry).not.toHaveBeenCalled();
  });

  test("delegates to the service for control-plane callers", () => {
    const service = {
      getSettings: vi.fn(() => "settings"),
      listCacheEntries: vi.fn(() => "page"),
      getCacheEntryDetail: vi.fn(() => "detail"),
      getStorageLocation: vi.fn(() => "location"),
      matchCacheEntry: vi.fn(() => "match"),
      saveSettings: vi.fn(() => "saved"),
      testConnection: vi.fn(() => "tested"),
      clearSettings: vi.fn(() => "cleared"),
      deleteCacheEntry: vi.fn(() => true),
      deleteCacheEntriesByIds: vi.fn(() => true),
      deleteCacheEntries: vi.fn(() => true),
      deleteStorageLocation: vi.fn(() => true),
    } as unknown as CacheServerService;
    const resolvers = createCacheServerResolvers(service);
    const ctx = context(null);

    expect(resolvers.Query.cacheServerSettings({}, {}, ctx)).toBe("settings");

    const listArgs = { scope: "main", itemsPerPage: 20, page: 2 };
    resolvers.Query.cacheEntries({}, listArgs, ctx);
    expect(service.listCacheEntries).toHaveBeenCalledWith(listArgs);

    resolvers.Query.cacheEntryDetail({}, { id: "entry-1" }, ctx);
    expect(service.getCacheEntryDetail).toHaveBeenCalledWith("entry-1");

    resolvers.Query.cacheStorageLocation({}, { id: "location-1" }, ctx);
    expect(service.getStorageLocation).toHaveBeenCalledWith("location-1");

    const matchArgs = {
      primaryKey: "cache",
      scopes: ["main"],
      repoId: "repo-1",
      version: "v1",
    };
    resolvers.Query.cacheEntryMatch({}, matchArgs, ctx);
    expect(service.matchCacheEntry).toHaveBeenCalledWith(matchArgs);

    const input = { baseUrl: "http://cache.test/api", apiKey: "secret" };
    resolvers.Mutation.saveCacheServerSettings({}, { input }, ctx);
    expect(service.saveSettings).toHaveBeenCalledWith(input);

    resolvers.Mutation.testCacheServerConnection({}, {}, ctx);
    expect(service.testConnection).toHaveBeenCalled();

    resolvers.Mutation.deleteCacheEntry({}, { id: "entry-1" }, ctx);
    expect(service.deleteCacheEntry).toHaveBeenCalledWith("entry-1");

    resolvers.Mutation.deleteCacheEntriesByIds(
      {},
      { ids: ["entry-1", "entry-2"] },
      ctx,
    );
    expect(service.deleteCacheEntriesByIds).toHaveBeenCalledWith([
      "entry-1",
      "entry-2",
    ]);

    const filters = { key: "cache", version: "v1" };
    resolvers.Mutation.deleteCacheEntries({}, filters, ctx);
    expect(service.deleteCacheEntries).toHaveBeenCalledWith(filters);

    resolvers.Mutation.deleteCacheStorageLocation(
      {},
      { id: "location-1" },
      ctx,
    );
    expect(service.deleteStorageLocation).toHaveBeenCalledWith("location-1");
  });
});
