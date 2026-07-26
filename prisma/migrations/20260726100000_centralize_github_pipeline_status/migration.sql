-- Add canonical commit-scoped pipeline snapshots and workflow/status records.
CREATE TABLE "GitHubPipelineSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryGithubId" TEXT NOT NULL,
    "repositoryNameWithOwner" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "pipelineStatus" TEXT NOT NULL,
    "graphqlRollupStatus" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "lastGraphqlSyncAt" DATETIME,
    "lastObservedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "GitHubPipelineSnapshot_repositoryGithubId_headSha_key"
ON "GitHubPipelineSnapshot"("repositoryGithubId", "headSha");
CREATE INDEX "GitHubPipelineSnapshot_lastObservedAt_idx"
ON "GitHubPipelineSnapshot"("lastObservedAt");

CREATE TABLE "GitHubPipelineRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "githubPipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "url" TEXT,
    "checkSuiteId" TEXT,
    "workflowRunId" TEXT,
    "workflowId" TEXT,
    "runNumber" INTEGER,
    "runAttempt" INTEGER,
    "canRetry" BOOLEAN NOT NULL DEFAULT false,
    "retryUnavailableReason" TEXT,
    "jobsJson" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "githubUpdatedAt" DATETIME,
    "sourceFetchedAt" DATETIME NOT NULL,
    "lastObservedAt" DATETIME NOT NULL,
    "optimisticUntil" DATETIME,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubPipelineRecord_snapshotId_fkey"
      FOREIGN KEY ("snapshotId") REFERENCES "GitHubPipelineSnapshot" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "GitHubPipelineRecord_snapshotId_identityKey_key"
ON "GitHubPipelineRecord"("snapshotId", "identityKey");
CREATE INDEX "GitHubPipelineRecord_snapshotId_isCurrent_idx"
ON "GitHubPipelineRecord"("snapshotId", "isCurrent");
CREATE INDEX "GitHubPipelineRecord_workflowRunId_idx"
ON "GitHubPipelineRecord"("workflowRunId");
CREATE INDEX "GitHubPipelineRecord_checkSuiteId_idx"
ON "GitHubPipelineRecord"("checkSuiteId");
CREATE INDEX "GitHubPipelineRecord_lastObservedAt_idx"
ON "GitHubPipelineRecord"("lastObservedAt");

-- Preserve the most recently observed worktree snapshot without contacting GitHub.
INSERT OR IGNORE INTO "GitHubPipelineSnapshot" (
  "id", "repositoryGithubId", "repositoryNameWithOwner", "repositoryUrl",
  "headSha", "pipelineStatus", "revision", "lastObservedAt", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), pr."repositoryGithubId", pr."repositoryNameWithOwner",
  pr."repositoryUrl", pr."headRefOid", pr."pipelineStatus", 1,
  max(pr."updatedAt"), min(pr."createdAt"), max(pr."updatedAt")
FROM "WorktreePullRequest" pr
WHERE pr."headRefOid" <> ''
GROUP BY pr."repositoryGithubId", pr."headRefOid";

