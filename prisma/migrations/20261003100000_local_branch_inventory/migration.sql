ALTER TABLE "Codebase" ADD COLUMN "localBranchInventoryJson" TEXT;
ALTER TABLE "Codebase" ADD COLUMN "localBranchInventoryError" TEXT;
ALTER TABLE "Codebase" ADD COLUMN "localBranchInventoryAttemptedAt" DATETIME;
