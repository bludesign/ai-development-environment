-- CreateTable
CREATE TABLE "ModelCostSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "catalogUrl" TEXT,
    "fetchedAt" DATETIME,
    "sourceUrl" TEXT,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModelCostEntry" (
    "model" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT,
    "mode" TEXT,
    "inputCostPerToken" REAL,
    "outputCostPerToken" REAL,
    "cacheReadCostPerToken" REAL,
    "cacheWriteCostPerToken" REAL,
    "maxInputTokens" INTEGER,
    "maxOutputTokens" INTEGER,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ModelCostEntry_provider_idx" ON "ModelCostEntry"("provider");
