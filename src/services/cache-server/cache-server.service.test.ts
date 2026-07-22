import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: null as {
    id: string;
    baseUrl: string | null;
    apiKey: string | null;
    headersJson: string;
    headerNamesJson: string;
    createdAt: Date;
    updatedAt: Date;
  } | null,
}));

vi.mock("@/data/prisma-client", () => ({
  getPrismaClient: async () => ({
    cacheServerSettings: {
      findUnique: async () => state.settings,
      upsert: async ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const now = new Date();
        state.settings = state.settings
          ? { ...state.settings, ...update, updatedAt: now }
          : {
              id: "default",
              baseUrl: null,
              apiKey: null,
              headersJson: "[]",
              headerNamesJson: "[]",
              createdAt: now,
              updatedAt: now,
              ...create,
            };
        return state.settings;
      },
    },
  }),
}));

vi.mock("@/services/credentials", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/services/credentials")>();
  return {
    ...original,
    CredentialService: class {
      async isConfigured(descriptor: { id: string }) {
        if (descriptor.id.endsWith("/api-key")) {
          return Boolean(state.settings?.apiKey);
        }
        return Boolean(
          state.settings && JSON.parse(state.settings.headersJson).length,
        );
      }

      async getText() {
        return state.settings?.apiKey ?? null;
      }

      async getJson() {
        return state.settings ? JSON.parse(state.settings.headersJson) : null;
      }

      async setMany(
        entries: Array<{ descriptor: { id: string }; value: Uint8Array }>,
        mutation?: (transaction: unknown) => Promise<void>,
      ) {
        const apiKey = Buffer.from(
          entries.find((entry) => entry.descriptor.id.endsWith("/api-key"))!
            .value,
        ).toString("utf8");
        const headerEnvelope = JSON.parse(
          Buffer.from(
            entries.find((entry) => entry.descriptor.id.endsWith("/headers"))!
              .value,
          ).toString("utf8"),
        ) as { value: Array<{ name: string; value: string }> };
        const prisma = await (
          await import("@/data/prisma-client")
        ).getPrismaClient();
        await mutation?.(prisma);
        if (state.settings) {
          state.settings.apiKey = apiKey;
          state.settings.headersJson = JSON.stringify(headerEnvelope.value);
        }
      }

      async deleteMany(
        _descriptors: unknown,
        mutation?: (transaction: unknown) => Promise<void>,
      ) {
        const prisma = await (
          await import("@/data/prisma-client")
        ).getPrismaClient();
        await mutation?.(prisma);
        if (state.settings) {
          state.settings.apiKey = null;
          state.settings.headersJson = "[]";
        }
      }
    },
  };
});

import { CacheServerService } from "./cache-server.service";

type FetchCall = {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as Response;
}