INSERT OR IGNORE INTO "GitHubPipelineRecord" (
  "id", "snapshotId", "identityKey", "githubPipelineId", "name", "status",
  "url", "checkSuiteId", "workflowRunId", "workflowId", "runNumber", "runAttempt",
  "canRetry", "retryUnavailableReason", "jobsJson", "source", "githubUpdatedAt",
  "sourceFetchedAt", "lastObservedAt", "isCurrent", "createdAt", "updatedAt"
)
SELECT
  lower(hex(randomblob(16))), snapshot."id",
  CASE
    WHEN json_extract(pipeline.value, '$.checkSuiteId') IS NOT NULL
      THEN 'CHECK_SUITE:' || json_extract(pipeline.value, '$.checkSuiteId')
    WHEN json_extract(pipeline.value, '$.workflowRunId') IS NOT NULL
      THEN 'WORKFLOW_RUN:' || json_extract(pipeline.value, '$.workflowRunId')
    ELSE 'LEGACY:' || json_extract(pipeline.value, '$.id')
  END,
  json_extract(pipeline.value, '$.id'),
  coalesce(json_extract(pipeline.value, '$.name'), 'GitHub pipeline'),
  coalesce(json_extract(pipeline.value, '$.status'), 'NONE'),
  json_extract(pipeline.value, '$.url'),
  json_extract(pipeline.value, '$.checkSuiteId'),
  json_extract(pipeline.value, '$.workflowRunId'),
  json_extract(pipeline.value, '$.workflowId'),
  json_extract(pipeline.value, '$.runNumber'),
  json_extract(pipeline.value, '$.runAttempt'),
  coalesce(json_extract(pipeline.value, '$.canRetry'), false),
  json_extract(pipeline.value, '$.retryUnavailableReason'),
  coalesce(json_extract(pipeline.value, '$.jobs'), '[]'),
  'LEGACY', pr."updatedAt", pr."updatedAt", pr."updatedAt", true,
  pr."createdAt", pr."updatedAt"
FROM "WorktreePullRequest" pr
JOIN "GitHubPipelineSnapshot" snapshot
  ON snapshot."repositoryGithubId" = pr."repositoryGithubId"
 AND snapshot."headSha" = pr."headRefOid"
JOIN json_each(pr."pipelinesJson") pipeline
WHERE pr."headRefOid" <> ''
  AND pr."updatedAt" = (
    SELECT max(latest."updatedAt")
    FROM "WorktreePullRequest" latest
    WHERE latest."repositoryGithubId" = pr."repositoryGithubId"
      AND latest."headRefOid" = pr."headRefOid"
  );

-- Pipeline state now lives only in the canonical tables.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorktreePullRequest" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "githubId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "repositoryGithubId" TEXT NOT NULL,
    "repositoryNameWithOwner" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "labelsJson" TEXT NOT NULL,
    "jiraKey" TEXT,
    "reviewDecision" TEXT NOT NULL,
    "unresolvedReviewThreadCount" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL,
    "mergeable" TEXT NOT NULL,
    "mergeStateStatus" TEXT NOT NULL,
    "autoMergeEnabled" BOOLEAN NOT NULL,
    "viewerCanEnableAutoMerge" BOOLEAN NOT NULL,
    "viewerCanDisableAutoMerge" BOOLEAN NOT NULL,
    "headRefOid" TEXT NOT NULL,
    "headRefName" TEXT NOT NULL,
    "githubCreatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorktreePullRequest_worktreeId_fkey"
      FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorktreePullRequest" SELECT
  "worktreeId", "githubId", "number", "title", "url", "repositoryGithubId",
  "repositoryNameWithOwner", "repositoryUrl", "labelsJson", "jiraKey",
  "reviewDecision", "unresolvedReviewThreadCount", "state", "isDraft",
  "mergeable", "mergeStateStatus", "autoMergeEnabled", "viewerCanEnableAutoMerge",
  "viewerCanDisableAutoMerge", "headRefOid", "headRefName", "githubCreatedAt",
  "createdAt", "updatedAt"
FROM "WorktreePullRequest";
DROP TABLE "WorktreePullRequest";
ALTER TABLE "new_WorktreePullRequest" RENAME TO "WorktreePullRequest";
CREATE INDEX "WorktreePullRequest_githubId_idx" ON "WorktreePullRequest"("githubId");
PRAGMA foreign_keys=ON;

ALTER TABLE "GitHubAppSettings" ADD COLUMN "checksPermission" TEXT;
ALTER TABLE "GitHubAppSettings" ADD COLUMN "commitStatusesPermission" TEXT;
ALTER TABLE "GitHubAppSettings" ADD COLUMN "webhookEventsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "GitHubAppSettings" ADD COLUMN "enhancedPipelineWebhooksEnabled" BOOLEAN NOT NULL DEFAULT false;
