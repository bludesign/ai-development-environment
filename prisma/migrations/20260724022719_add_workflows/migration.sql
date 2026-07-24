-- CreateTable
CREATE TABLE "Workflow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "draftDefinitionJson" TEXT NOT NULL,
    "draftSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "activeVersionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "overlapPolicy" TEXT NOT NULL DEFAULT 'QUEUE',
    "maxConcurrentRuns" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workflow_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "WorkflowVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "definitionJson" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowTrigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowTrigger_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WorkflowVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowTriggerState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "triggerId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "cursorJson" TEXT,
    "lastMatched" BOOLEAN NOT NULL DEFAULT false,
    "lastFiredAt" DATETIME,
    "nextScheduledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowTriggerState_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "WorkflowTrigger" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowTriggerEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    "error" TEXT
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayNumber" INTEGER NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "triggerId" TEXT,
    "triggerEventId" TEXT,
    "parentRunId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "triggerKind" TEXT NOT NULL,
    "triggerSubjectKey" TEXT NOT NULL,
    "triggerPayloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'QUEUED',
    "generation" INTEGER NOT NULL DEFAULT 0,
    "sessionDataJson" TEXT NOT NULL,
    "sessionRevision" INTEGER NOT NULL DEFAULT 0,
    "blockedReason" TEXT,
    "error" TEXT,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "pausedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WorkflowVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "WorkflowTrigger" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_triggerEventId_fkey" FOREIGN KEY ("triggerEventId") REFERENCES "WorkflowTriggerEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "WorkflowRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowRunNumberSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nextValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkflowStepAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "iterationKey" TEXT NOT NULL DEFAULT '',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "phase" TEXT NOT NULL DEFAULT 'PENDING',
    "inputJson" TEXT,
    "outputJson" TEXT,
    "error" TEXT,
    "requiredPathsJson" TEXT NOT NULL DEFAULT '[]',
    "providedPathsJson" TEXT NOT NULL DEFAULT '[]',
    "resourceLockKey" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "claimOwner" TEXT,
    "claimExpiresAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "supersededAt" DATETIME,
    "replayedFromId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowStepAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowStepAttempt_replayedFromId_fkey" FOREIGN KEY ("replayedFromId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowWait" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "predicateJson" TEXT,
    "externalKey" TEXT,
    "resumeAfter" DATETIME,
    "timeoutAt" DATETIME,
    "resultJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowWait_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowWait_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowRunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detailJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRunEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowRunResourceLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT,
    "kind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "label" TEXT,
    "url" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowRunResourceLink_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRunResourceLink_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowResourceLease" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowResourceLease_runId_fkey" FOREIGN KEY ("runId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowResourceLease_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RunCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "workflowStepAttemptId" TEXT,
    "attemptId" TEXT,
    "questionBatchId" TEXT,
    "kind" TEXT NOT NULL,
    "headSha" TEXT,
    "branch" TEXT,
    "upstreamSha" TEXT,
    "indexTree" TEXT,
    "worktreeTree" TEXT,
    "refName" TEXT,
    "manifestJson" TEXT,
    "diffSummary" TEXT,
    "diffPatch" TEXT,
    "stashRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunCheckpoint_workflowStepAttemptId_fkey" FOREIGN KEY ("workflowStepAttemptId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunCheckpoint_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RunCheckpoint_questionBatchId_fkey" FOREIGN KEY ("questionBatchId") REFERENCES "RunQuestionBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RunCheckpoint" ("attemptId", "branch", "createdAt", "diffPatch", "diffSummary", "headSha", "id", "indexTree", "kind", "manifestJson", "questionBatchId", "refName", "runId", "stashRef", "upstreamSha", "worktreeTree") SELECT "attemptId", "branch", "createdAt", "diffPatch", "diffSummary", "headSha", "id", "indexTree", "kind", "manifestJson", "questionBatchId", "refName", "runId", "stashRef", "upstreamSha", "worktreeTree" FROM "RunCheckpoint";
DROP TABLE "RunCheckpoint";
ALTER TABLE "new_RunCheckpoint" RENAME TO "RunCheckpoint";
CREATE UNIQUE INDEX "RunCheckpoint_questionBatchId_key" ON "RunCheckpoint"("questionBatchId");
CREATE INDEX "RunCheckpoint_runId_createdAt_idx" ON "RunCheckpoint"("runId", "createdAt");
CREATE INDEX "RunCheckpoint_workflowStepAttemptId_createdAt_idx" ON "RunCheckpoint"("workflowStepAttemptId", "createdAt");
CREATE TABLE "new_RunQuestionBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "workflowStepAttemptId" TEXT,
    "attemptId" TEXT,
    "nativeRequestId" TEXT,
    "eventSequence" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    "supersededAt" DATETIME,
    "revisionPreparedAt" DATETIME,
    "rollbackPatch" TEXT,
    "pushedCommitWarning" TEXT,
    CONSTRAINT "RunQuestionBatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunQuestionBatch_workflowStepAttemptId_fkey" FOREIGN KEY ("workflowStepAttemptId") REFERENCES "WorkflowStepAttempt" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunQuestionBatch_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RunQuestionBatch" ("answeredAt", "attemptId", "createdAt", "eventSequence", "id", "nativeRequestId", "pushedCommitWarning", "revisionPreparedAt", "rollbackPatch", "runId", "status", "supersededAt") SELECT "answeredAt", "attemptId", "createdAt", "eventSequence", "id", "nativeRequestId", "pushedCommitWarning", "revisionPreparedAt", "rollbackPatch", "runId", "status", "supersededAt" FROM "RunQuestionBatch";
DROP TABLE "RunQuestionBatch";
ALTER TABLE "new_RunQuestionBatch" RENAME TO "RunQuestionBatch";
CREATE INDEX "RunQuestionBatch_runId_status_createdAt_idx" ON "RunQuestionBatch"("runId", "status", "createdAt");
CREATE INDEX "RunQuestionBatch_workflowStepAttemptId_status_createdAt_idx" ON "RunQuestionBatch"("workflowStepAttemptId", "status", "createdAt");
CREATE UNIQUE INDEX "RunQuestionBatch_runId_nativeRequestId_key" ON "RunQuestionBatch"("runId", "nativeRequestId");
CREATE UNIQUE INDEX "RunQuestionBatch_workflowStepAttemptId_nativeRequestId_key" ON "RunQuestionBatch"("workflowStepAttemptId", "nativeRequestId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_activeVersionId_key" ON "Workflow"("activeVersionId");

-- CreateIndex
CREATE INDEX "Workflow_archivedAt_updatedAt_idx" ON "Workflow"("archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "Workflow_enabled_activeVersionId_idx" ON "Workflow"("enabled", "activeVersionId");

-- CreateIndex
CREATE INDEX "WorkflowVersion_workflowId_publishedAt_idx" ON "WorkflowVersion"("workflowId", "publishedAt");

-- CreateIndex
CREATE INDEX "WorkflowVersion_contentHash_idx" ON "WorkflowVersion"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE INDEX "WorkflowTrigger_kind_versionId_idx" ON "WorkflowTrigger"("kind", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTrigger_versionId_nodeId_key" ON "WorkflowTrigger"("versionId", "nodeId");

-- CreateIndex
CREATE INDEX "WorkflowTriggerState_nextScheduledAt_idx" ON "WorkflowTriggerState"("nextScheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTriggerState_triggerId_subjectKey_key" ON "WorkflowTriggerState"("triggerId", "subjectKey");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTriggerEvent_dedupeKey_key" ON "WorkflowTriggerEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "WorkflowTriggerEvent_status_receivedAt_idx" ON "WorkflowTriggerEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WorkflowTriggerEvent_kind_subjectKey_receivedAt_idx" ON "WorkflowTriggerEvent"("kind", "subjectKey", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_displayNumber_key" ON "WorkflowRun"("displayNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_idempotencyKey_key" ON "WorkflowRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkflowRun_workflowId_status_queuedAt_idx" ON "WorkflowRun"("workflowId", "status", "queuedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_versionId_createdAt_idx" ON "WorkflowRun"("versionId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_triggerEventId_idx" ON "WorkflowRun"("triggerEventId");

-- CreateIndex
CREATE INDEX "WorkflowRun_parentRunId_idx" ON "WorkflowRun"("parentRunId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStepAttempt_idempotencyKey_key" ON "WorkflowStepAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "WorkflowStepAttempt_runId_generation_status_idx" ON "WorkflowStepAttempt"("runId", "generation", "status");

-- CreateIndex
CREATE INDEX "WorkflowStepAttempt_status_claimExpiresAt_idx" ON "WorkflowStepAttempt"("status", "claimExpiresAt");

-- CreateIndex
CREATE INDEX "WorkflowStepAttempt_resourceLockKey_status_idx" ON "WorkflowStepAttempt"("resourceLockKey", "status");

-- CreateIndex
CREATE INDEX "WorkflowStepAttempt_replayedFromId_idx" ON "WorkflowStepAttempt"("replayedFromId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStepAttempt_runId_nodeId_generation_iterationKey_attempt_key" ON "WorkflowStepAttempt"("runId", "nodeId", "generation", "iterationKey", "attempt");

-- CreateIndex
CREATE INDEX "WorkflowWait_status_resumeAfter_idx" ON "WorkflowWait"("status", "resumeAfter");

-- CreateIndex
CREATE INDEX "WorkflowWait_kind_externalKey_status_idx" ON "WorkflowWait"("kind", "externalKey", "status");

-- CreateIndex
CREATE INDEX "WorkflowWait_runId_status_idx" ON "WorkflowWait"("runId", "status");

-- CreateIndex
CREATE INDEX "WorkflowRunEvent_runId_createdAt_idx" ON "WorkflowRunEvent"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRunEvent_attemptId_createdAt_idx" ON "WorkflowRunEvent"("attemptId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunEvent_runId_sequence_key" ON "WorkflowRunEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "WorkflowRunResourceLink_kind_resourceId_createdAt_idx" ON "WorkflowRunResourceLink"("kind", "resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowRunResourceLink_runId_createdAt_idx" ON "WorkflowRunResourceLink"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRunResourceLink_attemptId_kind_resourceId_key" ON "WorkflowRunResourceLink"("attemptId", "kind", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowResourceLease_attemptId_key" ON "WorkflowResourceLease"("attemptId");

-- CreateIndex
CREATE INDEX "WorkflowResourceLease_expiresAt_idx" ON "WorkflowResourceLease"("expiresAt");

-- CreateIndex
CREATE INDEX "WorkflowResourceLease_runId_idx" ON "WorkflowResourceLease"("runId");
