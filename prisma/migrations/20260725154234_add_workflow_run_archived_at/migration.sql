-- AlterTable
ALTER TABLE "WorkflowRun" ADD COLUMN "archivedAt" DATETIME;

-- CreateIndex
CREATE INDEX "WorkflowRun_archivedAt_createdAt_idx" ON "WorkflowRun"("archivedAt", "createdAt");
