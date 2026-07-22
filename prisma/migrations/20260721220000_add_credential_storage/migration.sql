-- This cutover is intentionally destructive: legacy credential material is never copied into
-- the new store. Operators must re-enter long-lived credentials after upgrading.
PRAGMA foreign_keys=OFF;

CREATE TABLE "Credential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "ownerId" TEXT,
  "storageType" TEXT NOT NULL,
  "payload" BLOB,
  "encrypted" BOOLEAN NOT NULL DEFAULT false,
  "encryptionVersion" INTEGER,
  "nonce" BLOB,
  "authTag" BLOB,
  "keyFingerprint" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Credential_kind_idx" ON "Credential"("kind");
CREATE INDEX "Credential_ownerId_idx" ON "Credential"("ownerId");
CREATE INDEX "Credential_storageType_idx" ON "Credential"("storageType");

CREATE TABLE "new_IosDeviceSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationName" TEXT NOT NULL DEFAULT 'AI Development Environment',
  "profileIdentifier" TEXT NOT NULL DEFAULT 'com.ai-development-environment.device-enrollment',
  "signerCertificatePem" TEXT,
  "signerFingerprint" TEXT,
  "signerCreatedAt" DATETIME,
  "signerExpiresAt" DATETIME,
  "appStoreConnectIssuerId" TEXT,
  "appStoreConnectKeyId" TEXT,
  "appStoreConnectPrivateKeyFingerprint" TEXT,
  "appStoreConnectVerifiedAt" DATETIME,
  "appStoreConnectLastTestedAt" DATETIME,
  "appStoreConnectVerificationError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_IosDeviceSettings" (
  "id", "organizationName", "profileIdentifier", "signerCertificatePem",
  "signerFingerprint", "signerCreatedAt", "signerExpiresAt",
  "appStoreConnectIssuerId", "appStoreConnectKeyId",
  "appStoreConnectPrivateKeyFingerprint", "appStoreConnectVerifiedAt",
  "appStoreConnectLastTestedAt", "appStoreConnectVerificationError",
  "createdAt", "updatedAt"
)
SELECT
  "id", "organizationName", "profileIdentifier", "signerCertificatePem",
  "signerFingerprint", "signerCreatedAt", "signerExpiresAt",
  "appStoreConnectIssuerId", "appStoreConnectKeyId",
  "appStoreConnectPrivateKeyFingerprint", "appStoreConnectVerifiedAt",
  "appStoreConnectLastTestedAt", "appStoreConnectVerificationError",
  "createdAt", "updatedAt"
FROM "IosDeviceSettings";
DROP TABLE "IosDeviceSettings";
ALTER TABLE "new_IosDeviceSettings" RENAME TO "IosDeviceSettings";

CREATE TABLE "new_PushNotificationSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenTeamId" TEXT,
  "tokenKeyId" TEXT,
  "tokenPrivateKeyFingerprint" TEXT,
  "tokenConfiguredAt" DATETIME,
  "tokenLastUsedAt" DATETIME,
  "tokenLastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PushNotificationSettings" (
  "id", "tokenTeamId", "tokenKeyId", "tokenPrivateKeyFingerprint",
  "tokenConfiguredAt", "tokenLastUsedAt", "tokenLastError", "createdAt", "updatedAt"
)
SELECT
  "id", "tokenTeamId", "tokenKeyId", "tokenPrivateKeyFingerprint",
  "tokenConfiguredAt", "tokenLastUsedAt", "tokenLastError", "createdAt", "updatedAt"
FROM "PushNotificationSettings";
DROP TABLE "PushNotificationSettings";
ALTER TABLE "new_PushNotificationSettings" RENAME TO "PushNotificationSettings";

-- Existing certificate rows are unusable without their p12/passphrase bundle, so purge them.
DROP TABLE "ApnsCertificateCredential";
CREATE TABLE "ApnsCertificateCredential" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "expiresAt" DATETIME,
  "lastTestedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ApnsCertificateCredential_name_key" ON "ApnsCertificateCredential"("name");
