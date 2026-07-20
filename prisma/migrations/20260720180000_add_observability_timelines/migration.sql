CREATE TABLE "TelemetryEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryType" TEXT NOT NULL,
    "clientTime" DATETIME NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceIp" TEXT,
    "message" TEXT,
    "level" TEXT,
    "category" TEXT,
    "eventName" TEXT,
    "eventKind" TEXT,
    "screenName" TEXT,
    "buildId" TEXT,
    "sessionId" TEXT,
    "attributesJson" TEXT NOT NULL DEFAULT '{}',
    "defaultParametersJson" TEXT NOT NULL DEFAULT '{}',
    "additionalParametersJson" TEXT NOT NULL DEFAULT '{}',
    "searchText" TEXT NOT NULL DEFAULT '',
    "highlightColor" TEXT,
    "separatorKind" TEXT,
    "separatorName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "TelemetryEntry_separatorKind_buildId_key" ON "TelemetryEntry"("separatorKind", "buildId");
CREATE INDEX "TelemetryEntry_entryType_clientTime_receivedAt_idx" ON "TelemetryEntry"("entryType", "clientTime", "receivedAt");
CREATE INDEX "TelemetryEntry_clientTime_receivedAt_idx" ON "TelemetryEntry"("clientTime", "receivedAt");
CREATE INDEX "TelemetryEntry_level_idx" ON "TelemetryEntry"("level");
CREATE INDEX "TelemetryEntry_category_idx" ON "TelemetryEntry"("category");
CREATE INDEX "TelemetryEntry_eventKind_idx" ON "TelemetryEntry"("eventKind");
CREATE INDEX "TelemetryEntry_eventName_idx" ON "TelemetryEntry"("eventName");
CREATE INDEX "TelemetryEntry_deviceIp_idx" ON "TelemetryEntry"("deviceIp");
CREATE INDEX "TelemetryEntry_buildId_idx" ON "TelemetryEntry"("buildId");
CREATE INDEX "TelemetryEntry_sessionId_idx" ON "TelemetryEntry"("sessionId");

CREATE TABLE "TelemetrySettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "localBaseUrlOverride" TEXT,
    "remoteBaseUrlOverride" TEXT,
    "consoleCollectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "analyticsCollectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "TelemetryViewSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "view" TEXT NOT NULL,
    "columnsJson" TEXT NOT NULL,
    "timeFormat" TEXT NOT NULL DEFAULT '12',
    "activeColumnPresetId" TEXT,
    "activeSavedFilterId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "TelemetryViewSettings_view_key" ON "TelemetryViewSettings"("view");

CREATE TABLE "TelemetryColumnPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "view" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "columnsJson" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "TelemetryColumnPreset_view_normalizedName_key" ON "TelemetryColumnPreset"("view", "normalizedName");
CREATE INDEX "TelemetryColumnPreset_view_isDefault_name_idx" ON "TelemetryColumnPreset"("view", "isDefault", "name");

CREATE TABLE "TelemetrySavedFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "view" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "definitionJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "TelemetrySavedFilter_view_normalizedName_key" ON "TelemetrySavedFilter"("view", "normalizedName");
CREATE INDEX "TelemetrySavedFilter_view_name_idx" ON "TelemetrySavedFilter"("view", "name");
