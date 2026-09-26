ALTER TABLE "BuildScript" ADD COLUMN "iconKey" TEXT;
CREATE INDEX "Build_configurationId_createdAt_idx" ON "Build"("configurationId", "createdAt");
