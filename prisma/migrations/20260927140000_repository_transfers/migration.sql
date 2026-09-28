CREATE TABLE "RepositoryTransferOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUING',
    "appId" TEXT,
    "resultJson" TEXT NOT NULL DEFAULT '{}',
    "requestHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME
);
CREATE TABLE "RepositoryTransferItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "codebaseId" TEXT,
    "remoteUrl" TEXT NOT NULL,
    "baseDirectory" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "jobId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RepositoryTransferItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "RepositoryTransferOperation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RepositoryTransferOperation_requestId_key" ON "RepositoryTransferOperation"("requestId");
CREATE INDEX "RepositoryTransferOperation_status_createdAt_idx" ON "RepositoryTransferOperation"("status", "createdAt");
CREATE INDEX "RepositoryTransferOperation_appId_createdAt_idx" ON "RepositoryTransferOperation"("appId", "createdAt");
CREATE UNIQUE INDEX "RepositoryTransferItem_jobId_key" ON "RepositoryTransferItem"("jobId");
CREATE UNIQUE INDEX "RepositoryTransferItem_operationId_repositoryId_agentId_key" ON "RepositoryTransferItem"("operationId", "repositoryId", "agentId");
CREATE INDEX "RepositoryTransferItem_agentId_destinationPath_status_idx" ON "RepositoryTransferItem"("agentId", "destinationPath", "status");
