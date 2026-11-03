CREATE TABLE "WorktreeSyncBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "appId" TEXT,
    "agentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME
);

CREATE TABLE "WorktreeSyncItem" (
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
    "baseBranch" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "gitDirectory" TEXT NOT NULL,
    "expectedOrigin" TEXT NOT NULL,
    "ticketKey" TEXT,
    "ticketTitle" TEXT,
    "baseBehind" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "jobId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "WorktreeSyncItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "WorktreeSyncBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorktreeSyncBatch_requestId_key" ON "WorktreeSyncBatch"("requestId");
CREATE INDEX "WorktreeSyncBatch_status_createdAt_idx" ON "WorktreeSyncBatch"("status", "createdAt");
CREATE UNIQUE INDEX "WorktreeSyncItem_jobId_key" ON "WorktreeSyncItem"("jobId");
CREATE UNIQUE INDEX "WorktreeSyncItem_batchId_worktreeId_key" ON "WorktreeSyncItem"("batchId", "worktreeId");
CREATE INDEX "WorktreeSyncItem_status_codebaseId_createdAt_idx" ON "WorktreeSyncItem"("status", "codebaseId", "createdAt");
