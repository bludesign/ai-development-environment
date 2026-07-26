import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { getPrismaClient } from "@/data/prisma-client";

import type { GitHubRateLimitMetadata } from "./github-rate-limit";
import type {
  GitHubApiCallView,
  GitHubApiType,
  GitHubAuthentication,
  GitHubCachedEntryDetail,
  GitHubCachedEntryView,
  GitHubCacheMetrics,
  GitHubCallSource,
  GitHubMetricWindow,
  GitHubOperationMetric,
  GitHubPaginatedResult,
  GitHubRequestSource,
  GitHubSettingsView,
} from "./types";

type LiveResult<T> = {
  data: T;
  statusCode: number | null;
  pointCost: number | null;
  rateLimit: GitHubRateLimitMetadata | null;
};

type QueryInput<T> = {
  authentication: GitHubAuthentication;
  requestSource: GitHubRequestSource;
  endpoint: string;
  operation: string;
  query: string;
  normalizedQuery: string;
  variables: Record<string, unknown>;
  force?: boolean;
  allowStaleOnError?: boolean;
  fetcher: () => Promise<LiveResult<T>>;
};

type MutationInput<T> = Omit<QueryInput<T>, "force" | "allowStaleOnError">;

type CachedResult<T> = {
  data: T;
  source: GitHubCallSource;
  stale: boolean;
  fetchedAt: Date;
  entryId: string;
  pointCost: number | null;
};

const DEFAULT_TTL_SECONDS = 300;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const WINDOW_DEFINITIONS = [
  { window: "5m", milliseconds: 5 * 60 * 1000 },
  { window: "10m", milliseconds: 10 * 60 * 1000 },
  { window: "1h", milliseconds: 60 * 60 * 1000 },
  { window: "24h", milliseconds: 24 * 60 * 60 * 1000 },
];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key]),
      ]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const SENSITIVE_REQUEST_KEY =
  /(?:authorization|password|private.?key|secret|token)$/i;

function sanitizeRequestValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_REQUEST_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRequestValue(item));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([itemKey, item]) => [
      itemKey,
      sanitizeRequestValue(item, itemKey),
    ]),
  );
}

function requestSummary(variables: unknown): string {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    return "No variables";
  }
  const entries = Object.entries(variables as Record<string, unknown>);
  if (!entries.length) return "No variables";
  return entries
    .map(([key, value]) => {
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      const serialized = encoded ?? String(value);
      return `${key}=${serialized.length > 120 ? `${serialized.slice(0, 117)}…` : serialized}`;
    })
    .join(" · ");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function errorMetadata(error: unknown): {
  statusCode: number | null;
  rateLimit: GitHubRateLimitMetadata | null;
} {
  if (!error || typeof error !== "object") {
    return { statusCode: null, rateLimit: null };
  }
  const candidate = error as {
    statusCode?: unknown;
    rateLimit?: unknown;
  };
  return {
    statusCode:
      typeof candidate.statusCode === "number" ? candidate.statusCode : null,
    rateLimit:
      candidate.rateLimit && typeof candidate.rateLimit === "object"
        ? (candidate.rateLimit as GitHubRateLimitMetadata)
        : null,
  };
}

export class GitHubCache {
  private readonly inFlight = new Map<string, Promise<CachedResult<unknown>>>();
  private lastPrunedAt = 0;

  private cacheKey(input: {
    authentication: GitHubAuthentication;
    endpoint: string;
    normalizedQuery: string;
    variables: Record<string, unknown>;
  }): string {
    return createHash("sha256")
      .update(
        stableStringify({
          authentication: input.authentication,
          endpoint: input.endpoint,
          query: input.normalizedQuery,
          variables: input.variables,
        }),
      )
      .digest("hex");
  }

  private async ttlSeconds(): Promise<number> {
    const prisma = await getPrismaClient();
    const settings = await prisma.gitHubSettings.upsert({
      where: { id: "default" },
      create: { id: "default", cacheTtlSeconds: DEFAULT_TTL_SECONDS },
      update: {},
    });
    return settings.cacheTtlSeconds;
  }

