-- Commands gain a concurrency mode that decides whether a run may share its
-- target with other runs. Existing commands keep the most permissive behaviour
-- so nothing that used to start now waits for a slot.
ALTER TABLE "CommandDefinition"
ADD COLUMN "concurrency" TEXT NOT NULL DEFAULT 'NON_EXCLUSIVE';

ALTER TABLE "CommandRun"
ADD COLUMN "snapshotConcurrency" TEXT NOT NULL DEFAULT 'NON_EXCLUSIVE';

-- Runs snapshot their definition, so historical runs adopt the mode their
-- command carries today rather than the column default.
UPDATE "CommandRun"
SET
    "snapshotConcurrency" = (
        SELECT "concurrency"
        FROM "CommandDefinition"
        WHERE "CommandDefinition"."id" = "CommandRun"."commandId"
    )
WHERE
    "commandId" IS NOT NULL;

-- Command runs are user scripts rather than repository mutations, and they are
-- long-lived: holding the single active-job slot per codebase meant a second
-- command anywhere in the codebase failed outright with a unique-constraint
-- error. Their concurrency is now decided by the command's own mode, enforced
-- in the commands service, so they leave the codebase guard to git and worktree
-- work.
DROP INDEX IF EXISTS "AgentJob_codebaseId_active_key";

CREATE UNIQUE INDEX "AgentJob_codebaseId_active_key"
ON "AgentJob"("codebaseId")
WHERE "codebaseId" IS NOT NULL
  AND "status" IN ('QUEUED', 'RUNNING')
  AND "kind" NOT LIKE 'ios.%'
  AND "kind" <> 'command.run';
