CREATE TABLE "TailscaleServeTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "listenPort" INTEGER NOT NULL,
    "mountPath" TEXT NOT NULL DEFAULT '/',
    "destinationProtocol" TEXT NOT NULL,
    "destinationPort" INTEGER NOT NULL,
    "destinationPath" TEXT NOT NULL DEFAULT '',
    "funnel" BOOLEAN NOT NULL DEFAULT false,
    "appCapabilitiesJson" TEXT NOT NULL DEFAULT '[]',
    "proxyProtocol" TEXT NOT NULL DEFAULT 'NONE',
    "fingerprint" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lifecycle" TEXT NOT NULL DEFAULT 'ACTIVE',
    "origin" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "TailscaleServeAssignment" (
    "templateId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "desiredEnabled" BOOLEAN NOT NULL DEFAULT true,
    "observedEnabled" BOOLEAN NOT NULL DEFAULT false,
    "observedFingerprint" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "lastJobId" TEXT,
    "lastError" TEXT,
    "lastObservedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("templateId", "agentId"),
    CONSTRAINT "TailscaleServeAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TailscaleServeTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TailscaleServeAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TailscaleAgentState" (
    "agentId" TEXT NOT NULL PRIMARY KEY,
    "dnsHostname" TEXT,
    "ipv4Json" TEXT NOT NULL DEFAULT '[]',
    "ipv6Json" TEXT NOT NULL DEFAULT '[]',
    "backendState" TEXT NOT NULL DEFAULT 'Unknown',
    "routesJson" TEXT NOT NULL DEFAULT '[]',
    "lastInspectedAt" DATETIME,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TailscaleAgentState_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TailscaleServeOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUING',
    "requestId" TEXT NOT NULL,
    "templateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TailscaleServeOperation_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TailscaleServeTemplate" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "TailscaleServeOperationAgent" (
    "operationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUING',
    "jobId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("operationId", "agentId"),
    CONSTRAINT "TailscaleServeOperationAgent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "TailscaleServeOperation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TailscaleServeOperationAgent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TailscaleServeOperationAgent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TailscaleServeTemplate_fingerprint_key" ON "TailscaleServeTemplate"("fingerprint");
CREATE INDEX "TailscaleServeTemplate_lifecycle_createdAt_idx" ON "TailscaleServeTemplate"("lifecycle", "createdAt");
CREATE INDEX "TailscaleServeTemplate_protocol_listenPort_mountPath_idx" ON "TailscaleServeTemplate"("protocol", "listenPort", "mountPath");
CREATE INDEX "TailscaleServeAssignment_agentId_status_idx" ON "TailscaleServeAssignment"("agentId", "status");
CREATE INDEX "TailscaleServeAssignment_lastJobId_idx" ON "TailscaleServeAssignment"("lastJobId");
CREATE UNIQUE INDEX "TailscaleServeOperation_requestId_key" ON "TailscaleServeOperation"("requestId");
CREATE INDEX "TailscaleServeOperation_templateId_createdAt_idx" ON "TailscaleServeOperation"("templateId", "createdAt");
CREATE INDEX "TailscaleServeOperation_status_createdAt_idx" ON "TailscaleServeOperation"("status", "createdAt");
CREATE UNIQUE INDEX "TailscaleServeOperationAgent_jobId_key" ON "TailscaleServeOperationAgent"("jobId");
CREATE INDEX "TailscaleServeOperationAgent_agentId_status_idx" ON "TailscaleServeOperationAgent"("agentId", "status");
