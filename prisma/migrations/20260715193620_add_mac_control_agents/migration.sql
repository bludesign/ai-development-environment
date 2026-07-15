-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "osVersion" TEXT NOT NULL,
    "architecture" TEXT NOT NULL,
    "capabilitiesJson" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "lastSeenAt" DATETIME,
    "disconnectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentEnrollmentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AgentJob" (
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
    CONSTRAINT "AgentJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentJobLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentJobLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentAuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "ipAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentAuditEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_secretHash_key" ON "Agent"("secretHash");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEnrollmentToken_tokenHash_key" ON "AgentEnrollmentToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AgentJob_agentId_status_createdAt_idx" ON "AgentJob"("agentId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentJob_agentId_idempotencyKey_key" ON "AgentJob"("agentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentJobLog_jobId_createdAt_idx" ON "AgentJobLog"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentJobLog_jobId_sequence_key" ON "AgentJobLog"("jobId", "sequence");

-- CreateIndex
CREATE INDEX "AgentAuditEvent_agentId_createdAt_idx" ON "AgentAuditEvent"("agentId", "createdAt");
