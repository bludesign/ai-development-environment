-- CreateTable
CREATE TABLE "BuildReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "artifactId" TEXT,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "summaryJson" TEXT NOT NULL DEFAULT '{}',
    "dataJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "BuildReport_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildReport_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "BuildArtifact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "BuildReport_artifactId_key" ON "BuildReport"("artifactId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildReport_buildId_kind_key" ON "BuildReport"("buildId", "kind");

-- CreateIndex
CREATE INDEX "BuildReport_kind_status_createdAt_idx" ON "BuildReport"("kind", "status", "createdAt");

-- CreateIndex
CREATE INDEX "BuildReport_buildId_createdAt_idx" ON "BuildReport"("buildId", "createdAt");
