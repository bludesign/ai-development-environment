ALTER TABLE "GitHubAuditEvent" ADD COLUMN "autoRetryRuleId" TEXT;
ALTER TABLE "GitHubAuditEvent" ADD COLUMN "autoRetryExecutionId" TEXT;
CREATE INDEX "GitHubAuditEvent_autoRetryRuleId_createdAt_idx" ON "GitHubAuditEvent"("autoRetryRuleId", "createdAt");

-- CreateTable
CREATE TABLE "GitHubAutoRetryRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "codebaseRepositoryId" TEXT NOT NULL,
    "repositoryGithubId" TEXT,
    "worktreeId" TEXT,
    "branch" TEXT,
    "pullRequestNumber" INTEGER,
    "allWorkflows" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL,
    "retryLimit" INTEGER,
    "failureStrategy" TEXT NOT NULL DEFAULT 'FAILED_JOBS',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "activatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GitHubAutoRetryTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "workflowId" TEXT,
    "workflowRunId" TEXT,
    "jobName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GitHubAutoRetryTarget_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "GitHubAutoRetryRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GitHubAutoRetryExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WATCHING',
    "observedAttempt" INTEGER NOT NULL DEFAULT 0,
    "automaticRetries" INTEGER NOT NULL DEFAULT 0,
    "pendingFromAttempt" INTEGER,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GitHubAutoRetryExecution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "GitHubAutoRetryRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "GitHubAutoRetryRule_enabled_status_updatedAt_idx" ON "GitHubAutoRetryRule"("enabled", "status", "updatedAt");
CREATE INDEX "GitHubAutoRetryRule_codebaseRepositoryId_scope_idx" ON "GitHubAutoRetryRule"("codebaseRepositoryId", "scope");
CREATE INDEX "GitHubAutoRetryRule_worktreeId_idx" ON "GitHubAutoRetryRule"("worktreeId");
CREATE INDEX "GitHubAutoRetryTarget_ruleId_idx" ON "GitHubAutoRetryTarget"("ruleId");
CREATE INDEX "GitHubAutoRetryTarget_workflowRunId_idx" ON "GitHubAutoRetryTarget"("workflowRunId");
CREATE UNIQUE INDEX "GitHubAutoRetryTarget_ruleId_workflowId_workflowRunId_jobName_key" ON "GitHubAutoRetryTarget"("ruleId", "workflowId", "workflowRunId", "jobName");
CREATE INDEX "GitHubAutoRetryExecution_ruleId_status_idx" ON "GitHubAutoRetryExecution"("ruleId", "status");
CREATE INDEX "GitHubAutoRetryExecution_workflowRunId_idx" ON "GitHubAutoRetryExecution"("workflowRunId");
CREATE UNIQUE INDEX "GitHubAutoRetryExecution_ruleId_workflowRunId_targetKey_key" ON "GitHubAutoRetryExecution"("ruleId", "workflowRunId", "targetKey");