function configuredSettings() {
  return {
    id: "default",
    baseUrl: "http://cache.test/api",
    apiKey: "secret-key",
    headersJson: JSON.stringify([{ name: "x-tenant", value: "acme" }]),
    headerNamesJson: JSON.stringify(["x-tenant"]),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function lastFetch(): FetchCall {
  const mock = vi.mocked(fetch);
  const call = mock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return {
    url: String(call[0]),
    init: call[1] as FetchCall["init"],
  };
}

const entry = {
  id: "entry-1",
  key: "build-cache",
  version: "v1",
  scope: "refs/heads/main",
  repoId: "repo-1",
  updatedAt: 1700000000000,
  locationId: "location-1",
};

const storageLocation = {
  id: "location-1",
  folderName: "abc123",
  partCount: 3,
  mergeStartedAt: null,
  mergedAt: 1700000005000,
  partsDeletedAt: null,
  lastDownloadedAt: null,
  sizeBytes: 2048,
};

describe("CacheServerService", () => {
  beforeEach(() => {
    state.settings = configuredSettings();
    global.fetch = vi.fn();
  });

  test("getSettings reports configuration without exposing the API key", async () => {
    const view = await new CacheServerService().getSettings();
    expect(view.configured).toBe(true);
    expect(view.apiKeyConfigured).toBe(true);
    expect(view.baseUrl).toBe("http://cache.test/api");
    expect(view.headers).toEqual([{ name: "x-tenant", valueConfigured: true }]);
    expect(view).not.toHaveProperty("apiKey");
    expect(view.headers[0]).not.toHaveProperty("value");
  });

  test("saveSettings trims the base URL and keeps the stored key when blank", async () => {
    const view = await new CacheServerService().saveSettings({
      baseUrl: "http://cache.test/api/",
      apiKey: null,
      headers: [{ name: "x-tenant", value: "beta" }],
    });
    expect(view.baseUrl).toBe("http://cache.test/api");
    expect(state.settings?.apiKey).toBe("secret-key");
    expect(state.settings?.headersJson).toBe(
      JSON.stringify([{ name: "x-tenant", value: "beta" }]),
    );
    expect(view.headers).toEqual([{ name: "x-tenant", valueConfigured: true }]);
  });

  test("saveSettings keeps stored custom-header values when blank", async () => {
    const view = await new CacheServerService().saveSettings({
      baseUrl: "http://cache.test/api",
      apiKey: null,
      headers: [{ name: "X-Tenant", value: null }],
    });
    expect(state.settings?.headersJson).toBe(
      JSON.stringify([{ name: "X-Tenant", value: "acme" }]),
    );
    expect(view.headers).toEqual([{ name: "X-Tenant", valueConfigured: true }]);
  });

  test("saveSettings requires values for new custom headers", async () => {
    await expect(
      new CacheServerService().saveSettings({
        baseUrl: "http://cache.test/api",
        headers: [{ name: "Authorization", value: null }],
      }),
    ).rejects.toThrow("Authorization");
  });

  test("saveSettings requires an API key when none is stored", async () => {
    state.settings = null;
    await expect(
      new CacheServerService().saveSettings({
        baseUrl: "http://cache.test/api",
        apiKey: null,
      }),
    ).rejects.toThrow("API key");
  });

  test("saveSettings rejects a non-http base URL", async () => {
    await expect(
      new CacheServerService().saveSettings({
        baseUrl: "ftp://cache.test/api",
        apiKey: "secret-key",
      }),
    ).rejects.toThrow("http");
  });

  test("listCacheEntries sends the API key and custom headers and maps entries", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ total: 1, items: [entry] }),
    );
    const page = await new CacheServerService().listCacheEntries({
      scope: "refs/heads/main",
    });
    const { url, init } = lastFetch();
    expect(init.method).toBe("GET");
    expect(init.headers["x-api-key"]).toBe("secret-key");
    expect(init.headers["x-tenant"]).toBe("acme");
    expect(url).toContain("/cache-entries?");
    expect(url).toContain("scope=refs%2Fheads%2Fmain");
    expect(url).toContain("itemsPerPage=20");
    expect(url).toContain("page=1");
    expect(page.total).toBe(1);
    expect(page.items[0]).toEqual(entry);
  });

  test("getCacheEntryDetail loads the entry and its storage location", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(entry))
      .mockResolvedValueOnce(jsonResponse(storageLocation));
    const detail = await new CacheServerService().getCacheEntryDetail(
      "entry-1",
    );
    expect(detail?.entry).toEqual(entry);
    expect(detail?.location).toEqual(storageLocation);
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain(
      "/cache-entries/entry-1",
    );
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain(
      "/storage-locations/location-1",
    );
  });

  test("getCacheEntryDetail returns null and skips the location fetch on 404", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(undefined, 404));
    const detail = await new CacheServerService().getCacheEntryDetail(
      "missing",
    );
    expect(detail).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test("matchCacheEntry repeats array params and maps the hyphenated type", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ match: entry, type: "prefixed-restore" }),
    );
    const result = await new CacheServerService().matchCacheEntry({
      primaryKey: "build-cache",
      restoreKeys: ["fallback-1", "fallback-2"],
      scopes: ["refs/heads/main", "refs/heads/dev"],
      repoId: "repo-1",
      version: "v1",
    });
    const { url } = lastFetch();
    expect(url).toContain("scopes=refs%2Fheads%2Fmain");
    expect(url).toContain("scopes=refs%2Fheads%2Fdev");
    expect(url).toContain("restoreKeys=fallback-1");
    expect(url).toContain("restoreKeys=fallback-2");
    expect(result?.type).toBe("PREFIXED_RESTORE");
    expect(result?.match).toEqual(entry);
  });

  test("matchCacheEntry returns null when the server reports no match", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(null));
    const result = await new CacheServerService().matchCacheEntry({
      primaryKey: "build-cache",
      scopes: ["refs/heads/main"],
      repoId: "repo-1",
      version: "v1",
    });
    expect(result).toBeNull();
  });

  test("deleteCacheEntriesByIds deletes each entry individually", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(undefined));
    await new CacheServerService().deleteCacheEntriesByIds([
      "entry-1",
      "entry-2",
    ]);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(2);
    expect(String(calls[0][0]).endsWith("/cache-entries/entry-1")).toBe(true);
    expect(String(calls[1][0]).endsWith("/cache-entries/entry-2")).toBe(true);
    expect(calls.every(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  test("deleteCacheEntries issues a DELETE with the filters as a JSON body", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(undefined));
    await new CacheServerService().deleteCacheEntries({
      key: "build-cache",
      scope: "  ",
    });
    const { url, init } = lastFetch();
    expect(init.method).toBe("DELETE");
    expect(url.endsWith("/cache-entries")).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ key: "build-cache" });
  });

  test("deleteCacheEntries resolves repository matches to IDs before deleting", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse({
          total: 101,
          items: [entry, { ...entry, id: "wrong-repo", repoId: "repo-2" }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total: 101,
          items: [{ ...entry, id: "entry-2" }],
        }),
      )
      .mockResolvedValue(jsonResponse(undefined));

    await new CacheServerService().deleteCacheEntries({
      repoId: " repo-1 ",
      key: "build-cache",
    });

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(String(calls[0][0])).toContain("repoId=repo-1");
    expect(String(calls[0][0])).toContain("key=build-cache");
    expect(String(calls[0][0])).toContain("page=1");
    expect(String(calls[1][0])).toContain("page=2");
    expect(String(calls[2][0]).endsWith("/cache-entries/entry-1")).toBe(true);
    expect(String(calls[3][0]).endsWith("/cache-entries/entry-2")).toBe(true);
    expect(
      calls.some(
        ([url, init]) =>
          init?.method === "DELETE" && String(url).endsWith("/cache-entries"),
      ),
    ).toBe(false);
  });

  test("testConnection requests a single-item listing", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ total: 0, items: [] }));
    await new CacheServerService().testConnection();
    const { url } = lastFetch();
    expect(url).toContain("itemsPerPage=1");
  });

  test.each([undefined, null, { total: 0 }, { total: "0", items: [] }])(
    "testConnection rejects an invalid management response: %j",
    async (body) => {
      vi.mocked(fetch).mockResolvedValue(jsonResponse(body));
      await expect(new CacheServerService().testConnection()).rejects.toThrow(
        "invalid cache entry response",
      );
    },
  );

  test("testConnection rejects a successful HTML response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "<html>Sign in</html>",
    } as Response);
    await expect(new CacheServerService().testConnection()).rejects.toThrow(
      "invalid cache entry response",
    );
  });

  test("requests throw when the cache server is not configured", async () => {
    state.settings = null;
    await expect(new CacheServerService().listCacheEntries({})).rejects.toThrow(
      "not configured",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("network errors are redacted so the API key never leaks", async () => {
    vi.mocked(fetch).mockRejectedValue(
      new Error("connect to secret-key failed"),
    );
    await expect(new CacheServerService().listCacheEntries({})).rejects.toThrow(
      "[REDACTED]",
    );
  });

  test("clearSettings removes the connection details", async () => {
    const view = await new CacheServerService().clearSettings();
    expect(view.configured).toBe(false);
    expect(state.settings?.baseUrl).toBeNull();
    expect(state.settings?.apiKey).toBeNull();
    expect(state.settings?.headersJson).toBe("[]");
  });
});
