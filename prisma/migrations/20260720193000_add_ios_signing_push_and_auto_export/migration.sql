ALTER TABLE "BuildConfiguration" ADD COLUMN "autoExport" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BuildConfiguration" ADD COLUMN "exportSettingsJson" TEXT;
ALTER TABLE "BuildDataDeletionHistory" ADD COLUMN "entryKind" TEXT NOT NULL DEFAULT 'PROJECT';

CREATE TABLE "SigningProfileAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "uuid" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "profileType" TEXT NOT NULL,
  "bundleId" TEXT NOT NULL,
  "teamId" TEXT,
  "teamName" TEXT,
  "platformsJson" TEXT NOT NULL DEFAULT '[]',
  "deviceCount" INTEGER NOT NULL DEFAULT 0,
  "certificateSha1sJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME,
  "expiresAt" DATETIME,
  "expired" BOOLEAN NOT NULL DEFAULT false,
  "xcodeManaged" BOOLEAN NOT NULL DEFAULT false,
  "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "missingAt" DATETIME,
  CONSTRAINT "SigningProfileAsset_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SigningProfileAsset_agentId_uuid_key" ON "SigningProfileAsset"("agentId", "uuid");
CREATE INDEX "SigningProfileAsset_uuid_idx" ON "SigningProfileAsset"("uuid");
CREATE INDEX "SigningProfileAsset_contentHash_idx" ON "SigningProfileAsset"("contentHash");
CREATE INDEX "SigningProfileAsset_agentId_missingAt_idx" ON "SigningProfileAsset"("agentId", "missingAt");
CREATE INDEX "SigningProfileAsset_expiresAt_idx" ON "SigningProfileAsset"("expiresAt");

CREATE TABLE "SigningCertificateAsset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "sha1" TEXT NOT NULL,
  "sha256" TEXT,
  "name" TEXT NOT NULL,
  "teamId" TEXT,
  "certificateType" TEXT,
  "notBefore" DATETIME,
  "expiresAt" DATETIME,
  "expired" BOOLEAN NOT NULL DEFAULT false,
  "hasPrivateKey" BOOLEAN NOT NULL DEFAULT false,
  "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "missingAt" DATETIME,
  CONSTRAINT "SigningCertificateAsset_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SigningCertificateAsset_agentId_sha1_key" ON "SigningCertificateAsset"("agentId", "sha1");
CREATE INDEX "SigningCertificateAsset_sha1_idx" ON "SigningCertificateAsset"("sha1");
CREATE INDEX "SigningCertificateAsset_agentId_missingAt_idx" ON "SigningCertificateAsset"("agentId", "missingAt");
CREATE INDEX "SigningCertificateAsset_expiresAt_idx" ON "SigningCertificateAsset"("expiresAt");

CREATE TABLE "SigningOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "assetKey" TEXT,
  "sourceAgentId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "finishedAt" DATETIME
);
CREATE INDEX "SigningOperation_status_createdAt_idx" ON "SigningOperation"("status", "createdAt");

CREATE TABLE "SigningOperationItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "operationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "jobId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "finishedAt" DATETIME,
  CONSTRAINT "SigningOperationItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "SigningOperation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SigningOperationItem_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SigningOperationItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SigningOperationItem_jobId_key" ON "SigningOperationItem"("jobId");
CREATE UNIQUE INDEX "SigningOperationItem_operationId_agentId_key" ON "SigningOperationItem"("operationId", "agentId");
CREATE INDEX "SigningOperationItem_agentId_status_idx" ON "SigningOperationItem"("agentId", "status");

CREATE TABLE "PushNotificationSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenTeamId" TEXT,
  "tokenKeyId" TEXT,
  "tokenPrivateKey" TEXT,
  "tokenPrivateKeyFingerprint" TEXT,
  "tokenConfiguredAt" DATETIME,
  "tokenLastUsedAt" DATETIME,
  "tokenLastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "ApnsCertificateCredential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "p12Base64" TEXT NOT NULL,
  "passphrase" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "expiresAt" DATETIME,
  "lastTestedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ApnsCertificateCredential_name_key" ON "ApnsCertificateCredential"("name");
CREATE INDEX "ApnsCertificateCredential_topic_environment_idx" ON "ApnsCertificateCredential"("topic", "environment");

CREATE TABLE "ApnsRegistration" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "clientRegistrationId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "pushTypesJson" TEXT NOT NULL DEFAULT '[]',
  "displayName" TEXT NOT NULL,
  "deviceModel" TEXT,
  "osVersion" TEXT,
  "appVersion" TEXT,
  "appBuild" TEXT,
  "locale" TEXT,
  "pushMagic" TEXT,
  "lastIpAddress" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "invalidatedAt" DATETIME,
  "lastFailureReason" TEXT,
  "lastFailureAt" DATETIME,
  "lastRegisteredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSentAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ApnsRegistration_clientRegistrationId_topic_environment_key" ON "ApnsRegistration"("clientRegistrationId", "topic", "environment");
CREATE UNIQUE INDEX "ApnsRegistration_tokenHash_topic_environment_key" ON "ApnsRegistration"("tokenHash", "topic", "environment");
CREATE INDEX "ApnsRegistration_status_topic_environment_idx" ON "ApnsRegistration"("status", "topic", "environment");
CREATE INDEX "ApnsRegistration_lastRegisteredAt_idx" ON "ApnsRegistration"("lastRegisteredAt");

CREATE TABLE "ApnsBroadcastChannel" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "channelId" TEXT NOT NULL,
  "bundleId" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "storagePolicy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ApnsBroadcastChannel_channelId_key" ON "ApnsBroadcastChannel"("channelId");
CREATE INDEX "ApnsBroadcastChannel_bundleId_environment_idx" ON "ApnsBroadcastChannel"("bundleId", "environment");

CREATE TABLE "PushNotificationPreset" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "editorJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PushNotificationPreset_name_key" ON "PushNotificationPreset"("name");

CREATE TABLE "PushNotificationBatch" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "editorJson" TEXT NOT NULL,
  "payloadJson" TEXT NOT NULL,
  "headersJson" TEXT NOT NULL,
  "targetMode" TEXT NOT NULL,
  "channelId" TEXT,
  "recipientCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "PushNotificationBatch_requestId_key" ON "PushNotificationBatch"("requestId");
CREATE INDEX "PushNotificationBatch_status_createdAt_idx" ON "PushNotificationBatch"("status", "createdAt");
CREATE INDEX "PushNotificationBatch_createdAt_idx" ON "PushNotificationBatch"("createdAt");

CREATE TABLE "PushNotificationDelivery" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "batchId" TEXT NOT NULL,
  "registrationId" TEXT,
  "tokenHash" TEXT,
  "topic" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "apnsId" TEXT,
  "responseCode" INTEGER,
  "reason" TEXT,
  "responseTimestamp" DATETIME,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" DATETIME,
  "finishedAt" DATETIME,
  CONSTRAINT "PushNotificationDelivery_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PushNotificationBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PushNotificationDelivery_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ApnsRegistration" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "PushNotificationDelivery_batchId_status_idx" ON "PushNotificationDelivery"("batchId", "status");
CREATE INDEX "PushNotificationDelivery_registrationId_createdAt_idx" ON "PushNotificationDelivery"("registrationId", "createdAt");

CREATE TABLE "ApnsPushRecipientSecret" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deliveryId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApnsPushRecipientSecret_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "PushNotificationDelivery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ApnsPushRecipientSecret_deliveryId_key" ON "ApnsPushRecipientSecret"("deliveryId");
