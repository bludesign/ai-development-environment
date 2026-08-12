-- CreateTable
CREATE TABLE "CcusageHistory" (
    "agentId" TEXT NOT NULL PRIMARY KEY,
    "agentName" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "archivedReportJson" TEXT NOT NULL,
    "lastLiveReportJson" TEXT NOT NULL,
    "lastObservedAt" DATETIME NOT NULL,
    "lastJobId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CcusageHistory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CcusageHistoryState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clearedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CcusageHistory_lastObservedAt_idx" ON "CcusageHistory"("lastObservedAt");