  async query<T>(input: QueryInput<T>): Promise<CachedResult<T>> {
    const prisma = await getPrismaClient();
    const key = this.cacheKey(input);
    const startedAt = Date.now();
    const [existing, ttlSeconds, rateLimit] = await Promise.all([
      prisma.gitHubGraphqlCacheEntry.findUnique({ where: { cacheKey: key } }),
      this.ttlSeconds(),
      prisma.gitHubRateLimitSnapshot.findUnique({
        where: {
          authentication_resource: {
            authentication: input.authentication,
            resource: "graphql",
          },
        },
      }),
    ]);
    const fresh =
      existing !== null &&
      Date.now() - existing.fetchedAt.getTime() < ttlSeconds * 1000;
    if (!input.force && fresh) {
      await this.log({
        ...this.graphqlContext(input),
        authentication: input.authentication,
        operation: input.operation,
        source: "CACHE",
        durationMs: Date.now() - startedAt,
        pointCost: 0,
        pointsAvoided: existing.pointCost ?? 0,
      });
      return {
        data: parseJson(existing.responseJson) as T,
        source: "CACHE",
        stale: false,
        fetchedAt: existing.fetchedAt,
        entryId: existing.id,
        pointCost: existing.pointCost,
      };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      const result = (await pending) as CachedResult<T>;
      await this.log({
        ...this.graphqlContext(input),
        authentication: input.authentication,
        operation: input.operation,
        source: "CACHE",
        durationMs: Date.now() - startedAt,
        pointCost: 0,
        pointsAvoided: result.pointCost ?? 0,
      });
      return { ...result, source: "CACHE" };
    }

    if (
      rateLimit?.remaining === 0 &&
      rateLimit.resetAt.getTime() > Date.now()
    ) {
      const error = `GitHub GraphQL rate limit is exhausted until ${rateLimit.resetAt.toISOString()}`;
      const canServeStale =
        existing !== null && input.allowStaleOnError !== false;
      await this.log({
        ...this.graphqlContext(input),
        authentication: input.authentication,
        operation: input.operation,
        source: "ERROR",
        durationMs: Date.now() - startedAt,
        error,
        servedStale: canServeStale,
        pointCost: 0,
        pointsAvoided: canServeStale ? (existing.pointCost ?? 0) : 0,
        rateLimit: {
          limit: rateLimit.limit,
          remaining: rateLimit.remaining,
          used: rateLimit.used,
          resetAt: rateLimit.resetAt,
          resource: rateLimit.resource,
        },
      });
      if (canServeStale) {
        return {
          data: parseJson(existing.responseJson) as T,
          source: "ERROR",
          stale: true,
          fetchedAt: existing.fetchedAt,
          entryId: existing.id,
          pointCost: existing.pointCost,
        };
      }
      throw new Error(error);
    }

    const livePromise = (async (): Promise<CachedResult<T>> => {
      try {
        const live = await input.fetcher();
        const fetchedAt = new Date();
        const entry = await prisma.gitHubGraphqlCacheEntry.upsert({
          where: { cacheKey: key },
          create: {
            id: randomUUID(),
            cacheKey: key,
            authentication: input.authentication,
            endpoint: input.endpoint,
            operation: input.operation,
            query: input.query,
            variablesJson: stableStringify(input.variables),
            responseJson: JSON.stringify(live.data),
            fetchedAt,
            pointCost: live.pointCost,
          },
          update: {
            operation: input.operation,
            query: input.query,
            variablesJson: stableStringify(input.variables),
            responseJson: JSON.stringify(live.data),
            fetchedAt,
            pointCost: live.pointCost,
          },
        });
        await this.log({
          ...this.graphqlContext(input),
          authentication: input.authentication,
          operation: input.operation,
          source: "LIVE",
          durationMs: Date.now() - startedAt,
          statusCode: live.statusCode,
          pointCost: live.pointCost,
          rateLimit: live.rateLimit,
        });
        return {
          data: live.data,
          source: "LIVE",
          stale: false,
          fetchedAt,
          entryId: entry.id,
          pointCost: live.pointCost,
        };
      } catch (error) {
        const metadata = errorMetadata(error);
        const canServeStale =
          existing !== null && input.allowStaleOnError !== false;
        await this.log({
          ...this.graphqlContext(input),
          authentication: input.authentication,
          operation: input.operation,
          source: "ERROR",
          durationMs: Date.now() - startedAt,
          statusCode: metadata.statusCode,
          error: error instanceof Error ? error.message : String(error),
          servedStale: canServeStale,
          pointsAvoided: canServeStale ? (existing?.pointCost ?? 0) : 0,
          rateLimit: metadata.rateLimit,
        });
        if (canServeStale) {
          return {
            data: parseJson(existing.responseJson) as T,
            source: "ERROR",
            stale: true,
            fetchedAt: existing.fetchedAt,
            entryId: existing.id,
            pointCost: existing.pointCost,
          };
        }
        throw error;
      }
    })();
    this.inFlight.set(key, livePromise as Promise<CachedResult<unknown>>);
    try {
      return await livePromise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async mutation<T>(input: MutationInput<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const live = await input.fetcher();
      await this.log({
        ...this.graphqlContext(input),
        authentication: input.authentication,
        operation: input.operation,
        source: "LIVE",
        durationMs: Date.now() - startedAt,
        statusCode: live.statusCode,
        pointCost: null,
        rateLimit: live.rateLimit,
      });
      await this.clear();
      return live.data;
    } catch (error) {
      const metadata = errorMetadata(error);
      await this.log({
        ...this.graphqlContext(input),
        authentication: input.authentication,
        operation: input.operation,
        source: "ERROR",
        durationMs: Date.now() - startedAt,
        statusCode: metadata.statusCode,
        error: error instanceof Error ? error.message : String(error),
        rateLimit: metadata.rateLimit,
      });
      throw error;
    }
  }

  async updateTtl(
    ttlMinutes: number,
    settingsView: () => Promise<GitHubSettingsView>,
  ): Promise<GitHubSettingsView> {
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
      throw new Error("Cache TTL must be an integer from 1 to 1440 minutes");
    }
    const prisma = await getPrismaClient();
    await prisma.gitHubSettings.upsert({
      where: { id: "default" },
      create: { id: "default", cacheTtlSeconds: ttlMinutes * 60 },
      update: { cacheTtlSeconds: ttlMinutes * 60 },
    });
    return settingsView();
  }

