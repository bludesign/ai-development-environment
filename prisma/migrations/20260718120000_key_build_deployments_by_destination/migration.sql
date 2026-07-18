PRAGMA foreign_keys=OFF;

CREATE TABLE "new_BuildDeployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "jobId" TEXT,
    "destinationJson" TEXT NOT NULL,
    "destinationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "commandSummary" TEXT NOT NULL,
    "outputRelativePath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildDeployment_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BuildDeployment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AgentJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_BuildDeployment" (
    "id",
    "buildId",
    "batchId",
    "requestId",
    "jobId",
    "destinationJson",
    "destinationKey",
    "status",
    "commandSummary",
    "outputRelativePath",
    "error",
    "createdAt",
    "startedAt",
    "finishedAt",
    "updatedAt"
)
SELECT
    "id",
    "buildId",
    "batchId",
    "requestId",
    "jobId",
    "destinationJson",
    json_extract("destinationJson", '$.type') || ':' || json_extract("destinationJson", '$.id'),
    "status",
    "commandSummary",
    "outputRelativePath",
    "error",
    "createdAt",
    "startedAt",
    "finishedAt",
    "updatedAt"
FROM "BuildDeployment" AS "deployment"
WHERE "deployment".rowid = (
    SELECT MIN("candidate".rowid)
    FROM "BuildDeployment" AS "candidate"
    WHERE "candidate"."buildId" = "deployment"."buildId"
      AND "candidate"."requestId" = "deployment"."requestId"
      AND json_extract("candidate"."destinationJson", '$.type') = json_extract("deployment"."destinationJson", '$.type')
      AND json_extract("candidate"."destinationJson", '$.id') = json_extract("deployment"."destinationJson", '$.id')
);

DROP TABLE "BuildDeployment";
ALTER TABLE "new_BuildDeployment" RENAME TO "BuildDeployment";

CREATE INDEX "BuildDeployment_buildId_createdAt_idx" ON "BuildDeployment"("buildId", "createdAt");
CREATE INDEX "BuildDeployment_jobId_idx" ON "BuildDeployment"("jobId");
CREATE UNIQUE INDEX "BuildDeployment_buildId_requestId_destinationKey_key" ON "BuildDeployment"("buildId", "requestId", "destinationKey");

PRAGMA foreign_keys=ON;
