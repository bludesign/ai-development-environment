-- CreateTable
CREATE TABLE "JiraSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteUrl" TEXT,
    "email" TEXT,
    "apiToken" TEXT,
    "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JiraProject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jiraId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JiraSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "boardId" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JiraSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "JiraProject" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JiraCacheEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cacheKey" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "paramsJson" TEXT NOT NULL,
    "responseJson" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    "sourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "JiraCacheEntry_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "JiraSource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JiraCachedTicket" (
    "issueKey" TEXT NOT NULL PRIMARY KEY,
    "projectKey" TEXT NOT NULL,
    "summaryJson" TEXT,
    "summaryFetchedAt" DATETIME,
    "detailJson" TEXT,
    "detailFetchedAt" DATETIME,
    "commentsJson" TEXT,
    "commentsFetchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JiraCacheEntryIssue" (
    "cacheEntryId" TEXT NOT NULL,
    "issueKey" TEXT NOT NULL,
    PRIMARY KEY ("cacheEntryId", "issueKey"),
    CONSTRAINT "JiraCacheEntryIssue_cacheEntryId_fkey" FOREIGN KEY ("cacheEntryId") REFERENCES "JiraCacheEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JiraCacheEntryIssue_issueKey_fkey" FOREIGN KEY ("issueKey") REFERENCES "JiraCachedTicket" ("issueKey") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JiraApiCallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operation" TEXT NOT NULL,
    "requestSummary" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    "itemCount" INTEGER,
    "servedStale" BOOLEAN NOT NULL DEFAULT false,
    "sourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JiraApiCallLog_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "JiraSource" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "JiraProject_jiraId_key" ON "JiraProject"("jiraId");
CREATE UNIQUE INDEX "JiraProject_key_key" ON "JiraProject"("key");
CREATE UNIQUE INDEX "JiraSource_projectId_name_key" ON "JiraSource"("projectId", "name");
CREATE INDEX "JiraSource_projectId_position_idx" ON "JiraSource"("projectId", "position");
CREATE UNIQUE INDEX "JiraCacheEntry_cacheKey_key" ON "JiraCacheEntry"("cacheKey");
CREATE INDEX "JiraCacheEntry_operation_fetchedAt_idx" ON "JiraCacheEntry"("operation", "fetchedAt");
CREATE INDEX "JiraCacheEntry_sourceId_fetchedAt_idx" ON "JiraCacheEntry"("sourceId", "fetchedAt");
CREATE INDEX "JiraCachedTicket_projectKey_updatedAt_idx" ON "JiraCachedTicket"("projectKey", "updatedAt");
CREATE INDEX "JiraCachedTicket_updatedAt_idx" ON "JiraCachedTicket"("updatedAt");
CREATE INDEX "JiraCacheEntryIssue_issueKey_idx" ON "JiraCacheEntryIssue"("issueKey");
CREATE INDEX "JiraApiCallLog_createdAt_idx" ON "JiraApiCallLog"("createdAt");
CREATE INDEX "JiraApiCallLog_operation_source_createdAt_idx" ON "JiraApiCallLog"("operation", "source", "createdAt");
CREATE INDEX "JiraApiCallLog_sourceId_createdAt_idx" ON "JiraApiCallLog"("sourceId", "createdAt");
