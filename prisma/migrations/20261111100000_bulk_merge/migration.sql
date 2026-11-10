ALTER TABLE "WorktreeAutoMerge" ADD COLUMN "manualMergeReviewJson" TEXT;
ALTER TABLE "GitLabMergeOperation" ADD COLUMN "manualMergeReviewJson" TEXT;

CREATE TABLE "WorktreeMergeBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "appId" TEXT,
    "agentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME
);

CREATE TABLE "WorktreeMergeItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "worktreeId" TEXT NOT NULL,
    "codebaseId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "gitDirectory" TEXT NOT NULL,
    "sourceOrigin" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "activeRequestKey" TEXT,
    "requestNumber" INTEGER NOT NULL,
    "requestTitle" TEXT NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "reviewedHeadSha" TEXT NOT NULL,
    "targetBranch" TEXT NOT NULL,
    "settingsJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "postMergeError" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "WorktreeMergeItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "WorktreeMergeBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorktreeMergeBatch_requestId_key" ON "WorktreeMergeBatch"("requestId");
CREATE INDEX "WorktreeMergeBatch_status_createdAt_idx" ON "WorktreeMergeBatch"("status", "createdAt");
CREATE INDEX "WorktreeMergeBatch_appId_agentId_createdAt_idx" ON "WorktreeMergeBatch"("appId", "agentId", "createdAt");
CREATE UNIQUE INDEX "WorktreeMergeItem_batchId_position_key" ON "WorktreeMergeItem"("batchId", "position");
CREATE UNIQUE INDEX "WorktreeMergeItem_batchId_worktreeId_key" ON "WorktreeMergeItem"("batchId", "worktreeId");
CREATE UNIQUE INDEX "WorktreeMergeItem_batchId_requestKey_key" ON "WorktreeMergeItem"("batchId", "requestKey");
CREATE UNIQUE INDEX "WorktreeMergeItem_activeRequestKey_key" ON "WorktreeMergeItem"("activeRequestKey");
CREATE INDEX "WorktreeMergeItem_requestKey_status_idx" ON "WorktreeMergeItem"("requestKey", "status");
