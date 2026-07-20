ALTER TABLE "IosDevice" ADD COLUMN "registrationClaimedAt" DATETIME;

UPDATE "IosDevice"
SET "registrationClaimedAt" = "updatedAt"
WHERE "status" = 'REGISTERING';
