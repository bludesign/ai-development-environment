-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "displayNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "phase" TEXT NOT NULL DEFAULT 'QUEUED',
    "origin" TEXT NOT NULL DEFAULT 'MANAGED',
    "provider" TEXT NOT NULL,
    "providerVersion" TEXT,
    "worktreeId" TEXT,
    "agentId" TEXT,
    "jiraIssueKey" TEXT,
    "jiraSummary" TEXT,
    "repositoryName" TEXT NOT NULL,
    "branch" TEXT,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "webSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "initialPrompt" TEXT NOT NULL,
    "finalOutput" TEXT,
    "error" TEXT,
    "estimatedCost" REAL,
    "pricingSource" TEXT,
    "pricingUpdatedAt" DATETIME,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "sourcePlanId" TEXT,
    "sourcePlanNumber" INTEGER,
    "playedAt" DATETIME,
    "playedSessionNumber" INTEGER,
    "parentRunId" TEXT,
    "parentRunNumber" INTEGER,
    "followUpMode" TEXT,
    "archivedAt" DATETIME,
    "nativeArchivedAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRun_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_sourcePlanId_fkey" FOREIGN KEY ("sourcePlanId") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "nativeId" TEXT,
    "nativeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'STARTING',
    "resumeStrategy" TEXT,
    "rawMetadataJson" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "supersededAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RunAttempt_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunInput" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunInput_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "worktreeId" TEXT,
    "agentId" TEXT,
    "jiraIssueKey" TEXT,
    "jiraSummary" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "webSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "prompt" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RunDraft_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RunDraft_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "inputId" TEXT,
    "draftId" TEXT,
    "sha256" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunAttachment_inputId_fkey" FOREIGN KEY ("inputId") REFERENCES "RunInput" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunAttachment_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "RunDraft" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "searchText" TEXT NOT NULL,
    "detailMarkdown" TEXT,
    "rawJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" DATETIME,
    CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputJson" TEXT,
    "outputJson" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "supersededAt" DATETIME,
    CONSTRAINT "RunToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunToolCall_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunModelUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" REAL,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RunModelUsage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunModelUsage_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunQuestionBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
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
    CONSTRAINT "RunQuestionBatch_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "header" TEXT,
    "prompt" TEXT NOT NULL,
    "multiSelect" BOOLEAN NOT NULL DEFAULT false,
    "allowCustom" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "RunQuestion_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RunQuestionBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunQuestionOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    CONSTRAINT "RunQuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "RunQuestion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunAnswerRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "answersJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" DATETIME,
    "replacementAttemptId" TEXT,
    CONSTRAINT "RunAnswerRevision_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RunQuestionBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
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
    CONSTRAINT "RunCheckpoint_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "RunAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RunCheckpoint_questionBatchId_fkey" FOREIGN KEY ("questionBatchId") REFERENCES "RunQuestionBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "RunCommand_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunCommand_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunNumberSequence" (
    "kind" TEXT NOT NULL PRIMARY KEY,
    "nextValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorktreeRunLease" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorktreeRunLease_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeRunLease_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunProviderSync" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "cursor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "lastStartedAt" DATETIME,
    "lastCompletedAt" DATETIME,
    "lastError" TEXT,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "catalogJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RunProviderSync_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_sourcePlanId_key" ON "AgentRun"("sourcePlanId");

-- CreateIndex
CREATE INDEX "AgentRun_kind_archivedAt_createdAt_idx" ON "AgentRun"("kind", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_worktreeId_status_createdAt_idx" ON "AgentRun"("worktreeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_agentId_provider_createdAt_idx" ON "AgentRun"("agentId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_parentRunId_createdAt_idx" ON "AgentRun"("parentRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_kind_displayNumber_key" ON "AgentRun"("kind", "displayNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RunAttempt_nativeKey_key" ON "RunAttempt"("nativeKey");

-- CreateIndex
CREATE INDEX "RunAttempt_runId_status_idx" ON "RunAttempt"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RunAttempt_runId_generation_key" ON "RunAttempt"("runId", "generation");

-- CreateIndex
CREATE INDEX "RunInput_runId_createdAt_idx" ON "RunInput"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunInput_runId_sequence_key" ON "RunInput"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunDraft_archivedAt_updatedAt_idx" ON "RunDraft"("archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "RunDraft_worktreeId_updatedAt_idx" ON "RunDraft"("worktreeId", "updatedAt");

-- CreateIndex
CREATE INDEX "RunAttachment_inputId_idx" ON "RunAttachment"("inputId");

-- CreateIndex
CREATE INDEX "RunAttachment_draftId_idx" ON "RunAttachment"("draftId");

-- CreateIndex
CREATE INDEX "RunAttachment_sha256_idx" ON "RunAttachment"("sha256");

-- CreateIndex
CREATE INDEX "RunEvent_runId_supersededAt_sequence_idx" ON "RunEvent"("runId", "supersededAt", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_sequence_key" ON "RunEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunToolCall_runId_startedAt_idx" ON "RunToolCall"("runId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunToolCall_runId_sequence_key" ON "RunToolCall"("runId", "sequence");

-- CreateIndex
CREATE INDEX "RunModelUsage_runId_model_idx" ON "RunModelUsage"("runId", "model");

-- CreateIndex
CREATE UNIQUE INDEX "RunModelUsage_runId_attemptId_model_key" ON "RunModelUsage"("runId", "attemptId", "model");

-- CreateIndex
CREATE INDEX "RunQuestionBatch_runId_status_createdAt_idx" ON "RunQuestionBatch"("runId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunQuestionBatch_runId_nativeRequestId_key" ON "RunQuestionBatch"("runId", "nativeRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "RunQuestion_batchId_position_key" ON "RunQuestion"("batchId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RunQuestionOption_questionId_position_key" ON "RunQuestionOption"("questionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RunAnswerRevision_batchId_revision_key" ON "RunAnswerRevision"("batchId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "RunCheckpoint_questionBatchId_key" ON "RunCheckpoint"("questionBatchId");

-- CreateIndex
CREATE INDEX "RunCheckpoint_runId_createdAt_idx" ON "RunCheckpoint"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunCommand_idempotencyKey_key" ON "RunCommand"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RunCommand_agentId_status_createdAt_idx" ON "RunCommand"("agentId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunCommand_runId_sequence_key" ON "RunCommand"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "WorktreeRunLease_runId_key" ON "WorktreeRunLease"("runId");

-- CreateIndex
CREATE INDEX "RunProviderSync_status_updatedAt_idx" ON "RunProviderSync"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunProviderSync_agentId_provider_key" ON "RunProviderSync"("agentId", "provider");
