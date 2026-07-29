ALTER TABLE "Workflow" ADD COLUMN "exclusiveWorktree" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "WorkflowRun" ADD COLUMN "worktreeId" TEXT;
ALTER TABLE "WorkflowRun" ADD COLUMN "worktreeLeaseOwnerRunId" TEXT;
ALTER TABLE "WorkflowRun" ADD COLUMN "exclusiveWorktree" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AgentRun" ADD COLUMN "workflowRunId" TEXT;

CREATE TABLE "WorktreeAdmissionLane" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorktreeAdmissionLane_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorktreeWorkflowLease" (
    "worktreeId" TEXT NOT NULL PRIMARY KEY,
    "workflowRunId" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorktreeWorkflowLease_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "Worktree" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeWorkflowLease_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "WorkflowRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorktreeWorkflowLease_workflowRunId_key" ON "WorktreeWorkflowLease"("workflowRunId");
CREATE INDEX "AgentRun_workflowRunId_createdAt_idx" ON "AgentRun"("workflowRunId", "createdAt");
CREATE INDEX "WorkflowRun_worktreeId_status_queuedAt_idx" ON "WorkflowRun"("worktreeId", "status", "queuedAt");
CREATE INDEX "WorkflowRun_worktreeLeaseOwnerRunId_idx" ON "WorkflowRun"("worktreeLeaseOwnerRunId");

UPDATE "WorkflowRun"
SET "worktreeId" = json_extract("sessionDataJson", '$.worktree.id')
WHERE json_valid("sessionDataJson")
  AND json_type("sessionDataJson", '$.worktree.id') = 'text'
  AND EXISTS (
    SELECT 1
    FROM "Worktree"
    WHERE "Worktree"."id" = json_extract("WorkflowRun"."sessionDataJson", '$.worktree.id')
  );

-- Existing workflows keep their previous non-exclusive behavior. New runs
-- snapshot the workflow setting and lease owner when they are created.
