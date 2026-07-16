-- CreateTable
CREATE TABLE "CodebaseRepository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalOrigin" TEXT NOT NULL,
    "displayOrigin" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Codebase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "observedOrigin" TEXT NOT NULL,
    "branch" TEXT,
    "headSha" TEXT,
    "upstream" TEXT,
    "ahead" INTEGER,
    "behind" INTEGER,
    "syncState" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "statusError" TEXT,
    "lastCheckedAt" DATETIME,
    "lastFetchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Codebase_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Codebase_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "codebaseId" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'USER',
    CONSTRAINT "AgentJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentJob_ccusageCollectionId_fkey" FOREIGN KEY ("ccusageCollectionId") REFERENCES "CcusageCollection" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentJob_codebaseId_fkey" FOREIGN KEY ("codebaseId") REFERENCES "Codebase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentJob" ("agentId", "ccusageCollectionId", "createdAt", "error", "finishedAt", "id", "idempotencyKey", "kind", "payloadJson", "resultJson", "startedAt", "status", "timeoutSeconds", "updatedAt") SELECT "agentId", "ccusageCollectionId", "createdAt", "error", "finishedAt", "id", "idempotencyKey", "kind", "payloadJson", "resultJson", "startedAt", "status", "timeoutSeconds", "updatedAt" FROM "AgentJob";
DROP TABLE "AgentJob";
ALTER TABLE "new_AgentJob" RENAME TO "AgentJob";
CREATE INDEX "AgentJob_agentId_status_createdAt_idx" ON "AgentJob"("agentId", "status", "createdAt");
CREATE INDEX "AgentJob_ccusageCollectionId_status_idx" ON "AgentJob"("ccusageCollectionId", "status");
CREATE INDEX "AgentJob_codebaseId_status_createdAt_idx" ON "AgentJob"("codebaseId", "status", "createdAt");
CREATE UNIQUE INDEX "AgentJob_agentId_idempotencyKey_key" ON "AgentJob"("agentId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CodebaseRepository_canonicalOrigin_key" ON "CodebaseRepository"("canonicalOrigin");
CREATE INDEX "CodebaseRepository_name_idx" ON "CodebaseRepository"("name");
CREATE UNIQUE INDEX "Codebase_agentId_folder_key" ON "Codebase"("agentId", "folder");
CREATE INDEX "Codebase_repositoryId_idx" ON "Codebase"("repositoryId");
CREATE INDEX "Codebase_agentId_availability_idx" ON "Codebase"("agentId", "availability");
