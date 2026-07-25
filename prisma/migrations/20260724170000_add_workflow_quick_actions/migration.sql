ALTER TABLE "Workflow" ADD COLUMN "globalQuickAction" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workflow" ADD COLUMN "quickActionIconKey" TEXT NOT NULL DEFAULT 'play';
ALTER TABLE "Workflow" ADD COLUMN "quickActionButtonVariant" TEXT NOT NULL DEFAULT 'default';

CREATE TABLE "WorkflowQuickActionRepository" (
    "workflowId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowQuickActionRepository_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkflowQuickActionRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "CodebaseRepository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("workflowId", "repositoryId")
);

CREATE INDEX "WorkflowQuickActionRepository_repositoryId_workflowId_idx"
ON "WorkflowQuickActionRepository"("repositoryId", "workflowId");
