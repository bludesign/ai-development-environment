ALTER TABLE "CommandDefinition" ADD COLUMN "port" INTEGER;
ALTER TABLE "CommandRun" ADD COLUMN "snapshotPort" INTEGER;
ALTER TABLE "CommandRun" ADD COLUMN "portBlockerRunIdsJson" TEXT NOT NULL DEFAULT '[]';

CREATE INDEX "CommandRun_agentId_snapshotPort_status_idx"
ON "CommandRun"("agentId", "snapshotPort", "status");
