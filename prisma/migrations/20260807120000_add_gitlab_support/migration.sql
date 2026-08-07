ALTER TABLE "WorktreePullRequest" ADD COLUMN "sourceControlProvider" TEXT NOT NULL DEFAULT 'GITHUB';
ALTER TABLE "GitHubPipelineSnapshot" ADD COLUMN "sourceControlProvider" TEXT NOT NULL DEFAULT 'GITHUB';
ALTER TABLE "GitHubPipelineRecord" ADD COLUMN "sourceControlProvider" TEXT NOT NULL DEFAULT 'GITHUB';

CREATE TABLE "WorktreeGitLabMergeRequest" (
  "worktreeId" TEXT NOT NULL PRIMARY KEY,
  "sourceControlProvider" TEXT NOT NULL DEFAULT 'GITLAB',
  "gitlabId" TEXT NOT NULL,
  "iid" INTEGER NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "webUrl" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "draft" BOOLEAN NOT NULL,
  "sourceBranch" TEXT NOT NULL,
  "targetBranch" TEXT NOT NULL,
  "sha" TEXT NOT NULL,
  "authorJson" TEXT NOT NULL,
  "reviewersJson" TEXT NOT NULL,
  "labelsJson" TEXT NOT NULL,
  "detailedMergeStatus" TEXT NOT NULL,
  "mergeWhenPipelineSucceeds" BOOLEAN NOT NULL,
  "squashOnMerge" BOOLEAN NOT NULL,
  "hasConflicts" BOOLEAN NOT NULL,
  "blockingDiscussionsResolved" BOOLEAN NOT NULL,
  "gitlabCreatedAt" DATETIME NOT NULL,
  "gitlabUpdatedAt" DATETIME NOT NULL,
  "mergedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "WorktreeGitLabMergeRequest_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "WorktreeGitLabMergeRequest_gitlabId_idx" ON "WorktreeGitLabMergeRequest"("gitlabId");
CREATE INDEX "WorktreeGitLabMergeRequest_projectId_iid_idx" ON "WorktreeGitLabMergeRequest"("projectId", "iid");

CREATE TABLE "GitLabSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "currentUserId" TEXT,
  "currentUsername" TEXT,
  "currentUserDisplayName" TEXT,
  "currentUserAvatarUrl" TEXT,
  "currentUserWebUrl" TEXT,
  "version" TEXT,
  "revision" TEXT,
  "verifiedAt" DATETIME,
  "pipelinePollIntervalSeconds" INTEGER NOT NULL DEFAULT 60,
  "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "GitLabProject" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "pathWithNamespace" TEXT NOT NULL,
  "webUrl" TEXT NOT NULL,
  "defaultBranch" TEXT,
  "visibility" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "webhookId" TEXT,
  "webhookState" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  "webhookError" TEXT,
  "webhookConfiguredAt" DATETIME,
  "webhookLastReceivedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "GitLabProject_pathWithNamespace_key" ON "GitLabProject"("pathWithNamespace");
CREATE INDEX "GitLabProject_enabled_pathWithNamespace_idx" ON "GitLabProject"("enabled", "pathWithNamespace");

CREATE TABLE "GitLabRestCacheEntry" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cacheKey" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "requestJson" TEXT NOT NULL,
  "responseJson" TEXT NOT NULL,
  "fetchedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "GitLabRestCacheEntry_cacheKey_key" ON "GitLabRestCacheEntry"("cacheKey");
CREATE INDEX "GitLabRestCacheEntry_operation_fetchedAt_idx" ON "GitLabRestCacheEntry"("operation", "fetchedAt");
CREATE INDEX "GitLabRestCacheEntry_fetchedAt_idx" ON "GitLabRestCacheEntry"("fetchedAt");

CREATE TABLE "GitLabRestCacheTtlOverride" (
  "operation" TEXT NOT NULL PRIMARY KEY,
  "ttlSeconds" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "GitLabApiCallLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "method" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "requestSource" TEXT NOT NULL,
  "requestSummary" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "statusCode" INTEGER,
  "error" TEXT,
  "servedStale" BOOLEAN NOT NULL DEFAULT false,
  "rateLimitLimit" INTEGER,
  "rateLimitRemaining" INTEGER,
  "rateLimitResetAt" DATETIME,
  "requestId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GitLabApiCallLog_createdAt_idx" ON "GitLabApiCallLog"("createdAt");
CREATE INDEX "GitLabApiCallLog_operation_source_createdAt_idx" ON "GitLabApiCallLog"("operation", "source", "createdAt");

CREATE TABLE "GitLabRateLimitSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "resource" TEXT NOT NULL,
  "limit" INTEGER NOT NULL,
  "remaining" INTEGER NOT NULL,
  "resetAt" DATETIME,
  "observedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "GitLabRateLimitSnapshot_resource_key" ON "GitLabRateLimitSnapshot"("resource");

CREATE TABLE "GitLabWebhookDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "webhookId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "projectId" TEXT,
  "objectKind" TEXT,
  "action" TEXT,
  "outcome" TEXT NOT NULL,
  "error" TEXT,
  "payloadJson" TEXT NOT NULL,
  "receivedAt" DATETIME NOT NULL,
  "processedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "GitLabWebhookDelivery_webhookId_key" ON "GitLabWebhookDelivery"("webhookId");
CREATE INDEX "GitLabWebhookDelivery_receivedAt_idx" ON "GitLabWebhookDelivery"("receivedAt");
CREATE INDEX "GitLabWebhookDelivery_projectId_receivedAt_idx" ON "GitLabWebhookDelivery"("projectId", "receivedAt");

CREATE TABLE "GitLabPipelineSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "headSha" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "lastObservedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "GitLabPipelineSnapshot_projectId_headSha_key" ON "GitLabPipelineSnapshot"("projectId", "headSha");
CREATE INDEX "GitLabPipelineSnapshot_lastObservedAt_idx" ON "GitLabPipelineSnapshot"("lastObservedAt");

CREATE TABLE "GitLabPipelineRecord" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "snapshotId" TEXT NOT NULL,
  "pipelineId" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "webUrl" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "jobsJson" TEXT NOT NULL DEFAULT '[]',
  "gitlabUpdatedAt" DATETIME,
  "lastObservedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "GitLabPipelineRecord_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "GitLabPipelineSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GitLabPipelineRecord_snapshotId_pipelineId_key" ON "GitLabPipelineRecord"("snapshotId", "pipelineId");
CREATE INDEX "GitLabPipelineRecord_pipelineId_idx" ON "GitLabPipelineRecord"("pipelineId");
CREATE INDEX "GitLabPipelineRecord_lastObservedAt_idx" ON "GitLabPipelineRecord"("lastObservedAt");

CREATE TABLE "GitLabAutoRetryRule" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "pipelineId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "maxAttempts" INTEGER NOT NULL DEFAULT 1,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "lastAttemptAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "GitLabAutoRetryRule_projectId_enabled_idx" ON "GitLabAutoRetryRule"("projectId", "enabled");

CREATE TABLE "GitLabAutoRetryExecution" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ruleId" TEXT NOT NULL,
  "pipelineId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "GitLabAutoRetryExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "GitLabAutoRetryRule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GitLabAutoRetryExecution_ruleId_pipelineId_attempt_key" ON "GitLabAutoRetryExecution"("ruleId", "pipelineId", "attempt");
CREATE INDEX "GitLabAutoRetryExecution_pipelineId_createdAt_idx" ON "GitLabAutoRetryExecution"("pipelineId", "createdAt");
