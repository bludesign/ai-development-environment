-- CreateTable
CREATE TABLE "IosDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "udid" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "product" TEXT,
    "osVersion" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'IOS',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appleDeviceId" TEXT,
    "appleStatus" TEXT,
    "registrationError" TEXT,
    "registeredAt" DATETIME,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "IosDeviceEnrollment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "expiresAt" DATETIME NOT NULL,
    "downloadedAt" DATETIME,
    "consumedAt" DATETIME,
    "responseDigest" TEXT,
    "failureCode" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IosDeviceEnrollment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IosDevice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IosDeviceIpObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "enrollmentId" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "headerSource" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IosDeviceIpObservation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IosDevice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IosDeviceIpObservation_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "IosDeviceEnrollment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IosDeviceSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationName" TEXT NOT NULL DEFAULT 'AI Development Environment',
    "profileIdentifier" TEXT NOT NULL DEFAULT 'com.ai-development-environment.device-enrollment',
    "signerCertificatePem" TEXT,
    "signerPrivateKeyPem" TEXT,
    "signerFingerprint" TEXT,
    "signerCreatedAt" DATETIME,
    "signerExpiresAt" DATETIME,
    "appStoreConnectIssuerId" TEXT,
    "appStoreConnectKeyId" TEXT,
    "appStoreConnectPrivateKey" TEXT,
    "appStoreConnectPrivateKeyFingerprint" TEXT,
    "appStoreConnectVerifiedAt" DATETIME,
    "appStoreConnectLastTestedAt" DATETIME,
    "appStoreConnectVerificationError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "IosDevice_udid_key" ON "IosDevice"("udid");
CREATE UNIQUE INDEX "IosDevice_appleDeviceId_key" ON "IosDevice"("appleDeviceId");
CREATE INDEX "IosDevice_status_createdAt_idx" ON "IosDevice"("status", "createdAt");
CREATE INDEX "IosDevice_lastSeenAt_idx" ON "IosDevice"("lastSeenAt");
CREATE UNIQUE INDEX "IosDeviceEnrollment_tokenHash_key" ON "IosDeviceEnrollment"("tokenHash");
CREATE INDEX "IosDeviceEnrollment_deviceId_createdAt_idx" ON "IosDeviceEnrollment"("deviceId", "createdAt");
CREATE INDEX "IosDeviceEnrollment_status_expiresAt_idx" ON "IosDeviceEnrollment"("status", "expiresAt");
CREATE UNIQUE INDEX "IosDeviceIpObservation_enrollmentId_source_ipAddress_key" ON "IosDeviceIpObservation"("enrollmentId", "source", "ipAddress");
CREATE INDEX "IosDeviceIpObservation_deviceId_observedAt_idx" ON "IosDeviceIpObservation"("deviceId", "observedAt");
CREATE INDEX "IosDeviceIpObservation_enrollmentId_observedAt_idx" ON "IosDeviceIpObservation"("enrollmentId", "observedAt");
