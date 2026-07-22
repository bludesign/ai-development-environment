ALTER TABLE "Agent" ADD COLUMN "codebaseScanIntervalSeconds" INTEGER;
ALTER TABLE "Agent" ADD COLUMN "jobReconciliationIntervalSeconds" INTEGER;
ALTER TABLE "Agent" ADD COLUMN "gitFetchIntervalSeconds" INTEGER;
ALTER TABLE "Agent" ADD COLUMN "heartbeatIntervalSeconds" INTEGER;
