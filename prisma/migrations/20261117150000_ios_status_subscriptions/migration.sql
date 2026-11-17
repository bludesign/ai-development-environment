CREATE TABLE "IosStatusSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "clientRegistrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastPayloadHash" TEXT,
    "lastAttemptAt" DATETIME,
    "lastDeliveredAt" DATETIME,
    "lastFailureReason" TEXT,
    "lastRegisteredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IosStatusSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IosStatusSubscription_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IosStatusSubscription_userId_clientRegistrationId_key" ON "IosStatusSubscription"("userId", "clientRegistrationId");
CREATE INDEX "IosStatusSubscription_status_expiresAt_idx" ON "IosStatusSubscription"("status", "expiresAt");
CREATE INDEX "IosStatusSubscription_sessionId_idx" ON "IosStatusSubscription"("sessionId");
