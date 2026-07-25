ALTER TABLE "Workflow" ADD COLUMN "quickActionKind" TEXT NOT NULL DEFAULT 'NONE';

UPDATE "Workflow"
SET "quickActionKind" = CASE
  WHEN "globalQuickAction" = true OR EXISTS (
    SELECT 1
    FROM "WorkflowQuickActionRepository"
    WHERE "WorkflowQuickActionRepository"."workflowId" = "Workflow"."id"
  ) THEN 'STANDARD'
  ELSE 'NONE'
END;

-- A legacy global workflow applied to every repository even when redundant
-- repository rows existed. Empty scope is the new representation of that rule.
DELETE FROM "WorkflowQuickActionRepository"
WHERE "workflowId" IN (
  SELECT "id" FROM "Workflow" WHERE "globalQuickAction" = true
);

ALTER TABLE "Workflow" DROP COLUMN "globalQuickAction";

ALTER TABLE "Worktree" ADD COLUMN "rebaseInProgress" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Worktree" ADD COLUMN "hasConflicts" BOOLEAN NOT NULL DEFAULT false;
