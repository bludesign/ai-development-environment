ALTER TABLE "AgentDiskSpaceState" ADD COLUMN "lastCleanupError" TEXT;

-- Earlier versions stored cleanup failures in the report error field.
UPDATE "AgentDiskSpaceState"
SET "lastCleanupError" = "lastError", "lastError" = NULL
WHERE "lastError" IS NOT NULL;
