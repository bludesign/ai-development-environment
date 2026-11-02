ALTER TABLE "BuildDeployment" ADD COLUMN "launchedAt" DATETIME;
ALTER TABLE "JiraProject" ADD COLUMN "defaultResolutionId" TEXT;
ALTER TABLE "TelemetryViewSettings" ADD COLUMN "showBuildRunSeparators" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TelemetryEntry" ADD COLUMN "separatorKey" TEXT;

-- Keep historical creation boundaries distinct from future, repeatable run boundaries.
UPDATE "TelemetryEntry"
SET "separatorKind" = 'BUILD_CREATED',
    "separatorKey" = 'build-created:' || COALESCE("buildId", "id")
WHERE "entryType" = 'SEPARATOR' AND "separatorKind" = 'BUILD';

DROP INDEX "TelemetryEntry_separatorKind_buildId_key";
CREATE UNIQUE INDEX "TelemetryEntry_separatorKey_key" ON "TelemetryEntry"("separatorKey");
