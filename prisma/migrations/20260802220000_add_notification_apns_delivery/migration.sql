-- Native APNs becomes a notification delivery channel alongside the sidebar, the browser, and
-- Web Push. Saved preferences adopt whatever the browser channel already says, matching the
-- defaults new types ship with, so a user who registers a device gets the alerts they already
-- chose instead of sixteen switches that are all off. Nothing is delivered until a device
-- registers, so inheriting an enabled channel cannot send anything on its own.
ALTER TABLE "NotificationPreference" ADD COLUMN "apnsEnabled" BOOLEAN NOT NULL DEFAULT 0;
UPDATE "NotificationPreference" SET "apnsEnabled" = "browserEnabled";

-- History rows stay false: those notifications were raised before any device existed, and the
-- flag records what delivery was actually requested at the time.
ALTER TABLE "AppNotification" ADD COLUMN "apnsRequested" BOOLEAN NOT NULL DEFAULT 0;

-- Devices registered by this control plane's own iOS app. Kept apart from "ApnsRegistration",
-- which the push-notifications test console fills with devices from other apps being built here;
-- fanning personal notifications out to those would be wrong.
CREATE TABLE "NotificationDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientRegistrationId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "deviceModel" TEXT,
    "osVersion" TEXT,
    "appVersion" TEXT,
    "appBuild" TEXT,
    "locale" TEXT,
    "lastIpAddress" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastFailureReason" TEXT,
    "lastFailureAt" DATETIME,
    "lastRegisteredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDeliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "NotificationDevice_clientRegistrationId_key" ON "NotificationDevice"("clientRegistrationId");
CREATE UNIQUE INDEX "NotificationDevice_tokenHash_key" ON "NotificationDevice"("tokenHash");
CREATE INDEX "NotificationDevice_status_lastRegisteredAt_idx" ON "NotificationDevice"("status", "lastRegisteredAt");
