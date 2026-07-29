PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_AgentRun" (
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
    "repositoryName" TEXT NOT NULL,
    "branch" TEXT,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "webSearchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mcpPresetIdsJson" TEXT NOT NULL DEFAULT '[]',
    "mcpToolNamesJson" TEXT NOT NULL DEFAULT '[]',
    "worktreeConcurrencyLimit" INTEGER NOT NULL DEFAULT 0,
    "workflowRunId" TEXT,
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
    CONSTRAINT "AgentRun_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_sourcePlanId_fkey" FOREIGN KEY ("sourcePlanId") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_AgentRun" (
    "agentId", "archivedAt", "branch", "cacheReadTokens", "cacheWriteTokens",
    "createdAt", "displayNumber", "effort", "error", "estimatedCost",
    "finalOutput", "finishedAt", "followUpMode", "id", "initialPrompt",
    "inputTokens", "jiraIssueKey", "kind", "mcpPresetIdsJson",
    "mcpToolNamesJson", "model", "nativeArchivedAt", "origin",
    "outputTokens", "parentRunId", "parentRunNumber", "phase", "playedAt",
    "playedSessionNumber", "pricingSource", "pricingUpdatedAt", "provider",
    "providerVersion", "reasoningTokens", "repositoryName", "sourcePlanId",
    "sourcePlanNumber", "startedAt", "status", "toolCallCount", "updatedAt",
    "webSearchEnabled", "workflowRunId", "worktreeConcurrencyLimit", "worktreeId"
)
SELECT
    "agentId", "archivedAt", "branch", "cacheReadTokens", "cacheWriteTokens",
    "createdAt", "displayNumber", "effort", "error", "estimatedCost",
    "finalOutput", "finishedAt", "followUpMode", "id", "initialPrompt",
    "inputTokens", "jiraIssueKey", "kind", "mcpPresetIdsJson",
    "mcpToolNamesJson", "model", "nativeArchivedAt", "origin",
    "outputTokens", "parentRunId", "parentRunNumber", "phase", "playedAt",
    "playedSessionNumber", "pricingSource", "pricingUpdatedAt", "provider",
    "providerVersion", "reasoningTokens", "repositoryName", "sourcePlanId",
    "sourcePlanNumber", "startedAt", "status", "toolCallCount", "updatedAt",
    "webSearchEnabled", "workflowRunId", "worktreeConcurrencyLimit", "worktreeId"
FROM "AgentRun";

DROP TABLE "AgentRun";
ALTER TABLE "new_AgentRun" RENAME TO "AgentRun";
CREATE UNIQUE INDEX "AgentRun_sourcePlanId_key" ON "AgentRun"("sourcePlanId");
CREATE INDEX "AgentRun_kind_archivedAt_createdAt_idx" ON "AgentRun"("kind", "archivedAt", "createdAt");
CREATE INDEX "AgentRun_worktreeId_status_createdAt_idx" ON "AgentRun"("worktreeId", "status", "createdAt");
CREATE INDEX "AgentRun_worktreeId_kind_status_createdAt_idx" ON "AgentRun"("worktreeId", "kind", "status", "createdAt");
CREATE INDEX "AgentRun_workflowRunId_createdAt_idx" ON "AgentRun"("workflowRunId", "createdAt");
CREATE INDEX "AgentRun_agentId_provider_createdAt_idx" ON "AgentRun"("agentId", "provider", "createdAt");
CREATE INDEX "AgentRun_parentRunId_createdAt_idx" ON "AgentRun"("parentRunId", "createdAt");
CREATE UNIQUE INDEX "AgentRun_kind_displayNumber_key" ON "AgentRun"("kind", "displayNumber");

CREATE TABLE "new_WorkflowRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayNumber" INTEGER NOT NULL,
    "workflowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "triggerId" TEXT,
    "triggerEventId" TEXT,
    "parentRunId" TEXT,
    "worktreeId" TEXT,
    "worktreeLeaseOwnerRunId" TEXT,
    "exclusiveWorktree" BOOLEAN NOT NULL DEFAULT false,
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
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "WorkflowVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_triggerId_fkey" FOREIGN KEY ("triggerId") REFERENCES "WorkflowTrigger" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_triggerEventId_fkey" FOREIGN KEY ("triggerEventId") REFERENCES "WorkflowTriggerEvent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_parentRunId_fkey" FOREIGN KEY ("parentRunId") REFERENCES "WorkflowRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkflowRun_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_WorkflowRun" (
    "archivedAt", "blockedReason", "createdAt", "displayNumber", "error",
    "exclusiveWorktree", "finishedAt", "generation", "id", "idempotencyKey",
    "parentRunId", "pausedAt", "phase", "queuedAt", "sessionDataJson",
    "sessionRevision", "startedAt", "status", "triggerEventId", "triggerId",
    "triggerKind", "triggerPayloadJson", "triggerSubjectKey", "updatedAt",
    "versionId", "workflowId", "worktreeId", "worktreeLeaseOwnerRunId"
)
SELECT
    "archivedAt", "blockedReason", "createdAt", "displayNumber", "error",
    "exclusiveWorktree", "finishedAt", "generation", "id", "idempotencyKey",
    "parentRunId", "pausedAt", "phase", "queuedAt", "sessionDataJson",
    "sessionRevision", "startedAt", "status", "triggerEventId", "triggerId",
    "triggerKind", "triggerPayloadJson", "triggerSubjectKey", "updatedAt",
    "versionId", "workflowId", "worktreeId", "worktreeLeaseOwnerRunId"
FROM "WorkflowRun";

DROP TABLE "WorkflowRun";
ALTER TABLE "new_WorkflowRun" RENAME TO "WorkflowRun";
CREATE UNIQUE INDEX "WorkflowRun_displayNumber_key" ON "WorkflowRun"("displayNumber");
CREATE UNIQUE INDEX "WorkflowRun_idempotencyKey_key" ON "WorkflowRun"("idempotencyKey");
CREATE INDEX "WorkflowRun_workflowId_status_queuedAt_idx" ON "WorkflowRun"("workflowId", "status", "queuedAt");
CREATE INDEX "WorkflowRun_versionId_createdAt_idx" ON "WorkflowRun"("versionId", "createdAt");
CREATE INDEX "WorkflowRun_triggerEventId_idx" ON "WorkflowRun"("triggerEventId");
CREATE INDEX "WorkflowRun_parentRunId_idx" ON "WorkflowRun"("parentRunId");
CREATE INDEX "WorkflowRun_worktreeId_status_queuedAt_idx" ON "WorkflowRun"("worktreeId", "status", "queuedAt");
CREATE INDEX "WorkflowRun_worktreeLeaseOwnerRunId_idx" ON "WorkflowRun"("worktreeLeaseOwnerRunId");
CREATE INDEX "WorkflowRun_archivedAt_createdAt_idx" ON "WorkflowRun"("archivedAt", "createdAt");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
