-- CreateTable
CREATE TABLE "JiraWebhookDelivery" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "event" TEXT NOT NULL,
    "issueKey" TEXT,
    "projectKey" TEXT,
    "retryCount" INTEGER,
    "outcome" TEXT NOT NULL,
    "error" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_JiraSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteUrl" TEXT,
    "email" TEXT,
    "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300,
    "webhookEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookConfiguredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_JiraSettings" ("cacheTtlSeconds", "createdAt", "email", "id", "siteUrl", "updatedAt") SELECT "cacheTtlSeconds", "createdAt", "email", "id", "siteUrl", "updatedAt" FROM "JiraSettings";
DROP TABLE "JiraSettings";
ALTER TABLE "new_JiraSettings" RENAME TO "JiraSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "JiraWebhookDelivery_receivedAt_idx" ON "JiraWebhookDelivery"("receivedAt");

-- CreateIndex
CREATE INDEX "JiraWebhookDelivery_event_receivedAt_idx" ON "JiraWebhookDelivery"("event", "receivedAt");

-- CreateIndex
CREATE INDEX "JiraWebhookDelivery_outcome_receivedAt_idx" ON "JiraWebhookDelivery"("outcome", "receivedAt");
