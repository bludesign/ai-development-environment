-- CreateTable
CREATE TABLE "ExternalPipelineActions" (
    "repositoryId" TEXT NOT NULL PRIMARY KEY,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "retryScript" TEXT NOT NULL DEFAULT '',
    "cancelScript" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExternalPipelineActions_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExternalPipelineExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "targetedStatusIdsJson" TEXT NOT NULL,
    "nativeStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    "externalStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    "message" TEXT,
    "outputJson" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "ExternalPipelineExecution_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExternalPipelineActionClaim" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExternalPipelineRetryState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "observedKey" TEXT,
    "awaitingUpdate" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ExternalPipelineCancellation" (
    "targetUrl" TEXT,
    "identityKey" TEXT NOT NULL PRIMARY KEY,
    "statusId" TEXT NOT NULL,
    "canceledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExternalPipelineRetryObservation" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "stateKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLAIMED',
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ExternalPipelineExecution_projectId_pipelineId_startedAt_idx" ON "ExternalPipelineExecution"("projectId", "pipelineId", "startedAt");

-- CreateIndex
CREATE INDEX "ExternalPipelineRetryState_ruleId_idx" ON "ExternalPipelineRetryState"("ruleId");

-- CreateIndex
CREATE INDEX "ExternalPipelineRetryObservation_stateKey_idx" ON "ExternalPipelineRetryObservation"("stateKey");

