ALTER TABLE "Workflow"
ADD COLUMN "worktreeConcurrency" TEXT NOT NULL DEFAULT 'NON_EXCLUSIVE';

ALTER TABLE "Workflow"
ADD COLUMN "blocksGitOperations" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "WorkflowRun"
ADD COLUMN "worktreeConcurrency" TEXT NOT NULL DEFAULT 'NON_EXCLUSIVE';

ALTER TABLE "WorkflowRun"
ADD COLUMN "blocksGitOperations" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the old reservation semantics. Workflows that did not reserve a
-- worktree adopt the shared mode; excluded is intentionally opt-in.
UPDATE "Workflow"
SET
  "worktreeConcurrency" = CASE
    WHEN "exclusiveWorktree" = true THEN 'EXCLUSIVE'
    ELSE 'NON_EXCLUSIVE'
  END,
  "blocksGitOperations" = CASE
    WHEN "exclusiveWorktree" = true THEN true
    ELSE false
  END;

-- Runs keep an immutable copy so editing a workflow cannot change the queue
-- semantics of work that is already in flight.
UPDATE "WorkflowRun"
SET
  "worktreeConcurrency" = CASE
    WHEN "exclusiveWorktree" = true THEN 'EXCLUSIVE'
    ELSE 'NON_EXCLUSIVE'
  END,
  "blocksGitOperations" = CASE
    WHEN "exclusiveWorktree" = true THEN true
    ELSE false
  END;

-- Workflow terminal steps follow the workflow's Git-blocking snapshot just as
-- command jobs follow the command snapshot. Dedicated Git/worktree job kinds
-- remain in the partial unique index and always serialize.
DROP INDEX IF EXISTS "AgentJob_codebaseId_active_key";

CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
ON "AgentJob"("codebaseId")
WHERE "codebaseId" IS NOT NULL
  AND "status" IN ('QUEUED', 'RUNNING')
  AND "kind" NOT LIKE 'ios.%'
  AND "kind" NOT IN ('command.run', 'workflow.terminal.run');

DROP TRIGGER IF EXISTS "AgentJob_codebase_command_guard_insert";
DROP TRIGGER IF EXISTS "AgentJob_codebase_command_guard_update";

CREATE TRIGGER "AgentJob_codebase_command_guard_insert"
BEFORE INSERT ON "AgentJob"
WHEN NEW."codebaseId" IS NOT NULL
  AND NEW."status" IN ('QUEUED', 'RUNNING')
  AND NEW."kind" NOT LIKE 'ios.%'
  AND EXISTS (
    SELECT 1
    FROM "AgentJob" AS "active"
    WHERE "active"."codebaseId" = NEW."codebaseId"
      AND "active"."status" IN ('QUEUED', 'RUNNING')
      AND "active"."kind" NOT LIKE 'ios.%'
      AND (
        (
          NEW."kind" IN ('command.run', 'workflow.terminal.run')
          AND NEW."blocksGitOperations" = true
          AND "active"."kind" NOT IN ('command.run', 'workflow.terminal.run')
        )
        OR
        (
          NEW."kind" NOT IN ('command.run', 'workflow.terminal.run')
          AND "active"."kind" IN ('command.run', 'workflow.terminal.run')
          AND "active"."blocksGitOperations" = true
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'AgentJob_codebaseId_active_key');
END;

CREATE TRIGGER "AgentJob_codebase_command_guard_update"
BEFORE UPDATE OF "codebaseId", "kind", "status", "blocksGitOperations" ON "AgentJob"
WHEN NEW."codebaseId" IS NOT NULL
  AND NEW."status" IN ('QUEUED', 'RUNNING')
  AND NEW."kind" NOT LIKE 'ios.%'
  AND EXISTS (
    SELECT 1
    FROM "AgentJob" AS "active"
    WHERE "active"."id" <> NEW."id"
      AND "active"."codebaseId" = NEW."codebaseId"
      AND "active"."status" IN ('QUEUED', 'RUNNING')
      AND "active"."kind" NOT LIKE 'ios.%'
      AND (
        (
          NEW."kind" IN ('command.run', 'workflow.terminal.run')
          AND NEW."blocksGitOperations" = true
          AND "active"."kind" NOT IN ('command.run', 'workflow.terminal.run')
        )
        OR
        (
          NEW."kind" NOT IN ('command.run', 'workflow.terminal.run')
          AND "active"."kind" IN ('command.run', 'workflow.terminal.run')
          AND "active"."blocksGitOperations" = true
        )
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'AgentJob_codebaseId_active_key');
END;
