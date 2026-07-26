CREATE TABLE "DiskSpaceSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "normalThresholdGiB" REAL NOT NULL DEFAULT 40,
  "pressureThresholdGiB" REAL NOT NULL DEFAULT 10,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

INSERT INTO "DiskSpaceSettings" (
  "id", "normalThresholdGiB", "pressureThresholdGiB", "createdAt", "updatedAt"
) VALUES ('default', 40, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

CREATE TABLE "AgentDiskSpaceState" (
  "agentId" TEXT NOT NULL PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "manualPressureMode" BOOLEAN NOT NULL DEFAULT false,
  "automaticPressureMode" BOOLEAN NOT NULL DEFAULT false,
  "volumesJson" TEXT NOT NULL DEFAULT '[]',
  "entriesJson" TEXT NOT NULL DEFAULT '[]',
  "warningsJson" TEXT NOT NULL DEFAULT '[]',
  "lastReportedAt" DATETIME,
  "lastError" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AgentDiskSpaceState_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DerivedDataLock" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DerivedDataLock_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "DerivedDataCleanupLease" (
  "worktreeId" TEXT NOT NULL PRIMARY KEY,
  "agentId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "jobId" TEXT,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DerivedDataCleanupLease_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DerivedDataCleanupLease_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SidebarUsageSummary" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "period" TEXT NOT NULL,
  "totalCost" REAL NOT NULL,
  "collectedAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "AgentDiskSpaceState_enabled_lastReportedAt_idx" ON "AgentDiskSpaceState"("enabled", "lastReportedAt");
CREATE UNIQUE INDEX "DerivedDataLock_agentId_path_key" ON "DerivedDataLock"("agentId", "path");
CREATE INDEX "DerivedDataLock_agentId_createdAt_idx" ON "DerivedDataLock"("agentId", "createdAt");
CREATE INDEX "DerivedDataCleanupLease_agentId_expiresAt_idx" ON "DerivedDataCleanupLease"("agentId", "expiresAt");
CREATE INDEX "DerivedDataCleanupLease_jobId_idx" ON "DerivedDataCleanupLease"("jobId");