  async recordRestCall(input: {
    authentication: GitHubAuthentication;
    method: string;
    endpoint: string;
    requestSource: GitHubRequestSource;
    durationMs: number;
    statusCode?: number | null;
    error?: string | null;
    rateLimit?: GitHubRateLimitMetadata | null;
  }): Promise<void> {
    let path = input.endpoint;
    let variables: Record<string, unknown> = {};
    try {
      const url = new URL(input.endpoint);
      path = url.pathname;
      variables = {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      };
    } catch {
      variables = { endpoint: input.endpoint };
    }
    await this.log({
      authentication: input.authentication,
      apiType: "REST",
      method: input.method.toUpperCase(),
      endpoint: input.endpoint,
      operation: `${input.method.toUpperCase()} ${path}`,
      requestSource: input.requestSource,
      requestSummary: `${input.method.toUpperCase()} ${path}`,
      variables,
      source: input.error ? "ERROR" : "LIVE",
      durationMs: input.durationMs,
      statusCode: input.statusCode,
      error: input.error,
      rateLimit: input.rateLimit,
    });
  }

  async recordGraphqlTransportCall(input: {
    authentication: GitHubAuthentication;
    endpoint: string;
    operation: string;
    requestSource: GitHubRequestSource;
    variables: Record<string, unknown>;
    durationMs: number;
    statusCode?: number | null;
    error?: string | null;
    rateLimit?: GitHubRateLimitMetadata | null;
  }): Promise<void> {
    await this.log({
      ...this.graphqlContext(input),
      authentication: input.authentication,
      operation: input.operation,
      requestSource: input.requestSource,
      source: input.error ? "ERROR" : "LIVE",
      durationMs: input.durationMs,
      statusCode: input.statusCode,
      error: input.error,
      rateLimit: input.rateLimit,
    });
  }

  async clear(): Promise<boolean> {
    const prisma = await getPrismaClient();
    await prisma.gitHubGraphqlCacheEntry.deleteMany();
    return true;
  }

