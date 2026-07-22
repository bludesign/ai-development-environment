ALTER TABLE "GitHubSettings" ADD COLUMN "actionsNotificationPollIntervalSeconds" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "GitHubAppSettings" ADD COLUMN "webhookUrl" TEXT;
ALTER TABLE "GitHubAppSettings" ADD COLUMN "webhookConfiguredAt" DATETIME;

CREATE TABLE "GitHubWebhookDelivery" (
  "deliveryId" TEXT NOT NULL PRIMARY KEY,
  "event" TEXT NOT NULL,
  "action" TEXT,
  "repositoryName" TEXT,
  "workflowRunId" TEXT,
  "outcome" TEXT NOT NULL,
  "error" TEXT,
  "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" DATETIME
);
CREATE INDEX "GitHubWebhookDelivery_receivedAt_idx" ON "GitHubWebhookDelivery"("receivedAt");
CREATE INDEX "GitHubWebhookDelivery_event_receivedAt_idx" ON "GitHubWebhookDelivery"("event", "receivedAt");
CREATE INDEX "GitHubWebhookDelivery_outcome_receivedAt_idx" ON "GitHubWebhookDelivery"("outcome", "receivedAt");

CREATE TABLE "GitHubWorkflowRunObservation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "codebaseRepositoryId" TEXT NOT NULL,
  "workflowRunId" TEXT NOT NULL,
  "runAttempt" INTEGER NOT NULL,
  "workflowId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "conclusion" TEXT,
  "githubUpdatedAt" DATETIME NOT NULL,
  "source" TEXT NOT NULL,
  "notifiedAt" DATETIME,
  "firstObservedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" DATETIME NOT NULL,
  CONSTRAINT "GitHubWorkflowRunObservation_codebaseRepositoryId_fkey" FOREIGN KEY ("codebaseRepositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GitHubWorkflowRunObservation_codebaseRepositoryId_workflowRunId_runAttempt_key" ON "GitHubWorkflowRunObservation"("codebaseRepositoryId", "workflowRunId", "runAttempt");
CREATE INDEX "GitHubWorkflowRunObservation_codebaseRepositoryId_lastObservedAt_idx" ON "GitHubWorkflowRunObservation"("codebaseRepositoryId", "lastObservedAt");
CREATE INDEX "GitHubWorkflowRunObservation_lastObservedAt_idx" ON "GitHubWorkflowRunObservation"("lastObservedAt");

CREATE TABLE "GitHubActionsPollingState" (
  "codebaseRepositoryId" TEXT NOT NULL PRIMARY KEY,
  "initializedAt" DATETIME NOT NULL,
  "lastPollStartedAt" DATETIME,
  "lastPollCompletedAt" DATETIME,
  "lastPollSucceededAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "GitHubActionsPollingState_codebaseRepositoryId_fkey" FOREIGN KEY ("codebaseRepositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "GitHubActionsPollingState_lastPollSucceededAt_idx" ON "GitHubActionsPollingState"("lastPollSucceededAt");
