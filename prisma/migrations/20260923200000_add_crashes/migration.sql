-- CreateTable
CREATE TABLE "CrashReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "format" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "apiKeyId" TEXT,
    "apiKeyName" TEXT,
    "clientIp" TEXT,
    "filename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "payloadIndex" INTEGER NOT NULL DEFAULT 0,
    "sizeBytes" REAL NOT NULL,
    "incidentId" TEXT,
    "appName" TEXT,
    "bundleId" TEXT,
    "appVersion" TEXT,
    "buildVersion" TEXT,
    "osVersion" TEXT,
    "deviceModel" TEXT,
    "arch" TEXT,
    "exceptionType" TEXT,
    "exceptionCodes" TEXT,
    "signal" TEXT,
    "terminationReason" TEXT,
    "crashedThread" INTEGER,
    "crashedAt" DATETIME,
    "signature" TEXT NOT NULL,
    "signatureTitle" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "statusMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "agentId" TEXT,
    "symbolicatedAt" DATETIME,
    "normalizedJson" TEXT NOT NULL,
    "symbolicationJson" TEXT NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CrashBinaryImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "crashId" TEXT NOT NULL,
    "imageIndex" INTEGER NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "arch" TEXT,
    "loadAddress" TEXT,
    "path" TEXT,
    "frameCount" INTEGER NOT NULL DEFAULT 0,
    "dsymId" TEXT,
    CONSTRAINT "CrashBinaryImage_crashId_fkey" FOREIGN KEY ("crashId") REFERENCES "CrashReport" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CrashBinaryImage_dsymId_fkey" FOREIGN KEY ("dsymId") REFERENCES "Dsym" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DsymUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filename" TEXT NOT NULL,
    "sha256" TEXT,
    "sizeBytes" REAL NOT NULL,
    "uploadOffset" REAL NOT NULL DEFAULT 0,
    "stagingPath" TEXT,
    "storageDirectory" TEXT,
    "source" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "ownerKey" TEXT,
    "apiKeyId" TEXT,
    "buildId" TEXT,
    "linkedBuildId" TEXT,
    "buildArtifactId" TEXT,
    "url" TEXT,
    "projectName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DsymUpload_linkedBuildId_fkey" FOREIGN KEY ("linkedBuildId") REFERENCES "Build" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DsymUpload_buildArtifactId_fkey" FOREIGN KEY ("buildArtifactId") REFERENCES "BuildArtifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Dsym" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uploadId" TEXT NOT NULL,
    "bundleName" TEXT NOT NULL,
    "binaryName" TEXT NOT NULL,
    "bundleIdentifier" TEXT,
    "shortVersion" TEXT,
    "bundleVersion" TEXT,
    "dwarfPath" TEXT NOT NULL,
    "dwarfSha256" TEXT NOT NULL,
    "dwarfSizeBytes" REAL NOT NULL,
    "infoPlistPath" TEXT,
    "searchText" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Dsym_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "DsymUpload" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DsymSlice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dsymId" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "textVmAddr" TEXT NOT NULL,
    CONSTRAINT "DsymSlice_dsymId_fkey" FOREIGN KEY ("dsymId") REFERENCES "Dsym" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CrashSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "collectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "symbolicationAgentId" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "dsymRetentionDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CrashSettings_symbolicationAgentId_fkey" FOREIGN KEY ("symbolicationAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CrashReport_createdAt_idx" ON "CrashReport"("createdAt");

-- CreateIndex
CREATE INDEX "CrashReport_signature_createdAt_idx" ON "CrashReport"("signature", "createdAt");

-- CreateIndex
CREATE INDEX "CrashReport_bundleId_appVersion_idx" ON "CrashReport"("bundleId", "appVersion");

-- CreateIndex
CREATE INDEX "CrashReport_status_updatedAt_idx" ON "CrashReport"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrashReport_sha256_payloadIndex_key" ON "CrashReport"("sha256", "payloadIndex");

-- CreateIndex
CREATE INDEX "CrashBinaryImage_uuid_idx" ON "CrashBinaryImage"("uuid");

-- CreateIndex
CREATE INDEX "CrashBinaryImage_dsymId_idx" ON "CrashBinaryImage"("dsymId");

-- CreateIndex
CREATE UNIQUE INDEX "CrashBinaryImage_crashId_imageIndex_key" ON "CrashBinaryImage"("crashId", "imageIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DsymUpload_buildArtifactId_key" ON "DsymUpload"("buildArtifactId");

-- CreateIndex
CREATE INDEX "DsymUpload_sha256_idx" ON "DsymUpload"("sha256");

-- CreateIndex
CREATE INDEX "DsymUpload_status_createdAt_idx" ON "DsymUpload"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DsymUpload_linkedBuildId_idx" ON "DsymUpload"("linkedBuildId");

-- CreateIndex
CREATE INDEX "DsymUpload_buildId_idx" ON "DsymUpload"("buildId");

-- CreateIndex
CREATE INDEX "DsymUpload_createdAt_idx" ON "DsymUpload"("createdAt");

-- CreateIndex
CREATE INDEX "Dsym_uploadId_idx" ON "Dsym"("uploadId");

-- CreateIndex
CREATE INDEX "Dsym_createdAt_idx" ON "Dsym"("createdAt");

-- CreateIndex
CREATE INDEX "DsymSlice_uuid_idx" ON "DsymSlice"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "DsymSlice_dsymId_uuid_key" ON "DsymSlice"("dsymId", "uuid");

-- CreateIndex
CREATE INDEX "CrashSettings_symbolicationAgentId_idx" ON "CrashSettings"("symbolicationAgentId");