  async delete(id: string): Promise<boolean> {
    const prisma = await getPrismaClient();
    const result = await prisma.gitHubGraphqlCacheEntry.deleteMany({
      where: { id },
    });
    return result.count > 0;
  }

  async entries(
    limit = 50,
    offset = 0,
  ): Promise<GitHubPaginatedResult<GitHubCachedEntryView>> {
    const pagination = this.pagination(limit, offset);
    const prisma = await getPrismaClient();
    const [entries, total, ttlSeconds] = await Promise.all([
      prisma.gitHubGraphqlCacheEntry.findMany({
        take: pagination.limit,
        skip: pagination.offset,
        orderBy: { fetchedAt: "desc" },
      }),
      prisma.gitHubGraphqlCacheEntry.count(),
      this.ttlSeconds(),
    ]);
    return {
      ...pagination,
      total,
      items: entries.map((entry) => this.entryView(entry, ttlSeconds)),
    };
  }

  async entry(id: string): Promise<GitHubCachedEntryDetail | null> {
    const prisma = await getPrismaClient();
    const [entry, ttlSeconds] = await Promise.all([
      prisma.gitHubGraphqlCacheEntry.findUnique({ where: { id } }),
      this.ttlSeconds(),
    ]);
    if (!entry) return null;
    return {
      ...this.entryView(entry, ttlSeconds),
      query: entry.query,
      variables: parseJson(entry.variablesJson),
      response: parseJson(entry.responseJson),
    };
  }

  async calls(
    limit = 50,
    offset = 0,
  ): Promise<GitHubPaginatedResult<GitHubApiCallView>> {
    const pagination = this.pagination(limit, offset);
    await this.pruneLogs();
    const prisma = await getPrismaClient();
    const [calls, total] = await Promise.all([
      prisma.gitHubApiCallLog.findMany({
        take: pagination.limit,
        skip: pagination.offset,
        orderBy: { createdAt: "desc" },
      }),
      prisma.gitHubApiCallLog.count(),
    ]);
    return {
      ...pagination,
      total,
      items: calls.map((call) => ({
        id: call.id,
        authentication: call.authentication as GitHubAuthentication,
        apiType: call.apiType as GitHubApiType,
        method: call.method,
        endpoint: call.endpoint,
        operation: call.operation,
        requestSource: call.requestSource as GitHubRequestSource,
        requestSummary: call.requestSummary,
        variables: parseJson(call.variablesJson),
        source: call.source as GitHubCallSource,
        durationMs: call.durationMs,
        statusCode: call.statusCode,
        error: call.error,
        servedStale: call.servedStale,
        pointCost: call.pointCost,
        pointsAvoided: call.pointsAvoided,
        rateLimitLimit: call.rateLimitLimit,
        rateLimitRemaining: call.rateLimitRemaining,
        rateLimitUsed: call.rateLimitUsed,
        rateLimitResetAt: call.rateLimitResetAt?.toISOString() ?? null,
        rateLimitResource: call.rateLimitResource,
        createdAt: call.createdAt.toISOString(),
      })),
    };
  }

