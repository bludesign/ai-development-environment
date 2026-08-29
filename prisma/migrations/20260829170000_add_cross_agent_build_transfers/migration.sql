ALTER TABLE "BuildDeployment" ADD COLUMN "targetAgentId" TEXT REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BuildDeployment" ADD COLUMN "transferId" TEXT REFERENCES "BuildArtifactTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "BuildArtifactTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artifactId" TEXT NOT NULL,
    "targetAgentId" TEXT NOT NULL,
    "sourceAgentId" TEXT,
    "sourceJobId" TEXT,
    "targetJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "uploadOffset" REAL NOT NULL DEFAULT 0,
    "uploadLength" REAL,
    "downloadOffset" REAL NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "filename" TEXT,
    "contentType" TEXT,
    "stagingPath" TEXT,
    "error" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "BuildArtifactTransfer_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "BuildArtifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildArtifactTransfer_sourceAgentId_fkey" FOREIGN KEY ("sourceAgentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BuildArtifactTransfer_targetAgentId_fkey" FOREIGN KEY ("targetAgentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildArtifactTransfer_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BuildArtifactTransfer_targetJobId_fkey" FOREIGN KEY ("targetJobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

UPDATE "BuildDeployment"
SET "targetAgentId" = COALESCE(
    (SELECT "agentId" FROM "AgentJob" WHERE "AgentJob"."id" = "BuildDeployment"."jobId"),
    (SELECT "agentId" FROM "Build" WHERE "Build"."id" = "BuildDeployment"."buildId")
);

DROP INDEX "BuildDeployment_buildId_requestId_destinationKey_key";
CREATE UNIQUE INDEX "BuildDeployment_buildId_requestId_targetAgentId_destinationKey_key" ON "BuildDeployment"("buildId", "requestId", "targetAgentId", "destinationKey");
CREATE INDEX "BuildDeployment_targetAgentId_createdAt_idx" ON "BuildDeployment"("targetAgentId", "createdAt");
CREATE INDEX "BuildDeployment_transferId_idx" ON "BuildDeployment"("transferId");
CREATE INDEX "BuildArtifactTransfer_artifactId_targetAgentId_createdAt_idx" ON "BuildArtifactTransfer"("artifactId", "targetAgentId", "createdAt");
CREATE INDEX "BuildArtifactTransfer_sourceAgentId_status_idx" ON "BuildArtifactTransfer"("sourceAgentId", "status");
CREATE INDEX "BuildArtifactTransfer_targetAgentId_status_idx" ON "BuildArtifactTransfer"("targetAgentId", "status");
CREATE INDEX "BuildArtifactTransfer_sourceJobId_idx" ON "BuildArtifactTransfer"("sourceJobId");
CREATE INDEX "BuildArtifactTransfer_targetJobId_idx" ON "BuildArtifactTransfer"("targetJobId");
CREATE INDEX "BuildArtifactTransfer_status_expiresAt_idx" ON "BuildArtifactTransfer"("status", "expiresAt");
