-- CreateTable
CREATE TABLE "CcusageCollection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deadlineAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CcusageCollectionAgent" (
    "collectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "initialStatus" TEXT NOT NULL,
    "error" TEXT,

    PRIMARY KEY ("collectionId", "agentId"),
    CONSTRAINT "CcusageCollectionAgent_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "CcusageCollection" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CcusageCollectionAgent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
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
    CONSTRAINT "AgentJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentJob_ccusageCollectionId_fkey" FOREIGN KEY ("ccusageCollectionId") REFERENCES "CcusageCollection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentJob" ("agentId", "createdAt", "error", "finishedAt", "id", "idempotencyKey", "kind", "payloadJson", "resultJson", "startedAt", "status", "timeoutSeconds", "updatedAt") SELECT "agentId", "createdAt", "error", "finishedAt", "id", "idempotencyKey", "kind", "payloadJson", "resultJson", "startedAt", "status", "timeoutSeconds", "updatedAt" FROM "AgentJob";
DROP TABLE "AgentJob";
ALTER TABLE "new_AgentJob" RENAME TO "AgentJob";
CREATE INDEX "AgentJob_agentId_status_createdAt_idx" ON "AgentJob"("agentId", "status", "createdAt");
CREATE INDEX "AgentJob_ccusageCollectionId_status_idx" ON "AgentJob"("ccusageCollectionId", "status");
CREATE UNIQUE INDEX "AgentJob_agentId_idempotencyKey_key" ON "AgentJob"("agentId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CcusageCollection_finishedAt_deadlineAt_idx" ON "CcusageCollection"("finishedAt", "deadlineAt");

-- CreateIndex
CREATE INDEX "CcusageCollectionAgent_agentId_idx" ON "CcusageCollectionAgent"("agentId");