  async metrics(): Promise<GitHubCacheMetrics> {
    await this.pruneLogs();
    const prisma = await getPrismaClient();
    const now = Date.now();
    const calls = await prisma.gitHubApiCallLog.findMany({
      where: {
        createdAt: {
          gte: new Date(now - WINDOW_DEFINITIONS.at(-1)!.milliseconds),
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const windows = WINDOW_DEFINITIONS.map((definition) =>
      this.metricWindow(
        definition.window,
        calls.filter(
          (call) => call.createdAt.getTime() >= now - definition.milliseconds,
        ),
      ),
    );
    const operations = [...new Set(calls.map((call) => call.operation))].sort();
    const operationRows: GitHubOperationMetric[] = operations.map(
      (operation) => ({
        operation,
        windows: WINDOW_DEFINITIONS.map((definition) =>
          this.metricWindow(
            definition.window,
            calls.filter(
              (call) =>
                call.operation === operation &&
                call.createdAt.getTime() >= now - definition.milliseconds,
            ),
          ),
        ),
      }),
    );
    return { windows, operations: operationRows };
  }

  private entryView(
    entry: {
      id: string;
      authentication: string;
      operation: string;
      endpoint: string;
      fetchedAt: Date;
      pointCost: number | null;
    },
    ttlSeconds: number,
  ): GitHubCachedEntryView {
    return {
      id: entry.id,
      authentication: entry.authentication as GitHubAuthentication,
      operation: entry.operation,
      endpoint: entry.endpoint,
      fetchedAt: entry.fetchedAt.toISOString(),
      pointCost: entry.pointCost,
      stale: Date.now() - entry.fetchedAt.getTime() >= ttlSeconds * 1000,
    };
  }

  private metricWindow(
    window: string,
    calls: Array<{
      source: string;
      durationMs: number;
      pointCost: number | null;
      pointsAvoided: number;
    }>,
  ): GitHubMetricWindow {
    const total = calls.length;
    return {
      window,
      total,
      live: calls.filter((call) => call.source === "LIVE").length,
      cache: calls.filter((call) => call.source === "CACHE").length,
      errors: calls.filter((call) => call.source === "ERROR").length,
      averageMs:
        total === 0
          ? 0
          : Math.round(
              calls.reduce((sum, call) => sum + call.durationMs, 0) / total,
            ),
      pointsUsed: calls.reduce(
        (sum, call) => sum + Math.max(0, call.pointCost ?? 0),
        0,
      ),
      pointsAvoided: calls.reduce(
        (sum, call) => sum + Math.max(0, call.pointsAvoided),
        0,
      ),
    };
  }

  private pagination(limit: number, offset: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("limit must be an integer from 1 to 100");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("offset must be a non-negative integer");
    }
    return { limit, offset };
  }

  private graphqlContext(input: {
    endpoint: string;
    requestSource: GitHubRequestSource;
    variables: Record<string, unknown>;
  }) {
    const variables = sanitizeRequestValue(input.variables);
    return {
      apiType: "GRAPHQL" as const,
      method: "POST",
      endpoint: input.endpoint,
      requestSource: input.requestSource,
      requestSummary: requestSummary(variables),
      variables,
    };
  }

  private async log(input: {
    authentication: GitHubAuthentication;
    apiType: GitHubApiType;
    method: string;
    endpoint: string;
    operation: string;
    requestSource: GitHubRequestSource;
    requestSummary: string;
    variables: unknown;
    source: GitHubCallSource;
    durationMs: number;
    statusCode?: number | null;
    error?: string | null;
    servedStale?: boolean;
    pointCost?: number | null;
    pointsAvoided?: number;
    rateLimit?: GitHubRateLimitMetadata | null;
  }): Promise<void> {
    await this.pruneLogs();
    const prisma = await getPrismaClient();
    await prisma.gitHubApiCallLog.create({
      data: {
        id: randomUUID(),
        authentication: input.authentication,
        apiType: input.apiType,
        method: input.method,
        endpoint: input.endpoint,
        operation: input.operation,
        requestSource: input.requestSource,
        requestSummary: input.requestSummary,
        variablesJson: stableStringify(sanitizeRequestValue(input.variables)),
        source: input.source,
        durationMs: Math.max(0, Math.round(input.durationMs)),
        statusCode: input.statusCode ?? null,
        error: input.error?.slice(0, 2000) ?? null,
        servedStale: input.servedStale ?? false,
        pointCost: input.pointCost ?? null,
        pointsAvoided: Math.max(0, input.pointsAvoided ?? 0),
        rateLimitLimit: input.rateLimit?.limit ?? null,
        rateLimitRemaining: input.rateLimit?.remaining ?? null,
        rateLimitUsed: input.rateLimit?.used ?? null,
        rateLimitResetAt: input.rateLimit?.resetAt ?? null,
        rateLimitResource: input.rateLimit?.resource ?? null,
      },
    });
  }

  private async pruneLogs(): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    const prisma = await getPrismaClient();
    await prisma.gitHubApiCallLog.deleteMany({
      where: { createdAt: { lt: new Date(now - LOG_RETENTION_MS) } },
    });
  }
}
