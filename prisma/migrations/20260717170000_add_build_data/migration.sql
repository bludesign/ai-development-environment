ALTER TABLE "Agent" ADD COLUMN "derivedDataLocationMode" TEXT NOT NULL DEFAULT 'DEFAULT';
ALTER TABLE "Agent" ADD COLUMN "derivedDataPath" TEXT;

CREATE TABLE "BuildDataCollection" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deadlineAt" DATETIME NOT NULL,
  "finishedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "BuildDataCollectionAgent" (
  "collectionId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "initialStatus" TEXT NOT NULL,
  "error" TEXT,
  PRIMARY KEY ("collectionId", "agentId"),
  CONSTRAINT "BuildDataCollectionAgent_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "BuildDataCollection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BuildDataCollectionAgent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "BuildDataDeletionHistory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT,
  "agentName" TEXT NOT NULL,
  "folderName" TEXT NOT NULL,
  "worktreeId" TEXT,
  "worktreePath" TEXT,
  "source" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "deletedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BuildDataDeletionHistory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BuildDataDeletionHistory_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "BuildDataDeleteProjection" (
  "jobId" TEXT NOT NULL PRIMARY KEY,
  "projectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentJob" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "resultJson" TEXT,
  "error" TEXT,
  "timeoutSeconds" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL,
  "ccusageCollectionId" TEXT,
  "buildDataCollectionId" TEXT,
  "codebaseId" TEXT,
  "worktreeId" TEXT,
  "visibility" TEXT NOT NULL DEFAULT 'USER',
  CONSTRAINT "AgentJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentJob_ccusageCollectionId_fkey" FOREIGN KEY ("ccusageCollectionId") REFERENCES "CcusageCollection" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AgentJob_buildDataCollectionId_fkey" FOREIGN KEY ("buildDataCollectionId") REFERENCES "BuildDataCollection" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "AgentJob_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentJob" (
  "agentId", "ccusageCollectionId", "codebaseId", "createdAt", "error",
  "finishedAt", "id", "idempotencyKey", "kind", "payloadJson", "resultJson",
  "startedAt", "status", "timeoutSeconds", "updatedAt", "visibility", "worktreeId"
)
SELECT
  "agentId", "ccusageCollectionId", "codebaseId", "createdAt", "error",
  "finishedAt", "id", "idempotencyKey", "kind", "payloadJson", "resultJson",
  "startedAt", "status", "timeoutSeconds", "updatedAt", "visibility", "worktreeId"
FROM "AgentJob";
DROP TABLE "AgentJob";
ALTER TABLE "new_AgentJob" RENAME TO "AgentJob";
CREATE INDEX "AgentJob_agentId_status_createdAt_idx" ON "AgentJob"("agentId", "status", "createdAt");
CREATE INDEX "AgentJob_ccusageCollectionId_status_idx" ON "AgentJob"("ccusageCollectionId", "status");
CREATE INDEX "AgentJob_buildDataCollectionId_status_idx" ON "AgentJob"("buildDataCollectionId", "status");
CREATE INDEX "AgentJob_codebaseId_status_createdAt_idx" ON "AgentJob"("codebaseId", "status", "createdAt");
CREATE INDEX "AgentJob_worktreeId_status_createdAt_idx" ON "AgentJob"("worktreeId", "status", "createdAt");
CREATE UNIQUE INDEX "AgentJob_agentId_idempotencyKey_key" ON "AgentJob"("agentId", "idempotencyKey");
CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
ON "AgentJob"("codebaseId")
WHERE "codebaseId" IS NOT NULL AND "status" IN ('QUEUED', 'RUNNING');
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE INDEX "BuildDataCollection_finishedAt_deadlineAt_idx" ON "BuildDataCollection"("finishedAt", "deadlineAt");
CREATE INDEX "BuildDataCollectionAgent_agentId_idx" ON "BuildDataCollectionAgent"("agentId");
CREATE UNIQUE INDEX "BuildDataDeletionHistory_jobId_targetKey_key" ON "BuildDataDeletionHistory"("jobId", "targetKey");
CREATE INDEX "BuildDataDeletionHistory_deletedAt_idx" ON "BuildDataDeletionHistory"("deletedAt");
CREATE INDEX "BuildDataDeletionHistory_agentId_deletedAt_idx" ON "BuildDataDeletionHistory"("agentId", "deletedAt");
