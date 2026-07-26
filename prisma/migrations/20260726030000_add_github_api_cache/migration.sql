ALTER TABLE "GitHubSettings" ADD COLUMN "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300;

CREATE TABLE "GitHubGraphqlCacheEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cacheKey" TEXT NOT NULL,
    "authentication" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "variablesJson" TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    "pointCost" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "GitHubApiCallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authentication" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    "servedStale" BOOLEAN NOT NULL DEFAULT false,
    "pointCost" INTEGER,
    "pointsAvoided" INTEGER NOT NULL DEFAULT 0,
    "rateLimitLimit" INTEGER,
    "rateLimitRemaining" INTEGER,
    "rateLimitUsed" INTEGER,
    "rateLimitResetAt" DATETIME,
    "rateLimitResource" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "GitHubRateLimitSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "authentication" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "limit" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "used" INTEGER NOT NULL,
    "resetAt" DATETIME NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "GitHubGraphqlCacheEntry_cacheKey_key" ON "GitHubGraphqlCacheEntry"("cacheKey");
CREATE INDEX "GitHubGraphqlCacheEntry_authentication_operation_fetchedAt_idx" ON "GitHubGraphqlCacheEntry"("authentication", "operation", "fetchedAt");
CREATE INDEX "GitHubGraphqlCacheEntry_fetchedAt_idx" ON "GitHubGraphqlCacheEntry"("fetchedAt");
CREATE INDEX "GitHubApiCallLog_createdAt_idx" ON "GitHubApiCallLog"("createdAt");
CREATE INDEX "GitHubApiCallLog_operation_source_createdAt_idx" ON "GitHubApiCallLog"("operation", "source", "createdAt");
CREATE INDEX "GitHubApiCallLog_authentication_createdAt_idx" ON "GitHubApiCallLog"("authentication", "createdAt");
CREATE UNIQUE INDEX "GitHubRateLimitSnapshot_authentication_resource_key" ON "GitHubRateLimitSnapshot"("authentication", "resource");
CREATE INDEX "GitHubRateLimitSnapshot_resource_observedAt_idx" ON "GitHubRateLimitSnapshot"("resource", "observedAt");