CREATE INDEX "ApnsCertificateCredential_topic_environment_idx" ON "ApnsCertificateCredential"("topic", "environment");

CREATE TABLE "new_ExternalMcpServerHeader" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "serverId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ExternalMcpServerHeader_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "ExternalMcpServer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ExternalMcpServerHeader" ("id", "serverId", "name", "createdAt", "updatedAt")
SELECT "id", "serverId", "name", "createdAt", "updatedAt"
FROM "ExternalMcpServerHeader";
DROP TABLE "ExternalMcpServerHeader";
ALTER TABLE "new_ExternalMcpServerHeader" RENAME TO "ExternalMcpServerHeader";
CREATE UNIQUE INDEX "ExternalMcpServerHeader_serverId_name_key" ON "ExternalMcpServerHeader"("serverId", "name");
CREATE INDEX "ExternalMcpServerHeader_serverId_idx" ON "ExternalMcpServerHeader"("serverId");

CREATE TABLE "new_JiraSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "siteUrl" TEXT,
  "email" TEXT,
  "cacheTtlSeconds" INTEGER NOT NULL DEFAULT 300,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_JiraSettings" ("id", "siteUrl", "email", "cacheTtlSeconds", "createdAt", "updatedAt")
SELECT "id", "siteUrl", "email", "cacheTtlSeconds", "createdAt", "updatedAt"
FROM "JiraSettings";
DROP TABLE "JiraSettings";
ALTER TABLE "new_JiraSettings" RENAME TO "JiraSettings";

CREATE TABLE "new_GitHubSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "defaultJiraKeyRegex" TEXT NOT NULL DEFAULT '\b([A-Z][A-Z0-9_]*-\d+)\b',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GitHubSettings" ("id", "defaultJiraKeyRegex", "createdAt", "updatedAt")
SELECT "id", "defaultJiraKeyRegex", "createdAt", "updatedAt"
FROM "GitHubSettings";
DROP TABLE "GitHubSettings";
ALTER TABLE "new_GitHubSettings" RENAME TO "GitHubSettings";

CREATE TABLE "new_GitHubAppSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "appId" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "apiBaseUrl" TEXT NOT NULL DEFAULT 'https://api.github.com',
  "graphqlUrl" TEXT NOT NULL DEFAULT 'https://api.github.com/graphql',
  "keyFingerprint" TEXT NOT NULL,
  "appSlug" TEXT NOT NULL,
  "accountLogin" TEXT NOT NULL,
  "repositorySelection" TEXT NOT NULL,
  "actionsPermission" TEXT NOT NULL,
  "verifiedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GitHubAppSettings" (
  "id", "appId", "installationId", "apiBaseUrl", "graphqlUrl",
  "keyFingerprint", "appSlug", "accountLogin", "repositorySelection",
  "actionsPermission", "verifiedAt", "createdAt", "updatedAt"
)
SELECT
  "id", "appId", "installationId", "apiBaseUrl", "graphqlUrl",
  "keyFingerprint", "appSlug", "accountLogin", "repositorySelection",
  "actionsPermission", "verifiedAt", "createdAt", "updatedAt"
FROM "GitHubAppSettings";
DROP TABLE "GitHubAppSettings";
ALTER TABLE "new_GitHubAppSettings" RENAME TO "GitHubAppSettings";

CREATE TABLE "new_CacheServerSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "baseUrl" TEXT,
  "headerNamesJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CacheServerSettings" ("id", "baseUrl", "headerNamesJson", "createdAt", "updatedAt")
SELECT "id", "baseUrl", '[]', "createdAt", "updatedAt"
FROM "CacheServerSettings";
DROP TABLE "CacheServerSettings";
ALTER TABLE "new_CacheServerSettings" RENAME TO "CacheServerSettings";

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
