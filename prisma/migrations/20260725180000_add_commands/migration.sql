CREATE TABLE "CommandDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "script" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetAgentId" TEXT,
    "targetRepositoryId" TEXT,
    "restartPolicy" TEXT NOT NULL DEFAULT 'NEVER',
    "restartLimit" INTEGER DEFAULT 3,
    "quickActionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quickActionIconKey" TEXT NOT NULL DEFAULT 'terminal',
    "quickActionButtonVariant" TEXT NOT NULL DEFAULT 'default',
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommandDefinition_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommandDefinition_targetRepositoryId_fkey" FOREIGN KEY ("targetRepositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CommandRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayNumber" INTEGER NOT NULL,
    "commandId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "snapshotName" TEXT NOT NULL,
    "snapshotDescription" TEXT NOT NULL DEFAULT '',
    "snapshotScript" TEXT NOT NULL,
    "snapshotTargetKind" TEXT NOT NULL,
    "snapshotRestartPolicy" TEXT NOT NULL DEFAULT 'NEVER',
    "snapshotRestartLimit" INTEGER,
    "snapshotJson" TEXT NOT NULL DEFAULT '{}',
    "agentId" TEXT,
    "worktreeId" TEXT,
    "agentName" TEXT NOT NULL,
    "agentHostname" TEXT NOT NULL,
    "worktreePath" TEXT,
    "worktreeBranch" TEXT,
    "restartCount" INTEGER NOT NULL DEFAULT 0,
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,
    "nextRestartAt" DATETIME,
    "predecessorRunId" TEXT,
    "error" TEXT,
    "exitCode" INTEGER,
    "signal" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommandRun_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "CommandDefinition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CommandRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommandRun_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CommandRun_predecessorRunId_fkey" FOREIGN KEY ("predecessorRunId") REFERENCES "CommandRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CommandRunAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "agentJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "exitCode" INTEGER,
    "signal" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "completionProcessedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CommandRunAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CommandRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CommandRunAttempt_agentJobId_fkey" FOREIGN KEY ("agentJobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "CommandRunOutputChunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stream" TEXT NOT NULL,
    "dataBase64" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommandRunOutputChunk_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "CommandRunAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "CommandRunNumberSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nextValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "CommandRun_displayNumber_key" ON "CommandRun"("displayNumber");
CREATE UNIQUE INDEX "CommandRun_idempotencyKey_key" ON "CommandRun"("idempotencyKey");
CREATE UNIQUE INDEX "CommandRun_predecessorRunId_key" ON "CommandRun"("predecessorRunId");
CREATE UNIQUE INDEX "CommandRunAttempt_agentJobId_key" ON "CommandRunAttempt"("agentJobId");
CREATE UNIQUE INDEX "CommandRunAttempt_runId_attempt_key" ON "CommandRunAttempt"("runId", "attempt");
CREATE UNIQUE INDEX "CommandRunOutputChunk_attemptId_sequence_key" ON "CommandRunOutputChunk"("attemptId", "sequence");

CREATE INDEX "CommandDefinition_archivedAt_updatedAt_idx" ON "CommandDefinition"("archivedAt", "updatedAt");
CREATE INDEX "CommandDefinition_targetKind_targetAgentId_idx" ON "CommandDefinition"("targetKind", "targetAgentId");
CREATE INDEX "CommandDefinition_targetKind_targetRepositoryId_idx" ON "CommandDefinition"("targetKind", "targetRepositoryId");
CREATE INDEX "CommandRun_commandId_createdAt_idx" ON "CommandRun"("commandId", "createdAt");
CREATE INDEX "CommandRun_agentId_status_createdAt_idx" ON "CommandRun"("agentId", "status", "createdAt");
CREATE INDEX "CommandRun_worktreeId_status_createdAt_idx" ON "CommandRun"("worktreeId", "status", "createdAt");
CREATE INDEX "CommandRun_archivedAt_createdAt_idx" ON "CommandRun"("archivedAt", "createdAt");
CREATE INDEX "CommandRun_status_nextRestartAt_idx" ON "CommandRun"("status", "nextRestartAt");
CREATE INDEX "CommandRunAttempt_runId_status_idx" ON "CommandRunAttempt"("runId", "status");
CREATE INDEX "CommandRunOutputChunk_attemptId_createdAt_idx" ON "CommandRunOutputChunk"("attemptId", "createdAt");

UPDATE "AgentJob"
SET "status" = 'CANCELLED',
    "error" = 'cloudflared.runTunnel was removed; create a saved command instead',
    "finishedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" = 'cloudflared.runTunnel'
  AND "status" IN ('QUEUED', 'RUNNING');
