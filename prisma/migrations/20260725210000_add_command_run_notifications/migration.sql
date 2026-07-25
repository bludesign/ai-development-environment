ALTER TABLE "CommandDefinition" ADD COLUMN "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CommandRun" ADD COLUMN "snapshotNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;
