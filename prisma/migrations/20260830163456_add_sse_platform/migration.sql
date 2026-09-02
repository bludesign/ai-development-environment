-- CreateTable
CREATE TABLE "SseEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT 'FORWARD',
    "forwardUrl" TEXT NOT NULL,
    "requestScript" TEXT NOT NULL DEFAULT '',
    "responseScript" TEXT NOT NULL DEFAULT '',
    "activeMockCompositionId" TEXT,
    "deliveryBufferMode" TEXT NOT NULL DEFAULT 'STANDARD',
    "historyBufferMode" TEXT NOT NULL DEFAULT 'CONCATENATE',
    "breakpointTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "heartbeatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "heartbeatIntervalMs" INTEGER NOT NULL DEFAULT 15000,
    "mockCompletion" TEXT NOT NULL DEFAULT 'CLOSE',
    "requestScriptTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "mockScriptTimeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "responseScriptTimeoutMs" INTEGER NOT NULL DEFAULT 5000,
    "scriptMemoryLimitMb" INTEGER NOT NULL DEFAULT 32,
    "fetchTimeoutMs" INTEGER NOT NULL DEFAULT 15000,
    "requestBodyLimitBytes" INTEGER NOT NULL DEFAULT 2097152,
    "eventDataLimitBytes" INTEGER NOT NULL DEFAULT 524288,
    "streamHistoryLimitBytes" INTEGER NOT NULL DEFAULT 52428800,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "retentionEventLimit" INTEGER NOT NULL DEFAULT 100000,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SseEndpoint_activeMockCompositionId_fkey" FOREIGN KEY ("activeMockCompositionId") REFERENCES "SseMockComposition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseMockEventTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventName" TEXT,
    "data" TEXT NOT NULL,
    "eventId" TEXT,
    "retryMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SseMockEventTemplate_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "SseEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseMockComposition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 200,
    "headersJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SseMockComposition_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "SseEndpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseMockBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "compositionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "templateId" TEXT,
    "delayMs" INTEGER,
    "script" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SseMockBlock_compositionId_fkey" FOREIGN KEY ("compositionId") REFERENCES "SseMockComposition" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SseMockBlock_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SseMockEventTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseScriptStorageEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "valueJson" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SseRequestHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT,
    "endpointName" TEXT NOT NULL,
    "endpointToken" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "method" TEXT NOT NULL,
    "requestUrl" TEXT NOT NULL,
    "requestHeadersJson" TEXT NOT NULL,
    "requestBody" TEXT,
    "effectiveUrl" TEXT,
    "effectiveMethod" TEXT,
    "effectiveHeadersJson" TEXT,
    "effectiveBody" TEXT,
    "upstreamStatus" INTEGER,
    "upstreamHeadersJson" TEXT,
    "responseStatus" INTEGER,
    "responseHeadersJson" TEXT,
    "breakpointResolution" TEXT,
    "outcome" TEXT,
    "error" TEXT,
    "configSnapshotJson" TEXT NOT NULL,
    "storedBytes" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstEventAt" DATETIME,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    CONSTRAINT "SseRequestHistory_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "SseEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseHistoryEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "logicalIndex" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "eventId" TEXT,
    "retryMs" INTEGER,
    "dropped" BOOLEAN NOT NULL DEFAULT false,
    "split" BOOLEAN NOT NULL DEFAULT false,
    "fanOutIndex" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SseHistoryEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SseRequestHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseBreakpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "endpointId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "resolution" TEXT,
    "mockCompositionId" TEXT,
    "adHocCompositionJson" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SseBreakpoint_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SseRequestHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SseBreakpoint_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "SseEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SseBreakpoint_mockCompositionId_fkey" FOREIGN KEY ("mockCompositionId") REFERENCES "SseMockComposition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SseHistoryViewSettings" (
    "view" TEXT NOT NULL PRIMARY KEY,
    "columnsJson" TEXT NOT NULL,
    "timeFormat" TEXT NOT NULL DEFAULT 'TWELVE_HOUR',
    "activeColumnPresetId" TEXT,
    "activeSavedFilterId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SseHistoryColumnPreset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "view" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "columnsJson" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SseHistorySavedFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "view" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definitionJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SseEndpoint_token_key" ON "SseEndpoint"("token");

-- CreateIndex
CREATE INDEX "SseEndpoint_mode_updatedAt_idx" ON "SseEndpoint"("mode", "updatedAt");

-- CreateIndex
CREATE INDEX "SseMockEventTemplate_endpointId_updatedAt_idx" ON "SseMockEventTemplate"("endpointId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SseMockEventTemplate_endpointId_name_key" ON "SseMockEventTemplate"("endpointId", "name");

-- CreateIndex
CREATE INDEX "SseMockComposition_endpointId_updatedAt_idx" ON "SseMockComposition"("endpointId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SseMockComposition_endpointId_name_key" ON "SseMockComposition"("endpointId", "name");

-- CreateIndex
CREATE INDEX "SseMockBlock_templateId_idx" ON "SseMockBlock"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "SseMockBlock_compositionId_position_key" ON "SseMockBlock"("compositionId", "position");

-- CreateIndex
CREATE INDEX "SseScriptStorageEntry_updatedAt_idx" ON "SseScriptStorageEntry"("updatedAt");

-- CreateIndex
CREATE INDEX "SseRequestHistory_endpointId_startedAt_idx" ON "SseRequestHistory"("endpointId", "startedAt");

-- CreateIndex
CREATE INDEX "SseRequestHistory_status_startedAt_idx" ON "SseRequestHistory"("status", "startedAt");

-- CreateIndex
CREATE INDEX "SseRequestHistory_mode_startedAt_idx" ON "SseRequestHistory"("mode", "startedAt");

-- CreateIndex
CREATE INDEX "SseHistoryEvent_requestId_logicalIndex_stage_idx" ON "SseHistoryEvent"("requestId", "logicalIndex", "stage");

-- CreateIndex
CREATE INDEX "SseHistoryEvent_eventName_createdAt_idx" ON "SseHistoryEvent"("eventName", "createdAt");

-- CreateIndex
CREATE INDEX "SseHistoryEvent_eventId_idx" ON "SseHistoryEvent"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "SseHistoryEvent_requestId_sequence_key" ON "SseHistoryEvent"("requestId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "SseBreakpoint_requestId_key" ON "SseBreakpoint"("requestId");

-- CreateIndex
CREATE INDEX "SseBreakpoint_status_expiresAt_idx" ON "SseBreakpoint"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "SseBreakpoint_endpointId_createdAt_idx" ON "SseBreakpoint"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "SseHistoryColumnPreset_view_isDefault_idx" ON "SseHistoryColumnPreset"("view", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "SseHistoryColumnPreset_view_name_key" ON "SseHistoryColumnPreset"("view", "name");

-- CreateIndex
CREATE INDEX "SseHistorySavedFilter_view_updatedAt_idx" ON "SseHistorySavedFilter"("view", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SseHistorySavedFilter_view_name_key" ON "SseHistorySavedFilter"("view", "name");
