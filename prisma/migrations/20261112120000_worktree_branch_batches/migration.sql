CREATE TABLE "WorktreeBranchBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "appId" TEXT,
    "agentId" TEXT,
    "mode" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "ticketKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME
);

CREATE TABLE "WorktreeBranchItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "worktreeId" TEXT NOT NULL,
    "codebaseId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "sourceBranch" TEXT,
    "baseBranch" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "gitDirectory" TEXT NOT NULL,
    "expectedOrigin" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "jobId" TEXT,
    "error" TEXT,
    "warning" TEXT,
    CONSTRAINT "WorktreeBranchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "WorktreeBranchBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorktreeBranchBatch_requestId_key" ON "WorktreeBranchBatch"("requestId");
CREATE INDEX "WorktreeBranchBatch_status_createdAt_idx" ON "WorktreeBranchBatch"("status", "createdAt");
CREATE INDEX "WorktreeBranchBatch_appId_agentId_status_createdAt_idx" ON "WorktreeBranchBatch"("appId", "agentId", "status", "createdAt");
CREATE UNIQUE INDEX "WorktreeBranchItem_jobId_key" ON "WorktreeBranchItem"("jobId");
CREATE UNIQUE INDEX "WorktreeBranchItem_batchId_worktreeId_key" ON "WorktreeBranchItem"("batchId", "worktreeId");
CREATE UNIQUE INDEX "WorktreeBranchItem_batchId_codebaseId_key" ON "WorktreeBranchItem"("batchId", "codebaseId");
CREATE INDEX "WorktreeBranchItem_status_codebaseId_idx" ON "WorktreeBranchItem"("status", "codebaseId");
