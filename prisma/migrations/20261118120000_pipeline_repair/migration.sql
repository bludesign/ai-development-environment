ALTER TABLE "Workflow" ADD COLUMN "maxPipelineRepairRetries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WorktreeAutoSync" ADD COLUMN "pipelineWorkflowId" TEXT;
ALTER TABLE "WorktreeAutoSync" ADD COLUMN "pipelineWorkflowChoice" TEXT;
ALTER TABLE "WorktreeAutoSync" ADD COLUMN "pipelineRepairJson" TEXT;
